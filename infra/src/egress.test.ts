// Provider egress modes (design docs/tasks/11-28-external-providers §5, ADRs 0001 and 0003; P2): private (no internet
// path), firewall (router → Network Firewall → NAT → IGW, TLS SNI allowlist), nat-dns (router → NAT → IGW, Route 53
// Resolver DNS Firewall hostname allowlist) and bring-your-own (acknowledged, unfiltered).
import { readFileSync } from 'node:fs'
import { App, Tags, Validations, aws_ecr as ecr, aws_ecs as ecs, aws_lambda as lambda } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks } from 'cdk-nag'
import { hostAllowed, providerDnsHosts } from '@auto-router/pricing'
import { describe, expect, it } from 'vitest'
import { AWS_SERVICE_DOMAINS, DNS_FIREWALL_ASSOCIATION_PRIORITY, dnsFirewallRules, EGRESS_RULE_CAPACITY, egressRules, NAT_CIDRS, type DnsFirewallRule } from './egress.ts'
import { DEFAULT_POLICY_FILE, deployModels, MAX_EGRESS_HOSTS } from './models.ts'
import { resolveSettings, type Settings } from './settings.ts'
import { RouterStack } from './stack.ts'
import { testTempDir } from './test-outdir.ts'

type Res = Record<string, { Type: string; Properties?: Record<string, any>; DependsOn?: unknown }>
const ctx = (c: Record<string, string>) => ({ tryGetContext: (k: string) => c[k] })
// Account-shaped digits are built at run time so committed files never carry a 12-digit run.
const ACCOUNT = '0'.repeat(12)
const BASE = { region: 'ap-southeast-1', account: ACCOUNT, tags: '{"Owner":"test-owner"}' }
const ARN = `arn:aws:secretsmanager:ap-southeast-1:${ACCOUNT}:secret:llmar/provider-key-AbCdEf`

const model = (upstreamModel: string) => ({ upstreamModel, family: 'other', tier: 'standard', dialects: ['openai-chat'], contextWindow: 131072,
  price: { input: 1, output: 2, cacheRead: 0, cacheWrite: {} }, cache: { mode: 'none', minTokens: 0, ttls: [], defaultTtl: '5m' } })
const provider = (id: string, baseUrl: string) => ({ id, baseUrl, auth: { scheme: 'bearer', secret: { arn: ARN } }, models: [model('m1')] })
/** A public SaaS provider (twice, same host: one allowlist entry) and a private IP endpoint on 8000. */
const REGISTRY = {
  schemaVersion: 1, version: 'reg-egress',
  providers: [provider('saas', 'https://API.Provider.example/v1'), provider('saas2', 'https://api.provider.example:443/v2'),
    provider('other', 'https://inference.other.example'), provider('vllm', 'https://10.20.1.5:8000')],
}

function policyWith(ids: string[]): string {
  const p = JSON.parse(readFileSync(DEFAULT_POLICY_FILE, 'utf8'))
  for (const id of ids) p.pools['openai-chat'].models.push({ model: id, tier: 'standard' })
  return JSON.stringify(p)
}
const reader = (reg: unknown) => (p: string): string =>
  p === '/virtual/policy.json' ? policyWith(['saas/m1']) : p === '/virtual/providers.json' ? JSON.stringify(reg) : readFileSync(p, 'utf8')

const settingsOf = (c: Record<string, string>, providers = true): Settings =>
  ({ ...resolveSettings(ctx({ ...BASE, ...(providers ? { providersFile: '/virtual/providers.json' } : {}), ...c }), {}, DEFAULT_POLICY_FILE), ...(providers ? { policyFile: '/virtual/policy.json' } : {}) })
const models = (c: Record<string, string>, reg: unknown = REGISTRY) => deployModels(settingsOf(c), reader(reg))

/** `reg` null: a deploy without a providersFile. `tagged`: the deploy tags, as app.ts applies them. */
function build(c: Record<string, string>, reg: unknown = REGISTRY, nag = false, tagged = false) {
  const s = settingsOf(c, reg !== null)
  const m = deployModels(s, reader(reg))
  const app = new App({ outdir: testTempDir('infra-egress-test') })
  const stack = new RouterStack(app, 'llmar-router', { env: { account: s.account, region: s.region }, settings: s, models: m,
    image: ecs.ContainerImage.fromRegistry(`${s.account}.dkr.ecr.${s.region}.amazonaws.com/llmar-router:test`),
    lambdaCode: (sc, cmd) => lambda.DockerImageCode.fromEcr(ecr.Repository.fromRepositoryName(sc, `Repo${cmd.replace(/[^A-Za-z]/g, '')}`, 'llmar-catalog-test'), { cmd: [cmd] }) })
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app))
  if (tagged) for (const [k, v] of Object.entries(s.tags)) Tags.of(app).add(k, v)
  const t = Template.fromStack(stack).toJSON()
  return { app, models: m, resources: t.Resources as Res, outputs: (t.Outputs ?? {}) as Record<string, any> }
}
const ofType = (res: Res, t: string) => Object.entries(res).filter(([, r]) => r.Type === t)
const internetEgress = (res: Res) => ofType(res, 'AWS::EC2::SecurityGroup')
  .flatMap(([, r]) => (r.Properties?.SecurityGroupEgress ?? []) as { CidrIp?: string; FromPort?: number; ToPort?: number }[])
  .filter((e) => e.CidrIp === '0.0.0.0/0')
const routerSubnets = (res: Res) => ofType(res, 'AWS::EC2::Subnet').filter(([id]) => id.startsWith('VpcprivateSubnet'))
const routerRouteTables = (res: Res) => ofType(res, 'AWS::EC2::RouteTable').filter(([id]) => id.startsWith('VpcprivateSubnet')).map(([id]) => id)
const PRIVATE = { providerEgressMode: 'private', providerEgress: '10.20.0.0/16:8000,10.30.0.0/16' }
const FIREWALL = { providerEgressMode: 'firewall', providerEgressAzs: '2', providerEgress: '10.20.0.0/16:8000' }
const NAT_DNS = { providerEgressMode: 'nat-dns', providerEgressAzs: '2', providerEgress: '10.20.0.0/16:8000' }

describe('settings: providerEgressMode, providerEgressAzs, providerEgressAck', () => {
  const resolve = (c: Record<string, string>) => () => resolveSettings(ctx({ ...BASE, providersFile: '/x.json', ...c }), {}, DEFAULT_POLICY_FILE)
  it('parses each mode with its own flags', () => {
    expect(resolve({ providerEgressMode: 'private' })()).toMatchObject({ providerEgressMode: 'private' })
    expect(resolve({ providerEgressMode: 'firewall', providerEgressAzs: '1' })()).toMatchObject({ providerEgressMode: 'firewall', providerEgressAzs: 1 })
    expect(resolve({ providerEgressMode: 'bring-your-own', providerEgressAck: 'unfiltered' })()).toMatchObject({ providerEgressMode: 'bring-your-own' })
    expect(resolveSettings(ctx(BASE), {}, DEFAULT_POLICY_FILE).providerEgressMode).toBeUndefined()
  })
  it('refuses unknown modes, missing or stray flags, and public modes without a registry', () => {
    expect(resolve({ providerEgressMode: 'nat' })).toThrow(/providerEgressMode: private \| firewall \| nat-dns \| bring-your-own/)
    expect(resolve({ providerEgressMode: 'firewall' })).toThrow(/providerEgressAzs: 1 or 2 required/)
    expect(resolve({ providerEgressMode: 'firewall', providerEgressAzs: '3' })).toThrow(/providerEgressAzs: 1 or 2 required/)
    expect(resolve({ providerEgressMode: 'private', providerEgressAzs: '1' })).toThrow(/only with providerEgressMode=firewall/)
    expect(resolve({ providerEgressMode: 'bring-your-own' })).toThrow(/providerEgressAck=unfiltered/)
    expect(resolve({ providerEgressMode: 'bring-your-own', providerEgressAck: 'yes' })).toThrow(/providerEgressAck=unfiltered/)
    expect(resolve({ providerEgressMode: 'firewall', providerEgressAzs: '2', providerEgressAck: 'unfiltered' })).toThrow(/only with providerEgressMode=bring-your-own/)
    // ADR 0002: an egress mode without a providersFile reserves egress for console providers; firewall then needs hosts.
    const noFile = resolveSettings(ctx({ ...BASE, providerEgressMode: 'firewall', providerEgressAzs: '2' }), {}, DEFAULT_POLICY_FILE)
    expect(() => deployModels(noFile)).toThrow(/no hosts to allow \(set -c providerHosts/)
    const hosts = resolveSettings(ctx({ ...BASE, providerEgressMode: 'firewall', providerEgressAzs: '2', providerHosts: 'API.DeepSeek.com, *.openai.azure.com' }), {}, DEFAULT_POLICY_FILE)
    expect(hosts.providerHosts).toEqual(['*.openai.azure.com', 'api.deepseek.com'])
    const m = deployModels(hosts)
    expect(m.egressHosts).toEqual(['*.openai.azure.com', 'api.deepseek.com'])
    expect(m.boundary).toEqual({ mode: 'firewall', hosts: ['*.openai.azure.com', 'api.deepseek.com'], cidrs: [] })
    expect(resolve({ providerEgressMode: 'private', providerHosts: 'api.deepseek.com' })).toThrow(/providerHosts: only with providerEgressMode=firewall, nat-dns or bring-your-own/)
    expect(resolve({ providerEgressMode: 'firewall', providerEgressAzs: '1', providerHosts: '*' })).toThrow(/'\*' \(any host\) needs providerEgressMode=nat-dns or bring-your-own/)
    expect(resolve({ providerEgressMode: 'firewall', providerEgressAzs: '1', providerHosts: '*x.example.com' })).toThrow(/is not a hostname, \*\.<domain> pattern or \*/)
    expect(deployModels(resolveSettings(ctx(BASE), {}, DEFAULT_POLICY_FILE)).boundary).toEqual({ mode: 'none', hosts: [], cidrs: [] })
  })
})

describe('deployModels: endpoint checks per mode', () => {
  it('a registry without a mode fails synth, naming the four modes', () => {
    expect(() => models({})).toThrow(/set -c providerEgressMode=private .* firewall .* nat-dns .* bring-your-own/s)
  })
  it('private: every endpoint must be covered by a providerEgress rule', () => {
    expect(models(PRIVATE).egressHosts).toEqual([])
    expect(() => models({ providerEgressMode: 'private' })).toThrow(/no providerEgress CIDRs/)
    expect(() => models({ providerEgressMode: 'private', providerEgress: '10.30.0.0/16' })).toThrow(/'vllm' \(10\.20\.1\.5:8000\): no providerEgress rule covers this address and port/)
    expect(() => models({ providerEgressMode: 'private', providerEgress: '10.20.0.0/16:8000' })).toThrow(/'saas' \(api\.provider\.example:443\): no providerEgress rule opens port 443/)
  })
  it('firewall: the allowlist is exactly the https hostnames on 443 (lowercased, deduplicated, sorted); the rest must be private', () => {
    expect(models(FIREWALL).egressHosts).toEqual(['api.provider.example', 'inference.other.example'])
    expect(() => models({ ...FIREWALL, providerEgress: '10.30.0.0/16' })).toThrow(/'vllm' \(10\.20\.1\.5:8000\): no providerEgress rule covers/)
    const odd = { ...REGISTRY, providers: [...REGISTRY.providers, provider('alt', 'https://alt.example:8443')] }
    expect(() => models(FIREWALL, odd)).toThrow(/'alt' \(alt\.example:8443\): the egress firewall passes TLS on 443 only/)
    const onlyPrivate = { ...REGISTRY, providers: [provider('saas', 'https://10.20.1.5:8000')] }
    expect(() => models(FIREWALL, onlyPrivate)).toThrow(/no registry endpoint is a public https hostname on 443/)
    const many = { ...REGISTRY, providers: [REGISTRY.providers[0], ...Array.from({ length: MAX_EGRESS_HOSTS }, (_, i) => provider(`p${i}`, `https://h${i}.example`))] }
    expect(() => models(FIREWALL, many)).toThrow(new RegExp(`${MAX_EGRESS_HOSTS + 1} hosts, at most ${MAX_EGRESS_HOSTS}`))
  })
  it('bring-your-own: 443 only without providerEgress; with it, as private', () => {
    const byo = { providerEgressMode: 'bring-your-own', providerEgressAck: 'unfiltered' }
    expect(() => models(byo)).toThrow(/'vllm' \(10\.20\.1\.5:8000\): bring-your-own without providerEgress opens 443 only/)
    expect(models(byo, { ...REGISTRY, providers: REGISTRY.providers.slice(0, 3) }).egressHosts).toEqual([])
    expect(models({ ...byo, providerEgress: '10.40.0.0/16,10.20.0.0/16:8000' }).egressHosts).toEqual([])
  })
})

describe('egress rules (synth-level; verified against the Network Firewall docs only, not deployed)', () => {
  const rules = egressRules(['api.provider.example', 'inference.other.example'])
  it('passes exact SNI matches on 443 in established flows, then drops other ports, UDP and ICMP', () => {
    const lines = rules.split('\n')
    expect(lines.slice(0, 2)).toEqual([
      'pass tls $HOME_NET any -> $EXTERNAL_NET 443 (tls.sni; content:"api.provider.example"; nocase; startswith; endswith; msg:"provider api.provider.example"; flow:to_server, established; sid:1000001; rev:1;)',
      'pass tls $HOME_NET any -> $EXTERNAL_NET 443 (tls.sni; content:"inference.other.example"; nocase; startswith; endswith; msg:"provider inference.other.example"; flow:to_server, established; sid:1000002; rev:1;)',
    ])
    expect(lines.slice(2).map((l) => l.split(' (')[0])).toEqual(['drop tcp $HOME_NET any -> $EXTERNAL_NET !443', 'drop udp $HOME_NET any -> $EXTERNAL_NET any', 'drop icmp $HOME_NET any -> $EXTERNAL_NET any'])
  })
  it('the TCP handshake to 443 is never dropped by a rule (drop_established lets it through before the SNI is seen)', () => {
    // The only TCP drop is for ports other than 443; nothing drops tcp/ip/tls to 443 or to any port.
    expect(rules.split('\n').filter((l) => /^(drop|reject) tcp /.test(l)).map((l) => l.split(' (')[0])).toEqual(['drop tcp $HOME_NET any -> $EXTERNAL_NET !443'])
    expect(rules).not.toMatch(/^(drop|reject) (tcp|ip|tls) \$HOME_NET any -> \$EXTERNAL_NET (443|any) /m)
  })
  it('refuses a host that is not a lowercase DNS name (no rule injection)', () => {
    expect(() => egressRules(['x"; sid:1;'])).toThrow(/not a lowercase DNS name/)
    // A wildcard pattern matches by suffix with its leading dot: never the apex or a look-alike domain.
    const wild = egressRules(['*.openai.azure.com'])
    expect(wild).toContain('tls.sni; content:".openai.azure.com"; nocase; endswith;')
    expect(wild).not.toMatch(/content:"\.openai\.azure\.com"; nocase; startswith/)
    expect(() => egressRules(['*x.example.com'])).toThrow(/not a lowercase DNS name/)
  })
})

describe('router stack: providerEgressMode=firewall', () => {
  const two = build(FIREWALL)
  const r = two.resources
  const fwIds = ofType(r, 'AWS::NetworkFirewall::Firewall').map(([id]) => id).sort()

  it('passes cdk-nag AwsSolutions', () => {
    expect(() => build(FIREWALL, REGISTRY, true).app.synth()).not.toThrow()
  })
  it('two AZs: an IGW, a NAT gateway and a firewall per AZ in dedicated subnets; one policy, one rule group', () => {
    expect(ofType(r, 'AWS::EC2::InternetGateway')).toHaveLength(1)
    expect(ofType(r, 'AWS::EC2::NatGateway')).toHaveLength(2)
    expect(ofType(r, 'AWS::EC2::EIP')).toHaveLength(2)
    expect(fwIds).toHaveLength(2)
    expect(ofType(r, 'AWS::NetworkFirewall::FirewallPolicy')).toHaveLength(1)
    const subnets = ofType(r, 'AWS::EC2::Subnet').map(([, s]) => s.Properties)
    expect(subnets.map((s) => s?.CidrBlock).sort()).toEqual(['10.90.0.0/26', '10.90.0.128/28', '10.90.0.144/28', '10.90.0.192/28', '10.90.0.208/28', '10.90.0.64/26'])
    for (const s of subnets) expect(s?.MapPublicIpOnLaunch ?? false).toBe(false)
    expect(ofType(r, 'AWS::ECS::Service')[0]?.[1].Properties?.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp).toBe('DISABLED')
  })
  it('the rule group carries exactly the registry hostnames; strict order with drop_established + alert_established', () => {
    const [, rg] = ofType(r, 'AWS::NetworkFirewall::RuleGroup')[0]!
    expect(rg.Properties).toMatchObject({ Type: 'STATEFUL', Capacity: EGRESS_RULE_CAPACITY, RuleGroup: { StatefulRuleOptions: { RuleOrder: 'STRICT_ORDER' } } })
    expect(rg.Properties?.RuleGroup.RulesSource.RulesString).toBe(egressRules(['api.provider.example', 'inference.other.example']))
    const [, pol] = ofType(r, 'AWS::NetworkFirewall::FirewallPolicy')[0]!
    expect(pol.Properties?.FirewallPolicy).toMatchObject({
      StatelessDefaultActions: ['aws:forward_to_sfe'], StatelessFragmentDefaultActions: ['aws:forward_to_sfe'],
      StatefulEngineOptions: { RuleOrder: 'STRICT_ORDER' }, StatefulDefaultActions: ['aws:drop_established', 'aws:alert_established'],
    })
    expect(JSON.stringify(pol.Properties)).not.toContain('drop_strict')
  })
  it('alert logs of both firewalls go to one log group', () => {
    const lc = ofType(r, 'AWS::NetworkFirewall::LoggingConfiguration').map(([, x]) => x.Properties?.LoggingConfiguration.LogDestinationConfigs)
    expect(lc).toHaveLength(2)
    for (const c of lc) expect(c).toEqual([{ LogType: 'ALERT', LogDestinationType: 'CloudWatchLogs', LogDestination: { logGroup: { Ref: expect.stringMatching(/^ProviderEgressAlerts/) } } }])
    expect(ofType(r, 'AWS::Logs::LogGroup').some(([, g]) => g.Properties?.LogGroupName === '/llmar/egress-firewall')).toBe(true)
  })
  it('routes: router subnet → its AZ firewall endpoint → NAT → IGW, with the return route through the same endpoint', () => {
    const routes = ofType(r, 'AWS::EC2::Route').map(([, x]) => x.Properties!)
    const endpointOf = (route: Record<string, any>) => JSON.stringify(route.VpcEndpointId).match(/ProviderEgressFirewall(\d)/)?.[1]
    const rts = routerRouteTables(r)
    expect(rts).toHaveLength(2)
    rts.forEach((rt, j) => {
      const def = routes.filter((x) => x.RouteTableId?.Ref === rt && x.DestinationCidrBlock === '0.0.0.0/0')
      expect(def).toHaveLength(1)
      expect(endpointOf(def[0]!)).toBe(String(j))
    })
    for (const i of [0, 1]) {
      const fwRt = routes.filter((x) => String(x.RouteTableId?.Ref).startsWith(`ProviderEgressFirewallSubnet${i}Rt`))
      expect(fwRt).toEqual([expect.objectContaining({ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: { Ref: expect.stringMatching(new RegExp(`^ProviderEgressNat${i}`)) } })])
      const natRt = routes.filter((x) => String(x.RouteTableId?.Ref).startsWith(`ProviderEgressNatSubnet${i}Rt`))
      expect(natRt.find((x) => x.DestinationCidrBlock === '0.0.0.0/0')).toMatchObject({ GatewayId: { Ref: expect.stringMatching(/^ProviderEgressIgw/) } })
      const back = natRt.filter((x) => x.DestinationCidrBlock !== '0.0.0.0/0')
      expect(back).toHaveLength(1)
      expect(back[0]?.DestinationCidrBlock).toBe(i === 0 ? '10.90.0.0/26' : '10.90.0.64/26')
      expect(endpointOf(back[0]!)).toBe(String(i))
    }
  })
  it('router SG: 443 to the internet only in this mode, plus the private rules', () => {
    expect(internetEgress(r)).toEqual([expect.objectContaining({ FromPort: 443, ToPort: 443, IpProtocol: 'tcp' })])
    expect(internetEgress(build(PRIVATE).resources)).toEqual([])
  })
  it('one AZ: one NAT gateway and firewall, used by both router subnets', () => {
    const one = build({ ...FIREWALL, providerEgressAzs: '1' }).resources
    expect(ofType(one, 'AWS::EC2::NatGateway')).toHaveLength(1)
    expect(ofType(one, 'AWS::NetworkFirewall::Firewall')).toHaveLength(1)
    const routes = ofType(one, 'AWS::EC2::Route').map(([, x]) => x.Properties!)
    for (const rt of routerRouteTables(one)) {
      const def = routes.find((x) => x.RouteTableId?.Ref === rt && x.DestinationCidrBlock === '0.0.0.0/0')
      expect(JSON.stringify(def?.VpcEndpointId)).toContain('ProviderEgressFirewall0')
    }
    const back = routes.filter((x) => String(x.RouteTableId?.Ref).startsWith('ProviderEgressNatSubnet0Rt') && x.DestinationCidrBlock !== '0.0.0.0/0')
    expect(back.map((x) => x.DestinationCidrBlock).sort()).toEqual(['10.90.0.0/26', '10.90.0.64/26'])
  })
  it('leaves the router subnets, their route tables and every VPC endpoint (Bedrock, private DNS, S3 gateway routes) unchanged', () => {
    const priv = build(PRIVATE).resources
    const pick = (res: Res, types: string[]) => Object.fromEntries(Object.entries(res).filter(([, x]) => types.includes(x.Type)).map(([id, x]) => [id, x.Properties]))
    const kept = ['AWS::EC2::VPCEndpoint', 'AWS::EC2::VPC']
    expect(pick(r, kept)).toEqual(pick(priv, kept))
    expect(Object.fromEntries(routerSubnets(r))).toEqual(Object.fromEntries(routerSubnets(priv)))
    expect(routerRouteTables(r)).toEqual(routerRouteTables(priv))
    const bedrock = Object.values(pick(r, ['AWS::EC2::VPCEndpoint'])).find((p) => JSON.stringify(p?.ServiceName).includes('bedrock-runtime'))
    expect(bedrock).toMatchObject({ PrivateDnsEnabled: true, VpcEndpointType: 'Interface' })
    const s3 = Object.values(pick(r, ['AWS::EC2::VPCEndpoint'])).find((p) => p?.VpcEndpointType === 'Gateway' && JSON.stringify(p?.ServiceName).includes('s3'))
    expect(s3?.RouteTableIds.map((x: { Ref: string }) => x.Ref).sort()).toEqual(routerRouteTables(priv).sort())
    // The same holds against a deploy without any registry.
    const plain = build({}, null).resources
    const shipped = (res: Res) => Object.fromEntries(Object.entries(pick(res, ['AWS::EC2::VPCEndpoint'])).filter(([id]) => !id.startsWith('VpcSecretsManager')))
    expect(shipped(r)).toEqual(shipped(plain))
  })
})

describe('router stack: providerEgressMode=bring-your-own and private', () => {
  const byo = { providerEgressMode: 'bring-your-own', providerEgressAck: 'unfiltered' }
  const reg = { ...REGISTRY, providers: REGISTRY.providers.slice(0, 3) }
  it('bring-your-own: no IGW, NAT or firewall; 443 to the internet on the router SG; the route tables as an output; cdk-nag clean', () => {
    const b = build(byo, reg)
    for (const t of ['AWS::EC2::InternetGateway', 'AWS::EC2::NatGateway', 'AWS::NetworkFirewall::Firewall']) expect(ofType(b.resources, t)).toEqual([])
    expect(internetEgress(b.resources)).toEqual([expect.objectContaining({ FromPort: 443, ToPort: 443 })])
    expect(JSON.stringify(b.outputs.RouterRouteTableIds?.Value)).toContain(routerRouteTables(b.resources)[0])
    expect(() => build(byo, reg, true).app.synth()).not.toThrow()
  })
  it('bring-your-own with providerEgress: only those CIDRs', () => {
    expect(internetEgress(build({ ...byo, providerEgress: '10.40.0.0/16' }, reg).resources)).toEqual([])
  })
  it('private: still no internet path (no IGW, NAT, firewall, public IPs or 0.0.0.0/0 egress)', () => {
    const p = build(PRIVATE).resources
    for (const t of ['AWS::EC2::InternetGateway', 'AWS::EC2::NatGateway', 'AWS::EC2::EIP', 'AWS::NetworkFirewall::Firewall']) expect(ofType(p, t)).toEqual([])
    expect(internetEgress(p)).toEqual([])
    for (const [, s] of ofType(p, 'AWS::EC2::Subnet')) expect(s.Properties?.MapPublicIpOnLaunch ?? false).toBe(false)
  })
})

describe('settings and deployModels: providerEgressMode=nat-dns', () => {
  const resolve = (c: Record<string, string>) => () => resolveSettings(ctx({ ...BASE, providersFile: '/x.json', ...c }), {}, DEFAULT_POLICY_FILE)
  it('needs providerEgressAzs (1 | 2), takes providerHosts, refuses providerEgressAck', () => {
    expect(resolve({ providerEgressMode: 'nat-dns', providerEgressAzs: '1' })()).toMatchObject({ providerEgressMode: 'nat-dns', providerEgressAzs: 1 })
    expect(resolve({ providerEgressMode: 'nat-dns', providerEgressAzs: '2' })()).toMatchObject({ providerEgressAzs: 2 })
    expect(resolve({ providerEgressMode: 'nat-dns' })).toThrow(/providerEgressAzs: 1 or 2 required with providerEgressMode=nat-dns \(NAT gateways per AZ/)
    expect(resolve({ providerEgressMode: 'nat-dns', providerEgressAzs: '3' })).toThrow(/providerEgressAzs: 1 or 2 required/)
    expect(resolve({ providerEgressMode: 'nat-dns', providerEgressAzs: '1', providerEgressAck: 'unfiltered' })).toThrow(/providerEgressAck: only with providerEgressMode=bring-your-own/)
    expect(resolve({ providerEgressMode: 'nat-dns', providerEgressAzs: '1', providerHosts: 'API.DeepSeek.com' })().providerHosts).toEqual(['api.deepseek.com'])
  })
  it('providerHosts is a ceiling and may be `*` (any host) alone: nat-dns and bring-your-own, never firewall', () => {
    expect(resolve({ providerEgressMode: 'nat-dns', providerEgressAzs: '1', providerHosts: '*' })().providerHosts).toEqual(['*'])
    expect(resolve({ providerEgressMode: 'bring-your-own', providerEgressAck: 'unfiltered', providerHosts: '*' })().providerHosts).toEqual(['*'])
    expect(resolve({ providerEgressMode: 'nat-dns', providerEgressAzs: '1', providerHosts: '*,api.deepseek.com' })).toThrow(/providerHosts: '\*' \(any host\) must be the only pattern/)
    expect(resolve({ providerEgressMode: 'firewall', providerEgressAzs: '1', providerHosts: '*' })).toThrow(/providerHosts: '\*' \(any host\) needs providerEgressMode=nat-dns or bring-your-own/)
    expect(resolve({ providerEgressMode: 'nat-dns', providerEgressAzs: '1', providerHosts: '**' })).toThrow(/is not a hostname, \*\.<domain> pattern or \*/)
    // The boundary the router and the console check: `*` alone, with or without a registry (its hosts are inside it).
    const any = resolveSettings(ctx({ ...BASE, providerEgressMode: 'nat-dns', providerEgressAzs: '1', providerHosts: '*' }), {}, DEFAULT_POLICY_FILE)
    expect(deployModels(any).boundary).toEqual({ mode: 'nat-dns', hosts: ['*'], cidrs: [] })
    expect(models({ ...NAT_DNS, providerHosts: '*' }).boundary).toEqual({ mode: 'nat-dns', hosts: ['*'], cidrs: ['10.20.0.0/16'] })
    expect(() => models({ ...NAT_DNS, providerHosts: '*' }, { ...REGISTRY, providers: [...REGISTRY.providers, provider('alt', 'https://alt.example:8443')] })).toThrow(/nat-dns egress opens TLS on 443 only/)
  })
  it('without hosts synth fails, like firewall; providerHosts alone make the boundary', () => {
    const noFile = resolveSettings(ctx({ ...BASE, providerEgressMode: 'nat-dns', providerEgressAzs: '1' }), {}, DEFAULT_POLICY_FILE)
    expect(() => deployModels(noFile)).toThrow(/providerEgressMode=nat-dns: no hosts to allow \(set -c providerHosts/)
    const hosts = resolveSettings(ctx({ ...BASE, providerEgressMode: 'nat-dns', providerEgressAzs: '1', providerHosts: '*.openai.azure.com,api.deepseek.com' }), {}, DEFAULT_POLICY_FILE)
    expect(deployModels(hosts).boundary).toEqual({ mode: 'nat-dns', hosts: ['*.openai.azure.com', 'api.deepseek.com'], cidrs: [] })
  })
  it('the allowlist and the endpoint checks are firewall\'s: https hostnames on 443; IP hosts and other ports through providerEgress', () => {
    expect(models(NAT_DNS).egressHosts).toEqual(models(FIREWALL).egressHosts)
    expect(models(NAT_DNS).boundary).toEqual({ ...models(FIREWALL).boundary, mode: 'nat-dns' })
    expect(() => models({ ...NAT_DNS, providerEgress: '10.30.0.0/16' })).toThrow(/'vllm' \(10\.20\.1\.5:8000\): no providerEgress rule covers/)
    const odd = { ...REGISTRY, providers: [...REGISTRY.providers, provider('alt', 'https://alt.example:8443')] }
    expect(() => models(NAT_DNS, odd)).toThrow(/'alt' \(alt\.example:8443\): nat-dns egress opens TLS on 443 only/)
    const onlyPrivate = { ...REGISTRY, providers: [provider('saas', 'https://10.20.1.5:8000')] }
    expect(() => models(NAT_DNS, onlyPrivate)).toThrow(/providerEgressMode=nat-dns: no registry endpoint is a public https hostname on 443/)
    const many = { ...REGISTRY, providers: [REGISTRY.providers[0], ...Array.from({ length: MAX_EGRESS_HOSTS }, (_, i) => provider(`p${i}`, `https://h${i}.example`))] }
    expect(() => models(NAT_DNS, many)).toThrow(new RegExp(`providerEgressMode=nat-dns: ${MAX_EGRESS_HOSTS + 1} hosts, at most ${MAX_EGRESS_HOSTS}`))
  })
})

/**
 * DNS Firewall evaluation as documented (Route 53 Developer Guide, "DNS Firewall rule groups and rules", walled garden
 * example): rules from the lowest priority number up, the first match decides; `*` matches every name, `*.example.com`
 * every subdomain (not the apex), anything else exactly; no match = the query is allowed.
 */
const dnsDecision = (rules: readonly DnsFirewallRule[], runtime: readonly string[], qname: string): 'ALLOW' | 'BLOCK' => {
  for (const r of [...rules].sort((a, b) => a.priority - b.priority)) {
    const domains = r.domains === 'runtime' ? runtime : r.domains
    if (domains.includes('*') || hostAllowed(qname, domains)) return r.action
  }
  return 'ALLOW'
}

describe('DNS Firewall rules of nat-dns (synth-level; verified against the DNS Firewall docs only, not deployed)', () => {
  const rules = dnsFirewallRules()
  // What provider-dns-sync puts in the provider list: the configured providers' exact hosts (never the ceiling).
  const runtime = providerDnsHosts({ providers: { providers: [{ baseUrl: 'https://api.provider.example/v1' }, { baseUrl: 'https://eu.openai.azure.com' }] } }, undefined, ['*']).hosts
  it('AWS service names first, then the provider list (content at runtime), then BLOCK everything', () => {
    expect(rules).toEqual([
      { list: 'aws', domains: ['*.amazonaws.com'], action: 'ALLOW', priority: 100 },
      { list: 'providers', domains: 'runtime', action: 'ALLOW', priority: 200 },
      { list: 'all', domains: ['*'], action: 'BLOCK', priority: 300 },
    ])
    expect(AWS_SERVICE_DOMAINS).toEqual(['*.amazonaws.com'])
    expect(runtime).toEqual(['api.provider.example', 'eu.openai.azure.com'])
  })
  it('resolves exactly the configured provider hosts and AWS service names, even under a `*` ceiling', () => {
    for (const q of ['api.provider.example', 'API.Provider.example.', 'eu.openai.azure.com', 'bedrock-runtime.ap-southeast-1.amazonaws.com', 'evil.amazonaws.com']) {
      expect(dnsDecision(rules, runtime, q), q).toBe('ALLOW')
    }
    for (const q of ['provider.example', 'x.api.provider.example', 'api.provider.example.evil.io', 'openai.azure.com', 'us.openai.azure.com',
      'amazonaws.com', 'amazonaws.com.evil.io', 'example.org', 'dns.google']) expect(dnsDecision(rules, runtime, q), q).toBe('BLOCK')
    // An empty configuration: AWS names only.
    expect(dnsDecision(rules, ['none.provider-dns.invalid'], 'api.provider.example')).toBe('BLOCK')
    expect(dnsDecision(rules, ['none.provider-dns.invalid'], 'logs.ap-southeast-1.amazonaws.com')).toBe('ALLOW')
  })
})

describe('router stack: providerEgressMode=nat-dns', () => {
  const two = build(NAT_DNS)
  const r = two.resources
  const fw = build(FIREWALL).resources
  const priv = build(PRIVATE).resources
  const lid = (prefix: string) => Object.keys(r).filter((id) => id.startsWith(prefix))

  it('passes cdk-nag AwsSolutions', () => {
    expect(() => build(NAT_DNS, REGISTRY, true).app.synth()).not.toThrow()
    expect(() => build({ ...NAT_DNS, providerEgressAzs: '1' }, REGISTRY, true).app.synth()).not.toThrow()
  })
  it('two AZs: an IGW, a NAT gateway and an Elastic IP per AZ in the NAT subnets; no Network Firewall', () => {
    expect(ofType(r, 'AWS::EC2::InternetGateway')).toHaveLength(1)
    expect(ofType(r, 'AWS::EC2::VPCGatewayAttachment')).toHaveLength(1)
    expect(ofType(r, 'AWS::EC2::NatGateway')).toHaveLength(2)
    expect(ofType(r, 'AWS::EC2::EIP')).toHaveLength(2)
    for (const t of ['AWS::NetworkFirewall::Firewall', 'AWS::NetworkFirewall::FirewallPolicy', 'AWS::NetworkFirewall::RuleGroup']) expect(ofType(r, t)).toEqual([])
    const subnets = ofType(r, 'AWS::EC2::Subnet').map(([, x]) => x.Properties)
    expect(subnets.map((x) => x?.CidrBlock).sort()).toEqual(['10.90.0.0/26', ...NAT_CIDRS, '10.90.0.64/26'])
    for (const x of subnets) expect(x?.MapPublicIpOnLaunch ?? false).toBe(false)
    expect(ofType(r, 'AWS::ECS::Service')[0]?.[1].Properties?.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp).toBe('DISABLED')
  })
  it('routes: router subnet → the NAT gateway of its AZ → IGW; no other routes; no internet route before the DNS filter', () => {
    const routes = ofType(r, 'AWS::EC2::Route')
    const rts = routerRouteTables(r)
    rts.forEach((rt, j) => {
      const def = routes.filter(([, x]) => x.Properties?.RouteTableId?.Ref === rt)
      expect(def).toHaveLength(1)
      expect(def[0]?.[1].Properties).toMatchObject({ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: { Ref: expect.stringMatching(new RegExp(`^ProviderEgressNat${j}`)) } })
      expect([def[0]?.[1].DependsOn ?? []].flat()).toContain(lid('ProviderEgressDnsFirewallAssociation')[0])
    })
    for (const i of [0, 1]) {
      const natRt = routes.filter(([, x]) => String(x.Properties?.RouteTableId?.Ref).startsWith(`ProviderEgressNatSubnet${i}Rt`)).map(([, x]) => x.Properties)
      expect(natRt).toEqual([expect.objectContaining({ DestinationCidrBlock: '0.0.0.0/0', GatewayId: { Ref: expect.stringMatching(/^ProviderEgressIgw/) } })])
    }
    expect(routes).toHaveLength(4)
  })
  it('DNS Firewall: three domain lists, the rules in priority order, associated with the router VPC, fail-closed default', () => {
    const lists = Object.fromEntries(ofType(r, 'AWS::Route53Resolver::FirewallDomainList').map(([id, x]) => [id, x.Properties]))
    expect(Object.values(lists).map((x) => [x?.Name, x?.Domains]).sort()).toEqual([
      ['llmar-egress-all', ['*']], ['llmar-egress-aws', ['*.amazonaws.com']], ['llmar-egress-providers', undefined]])
    // CloudFormation never manages the provider list's content: no Domains, no DomainFileUrl, so a deploy keeps it.
    const providerList = Object.values(lists).find((x) => x?.Name === 'llmar-egress-providers')
    expect(providerList).toEqual({ Name: 'llmar-egress-providers' })
    expect(build({ ...NAT_DNS, providerHosts: '*' }).resources).toSatisfy((res: Res) =>
      ofType(res, 'AWS::Route53Resolver::FirewallDomainList').every(([, x]) => x.Properties?.Name !== 'llmar-egress-providers' || x.Properties?.Domains === undefined))
    const groups = ofType(r, 'AWS::Route53Resolver::FirewallRuleGroup')
    expect(groups).toHaveLength(1)
    const listName = (ref: { 'Fn::GetAtt': [string, string] }) => lists[ref['Fn::GetAtt'][0]]?.Name
    const fr = (groups[0]?.[1].Properties?.FirewallRules as Record<string, any>[]).map(({ FirewallDomainListId, ...x }) => ({ list: listName(FirewallDomainListId), ...x }))
    expect(fr).toEqual([
      { list: 'llmar-egress-aws', Priority: 100, Action: 'ALLOW', FirewallDomainRedirectionAction: 'TRUST_REDIRECTION_DOMAIN' },
      { list: 'llmar-egress-providers', Priority: 200, Action: 'ALLOW', FirewallDomainRedirectionAction: 'TRUST_REDIRECTION_DOMAIN' },
      { list: 'llmar-egress-all', Priority: 300, Action: 'BLOCK', BlockResponse: 'NXDOMAIN' },
    ])
    const assoc = ofType(r, 'AWS::Route53Resolver::FirewallRuleGroupAssociation')
    expect(assoc.map(([, x]) => x.Properties)).toEqual([{ Name: 'llmar-egress-dns', FirewallRuleGroupId: { 'Fn::GetAtt': [groups[0]?.[0], 'Id'] },
      VpcId: { Ref: expect.stringMatching(/^Vpc[0-9A-F]{8}$/) }, Priority: DNS_FIREWALL_ASSOCIATION_PRIORITY, MutationProtection: 'DISABLED' }])
    // Every DNS Firewall and NAT-layer resource takes the deploy tags.
    const tagged = build(NAT_DNS, REGISTRY, false, true).resources
    for (const [id, x] of Object.entries(tagged).filter(([i]) => i.startsWith('ProviderEgress') && !/RtAssoc|Route|Default\d|IgwAttachment/.test(i))) {
      expect(x.Properties?.Tags, id).toEqual(expect.arrayContaining([{ Key: 'Owner', Value: 'test-owner' }, { Key: 'Project', Value: 'llm-auto-router' }]))
    }
    // FirewallFailOpen has no CloudFormation resource: nothing in the template may turn fail-open on (default DISABLED).
    expect(JSON.stringify(r)).not.toMatch(/FirewallFailOpen|UpdateFirewallConfig/)
    // No query logging (optional, not added) and nothing in the other modes.
    expect(ofType(r, 'AWS::Route53Resolver::ResolverQueryLoggingConfig')).toEqual([])
    for (const other of [fw, priv, build({}, null).resources]) expect(Object.values(other).filter((x) => x.Type.startsWith('AWS::Route53Resolver::'))).toEqual([])
  })
  it('every VPC endpoint\'s names and the router\'s own AWS calls stay resolvable; anything else is NXDOMAIN', () => {
    const rules = dnsFirewallRules()
    // The deploy-time sync with no console activation: the baked registry's hosts (here the providersFile's).
    const runtime = providerDnsHosts(undefined, { providers: { providers: REGISTRY.providers } }, two.models.boundary.hosts).hosts
    expect(runtime).toEqual(['api.provider.example', 'inference.other.example'])
    const region = 'ap-southeast-1'
    const services = ofType(r, 'AWS::EC2::VPCEndpoint').map(([, x]) => {
      const sn = x.Properties?.ServiceName
      return typeof sn === 'string' ? sn : (sn['Fn::Join'][1] as unknown[]).map((p) => (typeof p === 'string' ? p : region)).join('')
    })
    expect(services.sort()).toEqual(['bedrock-runtime', 'ecr.api', 'ecr.dkr', 'execute-api', 'logs', 's3', 'secretsmanager'].map((x) => `com.amazonaws.${region}.${x}`))
    const names = services.flatMap((sn) => {
      const svc = sn.replace(`com.amazonaws.${region}.`, '').split('.').reverse().join('.')
      // The service name, a name under it (ECR registries, S3 buckets incl. ECR's layer bucket) and its VPC endpoint name.
      return [`${svc}.${region}.amazonaws.com`, `prod-${region}-starport-layer-bucket.${svc}.${region}.amazonaws.com`, `vpce-0123456789abcdef0-abcdefgh.${svc}.${region}.vpce.amazonaws.com`]
    })
    // The router's own calls (packages/router: config.ts, source.ts, state-store.ts, providers.ts) and STS for the SDK.
    names.push(`bedrock-runtime.${region}.amazonaws.com`, `llmar-config.s3.${region}.amazonaws.com`, `dynamodb.${region}.amazonaws.com`,
      `secretsmanager.${region}.amazonaws.com`, `sts.${region}.amazonaws.com`, `cognito-idp.${region}.amazonaws.com`)
    for (const q of names) expect(dnsDecision(rules, runtime, q), q).toBe('ALLOW')
    for (const q of runtime) expect(dnsDecision(rules, runtime, q), q).toBe('ALLOW')
    for (const q of ['example.org', 'provider.example', 'dns.google', 'cloudflare-dns.com']) expect(dnsDecision(rules, runtime, q), q).toBe('BLOCK')
    // With no provider at all, every AWS name still resolves.
    for (const q of names) expect(dnsDecision(rules, ['none.provider-dns.invalid'], q), q).toBe('ALLOW')
  })
  it('router SG: 443 to the internet once, plus the private rules', () => {
    expect(internetEgress(r)).toEqual([expect.objectContaining({ FromPort: 443, ToPort: 443, IpProtocol: 'tcp' })])
    const all = ofType(r, 'AWS::EC2::SecurityGroup').flatMap(([, x]) => (x.Properties?.SecurityGroupEgress ?? []) as { CidrIp?: string; FromPort?: number }[])
    expect(all.filter((e) => e.CidrIp === '10.20.0.0/16')).toEqual([expect.objectContaining({ FromPort: 8000, ToPort: 8000 })])
  })
  it('one AZ: one NAT gateway in AZ 0, used by both router subnets', () => {
    const one = build({ ...NAT_DNS, providerEgressAzs: '1' }).resources
    expect(ofType(one, 'AWS::EC2::NatGateway')).toHaveLength(1)
    expect(ofType(one, 'AWS::EC2::EIP')).toHaveLength(1)
    expect(ofType(one, 'AWS::EC2::Subnet').map(([, x]) => x.Properties?.CidrBlock)).toContain(NAT_CIDRS[0])
    expect(ofType(one, 'AWS::EC2::Subnet').map(([, x]) => x.Properties?.CidrBlock)).not.toContain(NAT_CIDRS[1])
    const routes = ofType(one, 'AWS::EC2::Route').map(([, x]) => x.Properties!)
    for (const rt of routerRouteTables(one)) {
      expect(routes.find((x) => x.RouteTableId?.Ref === rt)?.NatGatewayId).toEqual({ Ref: expect.stringMatching(/^ProviderEgressNat0/) })
    }
  })
  it('leaves the VPC, router subnets, route tables and every VPC endpoint unchanged (same logical ids and properties)', () => {
    const pick = (res: Res, types: string[]) => Object.fromEntries(Object.entries(res).filter(([, x]) => types.includes(x.Type)).map(([id, x]) => [id, x.Properties]))
    const kept = ['AWS::EC2::VPCEndpoint', 'AWS::EC2::VPC']
    expect(pick(r, kept)).toEqual(pick(priv, kept))
    expect(pick(r, kept)).toEqual(pick(fw, kept))
    expect(Object.fromEntries(routerSubnets(r))).toEqual(Object.fromEntries(routerSubnets(priv)))
    expect(routerRouteTables(r)).toEqual(routerRouteTables(priv))
    const s3 = Object.values(pick(r, ['AWS::EC2::VPCEndpoint'])).find((p) => p?.VpcEndpointType === 'Gateway' && JSON.stringify(p?.ServiceName).includes('s3'))
    expect(s3?.RouteTableIds.map((x: { Ref: string }) => x.Ref).sort()).toEqual(routerRouteTables(priv).sort())
    const plain = build({}, null).resources
    const shipped = (res: Res) => Object.fromEntries(Object.entries(pick(res, ['AWS::EC2::VPCEndpoint'])).filter(([id]) => !id.startsWith('VpcSecretsManager')))
    expect(shipped(r)).toEqual(shipped(plain))
  })
  it('switching firewall <-> nat-dns keeps the NAT layer (IGW, NAT subnets, Elastic IPs, NAT gateways) and the router routes\' logical ids', () => {
    const natLayer = (res: Res) => Object.fromEntries(Object.entries(res).filter(([id]) => /^ProviderEgress(Igw|IgwAttachment|NatSubnet\d|NatEip\d|Nat\d|NatDefault\d)/.test(id)))
    expect(Object.keys(natLayer(r)).sort()).toHaveLength(2 + 2 * 6)
    expect(natLayer(r)).toEqual(natLayer(fw))
    const routerDefaults = (res: Res) => Object.keys(res).filter((id) => id.startsWith('ProviderEgressRouterDefault')).sort()
    expect(routerDefaults(r)).toEqual(routerDefaults(fw))
  })
})

describe('router stack: provider-dns-sync (nat-dns, ADR 0003)', () => {
  const b = build(NAT_DNS)
  const r = b.resources
  const fnOf = (res: Res) => ofType(res, 'AWS::Lambda::Function').find(([, x]) => x.Properties?.FunctionName === 'llmar-provider-dns-sync')
  const paramValue = (res: Res) => ofType(res, 'AWS::SSM::Parameter').find(([, x]) => x.Properties?.Name === '/llmar/router/provider-dns-sync-function')?.[1].Properties?.Value
  it('one function, the catalog image with its own CMD, outside the VPC, with the provider list and the boundary in its env', () => {
    const [, f] = fnOf(r)!
    expect(f.Properties?.ImageConfig?.Command).toEqual(['handlers/catalog-provider-dns.handler'])
    expect(f.Properties?.VpcConfig).toBeUndefined()
    const env = f.Properties?.Environment.Variables
    expect(env.DOMAIN_LIST_ID).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^ProviderEgressDomainListproviders/), 'Id'] })
    expect(JSON.parse(env.PROVIDER_BOUNDARY)).toEqual(b.models.boundary)
    expect(env.DEPLOY_INPUTS).toMatch(/^[0-9a-f]{16}$/)
    expect(Object.keys(env).sort()).toEqual(['CONFIG_BUCKET', 'DEPLOY_INPUTS', 'DOMAIN_LIST_ID', 'PROVIDER_BOUNDARY', 'REGION'])
    expect(paramValue(r)).toBe('llmar-provider-dns-sync')
  })
  it('IAM: read config/active.json and config/baked.json, list the bucket, update and read that one domain list; nothing else', () => {
    const pol = ofType(r, 'AWS::IAM::Policy').find(([, x]) => JSON.stringify(x.Properties?.Roles).includes('ProviderDnsSyncRole'))![1]
    const st = pol.Properties?.PolicyDocument.Statement as Array<{ Sid: string; Action: string | string[]; Resource: unknown }>
    expect(st.map((x) => [x.Sid, [x.Action].flat().sort()])).toEqual([
      ['OwnLogs', ['logs:CreateLogStream', 'logs:PutLogEvents']], ['ConfigRead', ['s3:GetObject']], ['ConfigList', ['s3:ListBucket']],
      ['ProviderDomainList', ['route53resolver:GetFirewallDomainList', 'route53resolver:UpdateFirewallDomains']]])
    expect(JSON.stringify(st[1]!.Resource)).toMatch(/\/config\/active\.json".*\/config\/baked\.json"/)
    expect(st[3]!.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^ProviderEgressDomainListproviders/), 'Arn'] })
  })
  it('a deploy-time Trigger runs it after the bucket deployment and before the router service', () => {
    const trig = ofType(r, 'Custom::Trigger').find(([id]) => id.startsWith('ProviderDnsDeploySync'))!
    expect(JSON.stringify(trig[1].Properties?.HandlerArn)).toContain('ProviderDnsSync')
    expect([trig[1].DependsOn].flat()).toEqual(expect.arrayContaining([expect.stringMatching(/^PacksArchive/), expect.stringMatching(/^ProviderEgressDomainListproviders/)]))
    const svc = ofType(r, 'AWS::ECS::Service')[0]!
    expect([svc[1].DependsOn].flat()).toContain(trig[0])
  })
  it('the other modes have no function, no Trigger and the parameter says none', () => {
    for (const other of [build(FIREWALL).resources, build(PRIVATE).resources, build({}, null).resources]) {
      expect(fnOf(other)).toBeUndefined()
      expect(ofType(other, 'Custom::Trigger').filter(([id]) => id.startsWith('ProviderDnsDeploySync'))).toEqual([])
      expect(paramValue(other)).toBe('none')
    }
  })
})
