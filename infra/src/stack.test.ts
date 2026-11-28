import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App, Tags, Validations, aws_ecr as ecr, aws_ecs as ecs, aws_lambda as lambda } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { loadConfig, packInfos } from '@auto-router/router'
import { bakedConfigDocument } from '@auto-router/router/settings'
import { loadCatalog } from '@auto-router/pricing'
import { AwsSolutionsChecks } from 'cdk-nag'
import { describe, expect, it } from 'vitest'
import { ASSESSOR_DEFAULT_PACK, ASSESSOR_PACKS_DIR, DEFAULT_POLICY_FILE, deployModels } from './models.ts'
import { MAX_ROUTER_TASKS, resolveSettings } from './settings.ts'
import { routerParamName, ROUTER_PARAMS } from './console-stack.ts'
import { assessorEnv, DEREGISTRATION_DELAY_S, JWKS_SYNC_CODE, REQUEST_HEADERS, RouterStack, RULE_PRIORITY, SHUTDOWN_GRACE_MS,
  SCALE_IN_COOLDOWN_S, SCALE_OUT_COOLDOWN_S, SHUTDOWN_MARGIN_S, STATE_TABLE_ACTIONS, STOP_TIMEOUT_S } from './stack.ts'
import { testTempDir } from './test-outdir.ts'

const ctx = (c: Record<string, string>) => ({ tryGetContext: (k: string) => c[k] })
const SETTINGS = resolveSettings(ctx({ region: 'ap-southeast-1', account: '000000000000', tags: '{"Owner":"test-owner"}' }), {}, DEFAULT_POLICY_FILE)
const MODELS = deployModels(SETTINGS)

/** A staged packs archive as stagePacksArchive writes it (current.json + one nested packVersion file). */
function packsFixture(): string {
  const dir = testTempDir('packs-test')
  mkdirSync(join(dir, 'packs', 'assessor'), { recursive: true })
  writeFileSync(join(dir, 'packs', 'current.json'), '{"packs":[]}\n')
  writeFileSync(join(dir, 'packs', 'assessor', 'v2.2+0123456789ab.json'), '{}\n')
  return dir
}

function build(nag = false, settings = SETTINGS, packsArchiveDir?: string, models = MODELS) {
  const app = new App({ outdir: testTempDir('infra-test') })
  const stack = new RouterStack(app, 'llmar-router', { env: { account: settings.account, region: settings.region }, settings, models,
    image: ecs.ContainerImage.fromRegistry(`${settings.account}.dkr.ecr.${settings.region}.amazonaws.com/llmar-router:test`), ...(packsArchiveDir ? { packsArchiveDir } : {}),
    lambdaCode: (s, cmd) => lambda.DockerImageCode.fromEcr(ecr.Repository.fromRepositoryName(s, `Repo${cmd.replace(/[^A-Za-z]/g, '')}`, 'llmar-catalog-test'), { cmd: [cmd] }) })
  for (const [k, v] of Object.entries(SETTINGS.tags)) Tags.of(app).add(k, v)
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app))
  return { app, stack, template: Template.fromStack(stack) }
}
const { template } = build()
const resources = template.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, any>; DeletionPolicy?: string; UpdateReplacePolicy?: string }>
const ofType = (t: string) => Object.entries(resources).filter(([, r]) => r.Type === t)

describe('llmar-mvp stack', () => {
  it('passes cdk-nag AwsSolutions with only the justified acknowledgements', () => {
    expect(() => build(true).app.synth()).not.toThrow()
  })

  it('gateway targets wait for the gateway role policy (model discovery runs at target creation)', () => {
    const raw = resources as Record<string, { Type: string; DependsOn?: string | string[]; Properties?: Record<string, any> }>
    const policy = Object.entries(raw).find(([, r]) => r.Type === 'AWS::IAM::Policy'
      && JSON.stringify(r.Properties?.Roles ?? []).includes('GatewayRole'))?.[0]
    expect(policy).toBeDefined()
    const targets = Object.entries(raw).filter(([, r]) => r.Type === 'AWS::BedrockAgentCore::GatewayTarget')
    expect(targets.length).toBe(1)
    for (const [, t] of targets) expect([t.DependsOn ?? []].flat()).toContain(policy)
  })

  it('has no internet path: no IGW, no NAT, no public IPs', () => {
    template.resourceCountIs('AWS::EC2::InternetGateway', 0)
    template.resourceCountIs('AWS::EC2::NatGateway', 0)
    template.resourceCountIs('AWS::EC2::EIP', 0)
    template.resourceCountIs('AWS::NetworkFirewall::Firewall', 0)
    template.resourceCountIs('AWS::Route53Resolver::FirewallRuleGroupAssociation', 0)
    const egress = ofType('AWS::EC2::SecurityGroup').flatMap(([, r]) => (r.Properties?.SecurityGroupEgress ?? []) as { CidrIp?: string }[])
    expect(egress.filter((e) => e.CidrIp === '0.0.0.0/0')).toEqual([])
    for (const [, s] of ofType('AWS::EC2::Subnet')) expect(s.Properties?.MapPublicIpOnLaunch ?? false).toBe(false)
    const svc = ofType('AWS::ECS::Service')[0]?.[1]
    expect(svc?.Properties?.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp).toBe('DISABLED')
  })

  it('never opens ingress to 0.0.0.0/0 or ::/0', () => {
    const rules = [...ofType('AWS::EC2::SecurityGroupIngress').map(([, r]) => r.Properties),
      ...ofType('AWS::EC2::SecurityGroup').flatMap(([, r]) => r.Properties?.SecurityGroupIngress ?? [])]
    for (const r of rules) { expect(r?.CidrIp).not.toBe('0.0.0.0/0'); expect(r?.CidrIpv6).not.toBe('::/0') }
  })

  const sgByName = (name: string) => ofType('AWS::EC2::SecurityGroup').find(([, r]) => r.Properties?.GroupName === name)?.[0] as string
  const rulesOf = (type: 'AWS::EC2::SecurityGroupIngress' | 'AWS::EC2::SecurityGroupEgress', sgId: string) =>
    ofType(type).map(([, r]) => r.Properties ?? {}).filter((r) => JSON.stringify(r.GroupId).includes(sgId))
  const inline = (sgId: string) => (resources[sgId]?.Properties?.SecurityGroupIngress ?? []) as Record<string, any>[]

  it('router SG: ingress 8080 only from the NLB SG; egress 443 only', () => {
    const router = sgByName('llmar-router')
    const ingress = [...rulesOf('AWS::EC2::SecurityGroupIngress', router), ...inline(router)]
    expect(ingress).toHaveLength(1)
    expect(ingress[0]).toMatchObject({ FromPort: 8080, ToPort: 8080, SourceSecurityGroupId: { 'Fn::GetAtt': [sgByName('llmar-nlb'), 'GroupId'] } })
    const egress = rulesOf('AWS::EC2::SecurityGroupEgress', router)
    expect(egress.length).toBeGreaterThan(0)
    for (const e of egress) expect([e.FromPort, e.ToPort]).toEqual([443, 443])
  })

  it('NLB: internal, SG with no ingress rules, PrivateLink inbound rules not enforced (VPC link traffic only)', () => {
    const nlb = sgByName('llmar-nlb')
    expect([...rulesOf('AWS::EC2::SecurityGroupIngress', nlb), ...inline(nlb)]).toHaveLength(0)
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Type: 'network', Scheme: 'internal', EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: 'off',
    })
  })

  it('execute-api endpoint: private DNS off, SG admits only the resource gateway SG, policy admits only the gateway role', () => {
    const vpce = ofType('AWS::EC2::VPCEndpoint').find(([, r]) => JSON.stringify(r.Properties?.ServiceName).includes('execute-api'))?.[1].Properties
    expect(vpce?.PrivateDnsEnabled).toBe(false)
    const st = vpce?.PolicyDocument.Statement
    expect(st).toHaveLength(1)
    expect(st[0]).toMatchObject({ Effect: 'Allow', Action: 'execute-api:Invoke', Principal: { AWS: { 'Fn::GetAtt': [expect.stringMatching(/^GatewayRole/), 'Arn'] } } })
    const apiSg = sgByName('llmar-api-vpce')
    const ingress = [...rulesOf('AWS::EC2::SecurityGroupIngress', apiSg), ...inline(apiSg)]
    expect(ingress).toHaveLength(1)
    expect(ingress[0]).toMatchObject({ FromPort: 443, SourceSecurityGroupId: { 'Fn::GetAtt': [sgByName('llmar-gw-egress'), 'GroupId'] } })
  })

  it('REST API: PRIVATE, AWS_IAM, explicit denies for other endpoints and other principals (same-account evaluation)', () => {
    const api = ofType('AWS::ApiGateway::RestApi')[0]?.[1].Properties
    expect(api?.EndpointConfiguration.Types).toEqual(['PRIVATE'])
    const sids = api?.Policy.Statement.map((x: any) => [x.Sid, x.Effect])
    expect(sids).toEqual([['GatewayRoleViaEndpoint', 'Allow'], ['DenyOtherEndpoints', 'Deny'], ['DenyOtherPrincipals', 'Deny']])
    expect(api?.Policy.Statement[2].Condition.ArnNotEquals['aws:PrincipalArn']).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^GatewayRole/), 'Arn'] })
    template.hasResourceProperties('AWS::ApiGateway::Stage', { StageName: 'v1' })
  })

  it('integration: HTTP_PROXY over the VPC link, streaming, 15 min, identity headers mapped and the session token overwritten', () => {
    const m = ofType('AWS::ApiGateway::Method')[0]?.[1].Properties
    expect(m).toMatchObject({ HttpMethod: 'ANY', AuthorizationType: 'AWS_IAM' })
    expect(m?.Integration).toMatchObject({ Type: 'HTTP_PROXY', ConnectionType: 'VPC_LINK', ResponseTransferMode: 'STREAM', TimeoutInMillis: 900000 })
    expect(m?.Integration.RequestParameters).toMatchObject({
      'integration.request.header.x-router-caller-arn': 'context.identity.userArn',
      'integration.request.header.x-router-source-vpce': 'context.identity.vpceId',
      'integration.request.header.x-amz-security-token': "'redacted'",
    })
    expect(JSON.stringify(m?.Integration.Uri)).toContain(':8080/v1/{proxy}')
  })

  it('no IAM statement allows a wildcard action (except the CDK BucketDeployment framework role, bounded by the bucket Deny)', () => {
    const deployRole = ofType('AWS::IAM::Role').filter(([id]) => id.startsWith('CustomCDKBucketDeployment')).map(([id]) => id)
    expect(deployRole).toHaveLength(1)
    for (const [id, p] of [...ofType('AWS::IAM::Policy'), ...ofType('AWS::IAM::Role')]) {
      if (deployRole.includes(id) || JSON.stringify(p.Properties?.Roles ?? []).includes(deployRole[0] as string)) {
        // CDK's grant patterns on the asset and config buckets only; writes outside packs/ and config/baked* are denied
        // by the bucket policy (tested below).
        for (const s of (p.Properties?.PolicyDocument?.Statement ?? []) as Array<{ Action: string | string[] }>) {
          for (const a of [s.Action].flat()) expect(a, id).toMatch(/^s3:(Abort\*|DeleteObject\*|GetBucket\*|GetObject\*|List\*|PutObject|PutObjectLegalHold|PutObjectRetention|PutObjectTagging|PutObjectVersionTagging)$/)
        }
        continue
      }
      const docs = [p.Properties?.PolicyDocument, ...(p.Properties?.Policies ?? []).map((x: any) => x.PolicyDocument)].filter(Boolean)
      // Any `*` in an action (`*`, `svc:*`, `svc:Invoke*`), and NotAction (an implicit wildcard), fail.
      for (const d of docs) for (const s of d.Statement) {
        expect(s.NotAction).toBeUndefined()
        for (const a of [s.Action].flat()) expect(String(a)).not.toContain('*')
      }
    }
  })

  it('task role invokes exactly the router models via the documented global-profile pattern; gateway role only invokes the router API', () => {
    const doc = (prefix: string) => ofType('AWS::IAM::Policy').find(([id]) => id.startsWith(prefix))?.[1].Properties?.PolicyDocument
    const fullTask = doc('TaskRole')
    // Model grants only (Router* sids); the config-bucket read is checked in the identity tests below.
    const task = { ...fullTask, Statement: fullTask.Statement.filter((st: any) => String(st.Sid).startsWith('Router')) }
    const bases = new Set(MODELS.routerModels.map((m) => m.replace(/^global\./, '')))
    const resources: string[] = task.Statement.flatMap((st: any) => [st.Resource].flat()).map((x: unknown) => JSON.stringify(x))
    const project = task.Statement.find((st: any) => st.Sid === 'RouterResponsesDefaultProject')
    for (const st of task.Statement.filter((x: any) => x !== project)) for (const r of [st.Resource].flat().map((x: unknown) => JSON.stringify(x))) {
      const m = /(?:inference-profile\/global\.|foundation-model\/)([a-z0-9.:-]+)"/.exec(r)
      expect(m, r).not.toBeNull()
      expect(bases.has(m?.[1] as string), r).toBe(true)
      expect(r, 'no wildcards').not.toMatch(/\*/)
    }
    const sids = task.Statement.map((st: any) => st.Sid)
    expect(sids).toEqual(['RouterInferenceProfiles', 'RouterProfileModelsInRegion', 'RouterGlobalProfileModels', 'RouterResponsesDefaultProject'])
    // Responses needs InvokeModel on the default project, limited by bedrock:ModelArn to the Responses pool's profiles.
    expect(project.Action).toBe('bedrock:InvokeModel')
    expect(JSON.stringify(project.Resource)).toContain(':project/*')
    expect(JSON.stringify(project.Condition.StringEquals['bedrock:ModelArn'])).toContain('inference-profile/global.openai.gpt-6.1-sol')
    expect(JSON.stringify(project.Condition.StringEquals['bedrock:ModelArn'])).not.toContain('anthropic')
    const globalFm = task.Statement.find((st: any) => st.Sid === 'RouterGlobalProfileModels')
    expect(globalFm.Condition.StringEquals['aws:RequestedRegion']).toBe('unspecified')
    expect(JSON.stringify(globalFm.Resource)).toContain('arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-5-5')
    const gw = doc('GatewayRole')
    expect(gw.Statement).toHaveLength(1)
    expect(gw.Statement[0]).toMatchObject({ Sid: 'InvokeRouterApi', Effect: 'Allow', Action: 'execute-api:Invoke' })
    expect(JSON.stringify(gw.Statement[0].Resource)).toContain(':execute-api:')
    expect(JSON.stringify(gw)).not.toContain('bedrock:')
    expect(JSON.stringify(gw)).not.toContain('Fallback')
  })

  it('allowedModelUniverse: policy (default), catalog or a list widens the task role grants, the router env and the console list together', () => {
    const policyModels = ['global.anthropic.claude-haiku-5-5', 'global.anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-5-5',
      'global.openai.gpt-6-astra', 'global.openai.gpt-6-luna', 'global.openai.gpt-6.1-sol']
    expect(SETTINGS.modelUniverse).toBe('policy')
    expect(MODELS.routerModels).toEqual(policyModels)
    expect(MODELS.routerResponsesModels).toEqual(['global.openai.gpt-6-astra', 'global.openai.gpt-6-luna', 'global.openai.gpt-6.1-sol'])
    const base = { region: 'ap-southeast-1', account: SETTINGS.account }
    const list = resolveSettings(ctx({ ...base, allowedModelUniverse: 'global.anthropic.claude-fable-5-1, global.openai.gpt-5.6-luna' }), {}, DEFAULT_POLICY_FILE)
    const listed = deployModels(list)
    expect(listed.routerModels).toEqual([...policyModels, 'global.anthropic.claude-fable-5-1', 'global.openai.gpt-5.6-luna'].sort())
    expect(listed.routerResponsesModels).toContain('global.openai.gpt-5.6-luna')
    expect(listed.routerResponsesModels).not.toContain('global.anthropic.claude-fable-5-1')
    expect(() => deployModels(resolveSettings(ctx({ ...base, allowedModelUniverse: 'global.openai.gpt-9-nope' }), {}, DEFAULT_POLICY_FILE)))
      .toThrow(/allowedModelUniverse: 'global.openai.gpt-9-nope' is not in the shipped model metadata/)
    expect(() => deployModels(resolveSettings(ctx({ ...base, allowedModelUniverse: 'everything' }), {}, DEFAULT_POLICY_FILE))).toThrow(/'everything' is not in the shipped model metadata \(use policy, catalog/)
    expect(() => resolveSettings(ctx({ ...base, allowedModelUniverse: 'Bad Id' }), {}, DEFAULT_POLICY_FILE)).toThrow(/'Bad Id' is not a model id/)

    const all = resolveSettings(ctx({ ...base, allowedModelUniverse: 'catalog' }), {}, DEFAULT_POLICY_FILE)
    const wide = deployModels(all)
    // 'catalog' = the models the Region is known to offer (its bundled catalog), checked against the shipped metadata.
    const apse1 = loadCatalog('ap-southeast-1')
    expect(wide.routerModels).toEqual(apse1.models.map((m) => m.modelId).sort())
    expect(wide.routerResponsesModels).toEqual(apse1.models.filter((m) => m.dialects.includes('openai-responses')).map((m) => m.modelId).sort())
    const t = build(false, all, undefined, wide).template.toJSON().Resources as typeof resources
    const iam = JSON.stringify(Object.values(t).filter((r) => r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy').map((r) => r.Properties))
    for (const m of wide.routerModels) expect(iam, m).toContain(`inference-profile/${m}`)
    const env = Object.fromEntries((Object.values(t).find((r) => r.Type === 'AWS::ECS::TaskDefinition')?.Properties?.ContainerDefinitions[0].Environment as Array<{ Name: string; Value: unknown }>).map((e) => [e.Name, e.Value]))
    expect(env.ROUTER_MODEL_UNIVERSE).toBe(wide.routerModels.join(','))
    const universeParam = Object.values(t).find((r) => r.Type === 'AWS::SSM::Parameter' && r.Properties?.Name === routerParamName('llmar', 'modelUniverse'))
    expect(universeParam?.Properties?.Value).toBe(wide.routerModels.join(','))
    // The router boots with this universe: it must cover the boot policy and be in the catalog.
    expect(() => loadConfig({ ROUTER_POLICY_FILE: DEFAULT_POLICY_FILE, ROUTER_REGION: 'ap-southeast-1', ROUTER_MODEL_UNIVERSE: env.ROUTER_MODEL_UNIVERSE as string } as never)).not.toThrow()
  })

  it('settings: region and account are explicit; AZ IDs, prefix, tags and throttle are deploy inputs with no personal default', () => {
    expect(() => resolveSettings(ctx({ account: '000000000000' }), { CDK_DEFAULT_REGION: 'ap-southeast-1', AWS_REGION: 'ap-southeast-1' }, DEFAULT_POLICY_FILE)).toThrow(/region: required \(-c region=<aws-region>\)/)
    expect(() => resolveSettings(ctx({ region: 'ap-southeast-1' }), { CDK_DEFAULT_ACCOUNT: '000000000000' }, DEFAULT_POLICY_FILE)).toThrow(/account: required/)
    expect(() => resolveSettings(ctx({ region: 'ap-southeast-1', account: 'env' }), {}, DEFAULT_POLICY_FILE)).toThrow(/account=env needs CDK_DEFAULT_ACCOUNT/)
    expect(resolveSettings(ctx({ region: 'ap-southeast-1', account: 'env' }), { CDK_DEFAULT_ACCOUNT: '111111111111' }, DEFAULT_POLICY_FILE).account).toBe('111111111111')
    const base = { account: '000000000000' }
    expect(() => resolveSettings(ctx({ ...base, region: 'eu-west-3' }), {}, DEFAULT_POLICY_FILE)).toThrow(/azIds: two AZ IDs required/)
    const eu = resolveSettings(ctx({ ...base, region: 'eu-west-3', azIds: 'euw3-az1,euw3-az2', prefix: 'acme', throttle: '5,10' }), {}, DEFAULT_POLICY_FILE)
    expect(eu).toMatchObject({ region: 'eu-west-3', azIds: ['euw3-az1', 'euw3-az2'], prefix: 'acme', tags: { Project: 'llm-auto-router', Purpose: 'mvp' }, throttle: { rate: 5, burst: 10 } })
    expect(eu.tags.Owner).toBeUndefined()
    expect(SETTINGS.throttle).toEqual({ rate: 1000, burst: 2000 })
    expect(() => resolveSettings(ctx({ ...base, region: 'ap-southeast-1', throttle: 'x' }), {}, DEFAULT_POLICY_FILE)).toThrow(/throttle/)
    // No bundled catalog: synth checks against the shipped metadata (availability is checked by the deploy-time refresh).
    expect(deployModels(eu).routerModels).toEqual(MODELS.routerModels)
    const euWide = deployModels({ ...eu, modelUniverse: 'catalog' })
    expect(euWide.routerModels.every((id) => id.startsWith('global.'))).toBe(true)
    expect(euWide.routerModels).toContain('global.anthropic.claude-fable-5')
    expect(resolveSettings(ctx({ ...base, region: 'ap-northeast-1' }), {}, DEFAULT_POLICY_FILE).azIds).toEqual(['apne1-az1', 'apne1-az2'])
    const tokyoExample = new URL('../../packages/router/config/policy.example.ap-northeast-1.json', import.meta.url).pathname
    // Region-independent synth: a geo profile the Region does not offer passes synth; the deploy-time refresh blocks it.
    expect(deployModels({ ...SETTINGS, policyFile: tokyoExample }).routerModels).toContain('jp.anthropic.claude-haiku-5-5')
    expect(() => deployModels({ ...SETTINGS, policyFile: '/virtual/p.json' }, (p) => (p === '/virtual/p.json'
      ? (() => { const p = JSON.parse(readFileSync(DEFAULT_POLICY_FILE, 'utf8')); return JSON.stringify({ ...p, observeDefaults: { ...p.observeDefaults, 'anthropic-messages': 'global.anthropic.claude-nope-1' } }) })()
      : readFileSync(p, 'utf8')))).toThrow(/policy vs the shipped model metadata:.*claude-nope-1/s)
    expect(deployModels({ ...SETTINGS, region: 'ap-northeast-1', azIds: ['apne1-az1', 'apne1-az2'], policyFile: tokyoExample }).routerModels).toContain('jp.anthropic.claude-haiku-5-5')
  })

  it('stage throttling, Container Insights off, endpoint policy on bedrock-runtime', () => {
    expect(ofType('AWS::ApiGateway::Stage')[0]?.[1].Properties?.MethodSettings).toEqual([{ ResourcePath: '/*', HttpMethod: '*', ThrottlingRateLimit: 1000, ThrottlingBurstLimit: 2000 }])
    const cluster = ofType('AWS::ECS::Cluster')[0]?.[1].Properties
    expect(cluster?.ClusterSettings).toEqual([{ Name: 'containerInsights', Value: 'disabled' }])
    const br = ofType('AWS::EC2::VPCEndpoint').find(([, r]) => JSON.stringify(r.Properties?.ServiceName).includes('bedrock-runtime'))?.[1].Properties
    expect(br?.PolicyDocument.Statement).toEqual([expect.objectContaining({
      Effect: 'Allow', Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], Principal: { AWS: { 'Fn::GetAtt': [expect.stringMatching(/^TaskRole/), 'Arn'] } },
    })])
  })

  it('e2e context keys only add the fault and idle env to the router (and are validated)', () => {
    const e2e = resolveSettings(ctx({ region: 'ap-southeast-1', account: '000000000000', e2eFault: 'pause-after-first-frame:330000', e2eIdleTimeoutMs: '420000' }), {}, DEFAULT_POLICY_FILE)
    const { template: t } = build(false, e2e)
    const env = Object.fromEntries(t.toJSON().Resources[Object.keys(t.toJSON().Resources).find((k) => t.toJSON().Resources[k].Type === 'AWS::ECS::TaskDefinition') as string]
      .Properties.ContainerDefinitions[0].Environment.map((x: any) => [x.Name, x.Value]))
    expect(env).toMatchObject({ ROUTER_FAULT_INJECT: 'pause-after-first-frame:330000', ROUTER_FAULT_INJECT_ALLOW: '1', ROUTER_STREAM_IDLE_TIMEOUT_MS: '420000' })
    expect(() => resolveSettings(ctx({ region: 'ap-southeast-1', account: '000000000000', e2eFault: 'drop-tables' }), {}, DEFAULT_POLICY_FILE)).toThrow(/e2eFault/)
    expect(resolveSettings(ctx({ region: 'ap-southeast-1', account: '000000000000', e2eFault: 'upstream-503-once:2' }), {}, DEFAULT_POLICY_FILE).e2e).toEqual({ fault: 'upstream-503-once:2' })
    expect(() => resolveSettings(ctx({ region: 'ap-southeast-1', account: '000000000000', e2eFault: 'upstream-503-once:0' }), {}, DEFAULT_POLICY_FILE)).toThrow(/e2eFault/)
  })

  it('assessor context keys: off by default; -c assessorMode=auto -c assessorAutoRules=all reaches the router env; no extra grant', () => {
    const c = (extra: Record<string, string>) => ctx({ region: 'ap-southeast-1', account: '000000000000', ...extra })
    expect(SETTINGS.assessor).toBeUndefined()
    const envOf = (t: Template) => Object.fromEntries(Object.values(t.toJSON().Resources as Record<string, any>).find((r) => r.Type === 'AWS::ECS::TaskDefinition')
      .Properties.ContainerDefinitions[0].Environment.map((x: any) => [x.Name, x.Value]))
    const off = envOf(template)
    expect(Object.keys(off).filter((k) => k.startsWith('ROUTER_ASSESSOR_'))).toEqual([])

    const auto = resolveSettings(c({ assessorMode: 'auto', assessorAutoRules: 'all' }), {}, DEFAULT_POLICY_FILE)
    expect(auto.assessor).toEqual({ mode: 'auto', autoRules: 'all' })
    expect(() => deployModels(auto)).not.toThrow()
    const { template: t } = build(false, auto)
    expect(envOf(t)).toMatchObject({ ROUTER_ASSESSOR_MODE: 'auto', ROUTER_ASSESSOR_AUTO_RULES: 'all' })
    expect(envOf(t).ROUTER_ASSESSOR_MODEL).toBeUndefined() // router default (Luna)
    // Same task-role policy as without the assessor: Luna is a Responses pool model already.
    const taskPolicy = (tt: Template) => JSON.stringify(Object.values(tt.toJSON().Resources as Record<string, any>)
      .filter((r) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties.Roles).includes('TaskRole')).map((r) => r.Properties.PolicyDocument))
    expect(taskPolicy(t)).toBe(taskPolicy(template))
    expect(taskPolicy(t)).toContain('gpt-6-luna')

    const full = resolveSettings(c({ assessorMode: 'observe', assessorModel: 'global.openai.gpt-6-luna', assessorThreshold: '0.85', assessorPack: 'v2.1', assessorTimeoutMs: '2000' }), {}, DEFAULT_POLICY_FILE)
    expect(assessorEnv(full.assessor)).toEqual({ ROUTER_ASSESSOR_MODE: 'observe', ROUTER_ASSESSOR_MODEL: 'global.openai.gpt-6-luna',
      ROUTER_ASSESSOR_THRESHOLD: '0.85', ROUTER_ASSESSOR_PACK: 'v2.1', ROUTER_ASSESSOR_TIMEOUT_MS: '2000' })
    expect(() => deployModels(full)).not.toThrow()
  })

  it('-c assessorHoldTiers reaches the router env as ROUTER_ASSESSOR_HOLD_TIERS, independent of assessorMode; unset = no env (core default)', () => {
    const c = (extra: Record<string, string>) => ctx({ region: 'ap-southeast-1', account: '0'.repeat(12), ...extra })
    const envOf = (t: Template) => Object.fromEntries(Object.values(t.toJSON().Resources as Record<string, any>).find((r) => r.Type === 'AWS::ECS::TaskDefinition')
      .Properties.ContainerDefinitions[0].Environment.map((x: any) => [x.Name, x.Value]))
    expect(envOf(template).ROUTER_ASSESSOR_HOLD_TIERS).toBeUndefined()
    const old = resolveSettings(c({ assessorHoldTiers: 'fast, standard,frontier' }), {}, DEFAULT_POLICY_FILE)
    expect(old.assessorHoldTiers).toBe('fast,standard,frontier')
    expect(envOf(build(false, old).template).ROUTER_ASSESSOR_HOLD_TIERS).toBe('fast,standard,frontier')
    expect(resolveSettings(c({ assessorHoldTiers: 'none' }), {}, DEFAULT_POLICY_FILE).assessorHoldTiers).toBe('none')
    expect(() => resolveSettings(c({ assessorHoldTiers: 'fast,huge' }), {}, DEFAULT_POLICY_FILE)).toThrow(/assessorHoldTiers/)
  })

  it("the default assessor pack is a shipped pack and matches the assessor's defaultPackName", () => {
    expect(ASSESSOR_DEFAULT_PACK).toBe('v2.5')
    expect(JSON.parse(readFileSync(`${ASSESSOR_PACKS_DIR}${ASSESSOR_DEFAULT_PACK}/pack.json`, 'utf8')).id).toBe(`assessor/${ASSESSOR_DEFAULT_PACK}`)
    const src = readFileSync(new URL('../../packages/assessor/src/pack.ts', import.meta.url), 'utf8')
    expect(src).toContain(`export const defaultPackName: PackName = '${ASSESSOR_DEFAULT_PACK}'`)
  })

  it('assessor settings are validated (formats at resolve, model / pack / auto-eligibility at deployModels)', () => {
    const c = (extra: Record<string, string>) => ctx({ region: 'ap-southeast-1', account: '000000000000', ...extra })
    expect(() => resolveSettings(c({ assessorMode: 'on' }), {}, DEFAULT_POLICY_FILE)).toThrow(/assessorMode/)
    expect(() => resolveSettings(c({ assessorAutoRules: 'all' }), {}, DEFAULT_POLICY_FILE)).toThrow(/only with -c assessorMode/)
    expect(() => resolveSettings(c({ assessorMode: 'observe', assessorThreshold: '2' }), {}, DEFAULT_POLICY_FILE)).toThrow(/assessorThreshold/)
    expect(() => resolveSettings(c({ assessorMode: 'observe', assessorAutoRules: 'some' }), {}, DEFAULT_POLICY_FILE)).toThrow(/assessorAutoRules/)
    expect(() => resolveSettings(c({ assessorMode: 'observe', assessorTimeoutMs: '50' }), {}, DEFAULT_POLICY_FILE)).toThrow(/assessorTimeoutMs/)
    // auto with the pack's own flags: the default pack (v2.2) has no auto rule, so it could never act.
    expect(() => deployModels(resolveSettings(c({ assessorMode: 'auto' }), {}, DEFAULT_POLICY_FILE))).toThrow(/could never act/)
    expect(() => deployModels(resolveSettings(c({ assessorMode: 'observe', assessorPack: 'v9' }), {}, DEFAULT_POLICY_FILE))).toThrow(/no shipped pack/)
    expect(() => deployModels(resolveSettings(c({ assessorMode: 'observe', assessorModel: 'global.openai.no-such-model' }), {}, DEFAULT_POLICY_FILE))).toThrow(/assessorModel 'global.openai.no-such-model' is not in the shipped model metadata/)
    // A catalog model outside the policy pools would need a grant the stack does not make.
    const lunaless = JSON.stringify({ ...JSON.parse(readFileSync(DEFAULT_POLICY_FILE, 'utf8')), pools: { 'openai-responses': { defaultTier: 'standard', models: [{ model: 'global.openai.gpt-6.1-sol' }] } } })
    const s = resolveSettings(c({ assessorMode: 'observe', policyFile: '/virtual/policy.json' }), {}, DEFAULT_POLICY_FILE)
    expect(() => deployModels(s, (p) => (p === '/virtual/policy.json' ? lunaless : readFileSync(p, 'utf8')))).toThrow(/not one of the router's policy models/)
  })

  it('us-west-2 has default AZ IDs and its bundled catalog covers the default policy and the catalog universe', () => {
    const s = resolveSettings(ctx({ region: 'us-west-2', account: '000000000000', allowedModelUniverse: 'catalog' }), {}, DEFAULT_POLICY_FILE)
    expect(s.azIds).toEqual(['usw2-az1', 'usw2-az2'])
    expect(() => deployModels(s)).not.toThrow()
  })

  it('names follow the prefix, subnets use the AZ IDs, and the router gets the region and the validated policy', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', { Name: 'llmar-gw' })
    expect(ofType('AWS::EC2::Subnet').map(([, r]) => r.Properties?.AvailabilityZoneId).sort()).toEqual(['apse1-az1', 'apse1-az2'])
    const env = Object.fromEntries(ofType('AWS::ECS::TaskDefinition')[0]?.[1].Properties?.ContainerDefinitions[0].Environment.map((e: any) => [e.Name, e.Value]))
    expect(env.ROUTER_REGION).toBe('ap-southeast-1')
    expect(JSON.parse(env.ROUTER_POLICY_JSON).version).toBe(MODELS.policy.version)
  })

  it('gateway: CUSTOM_JWT with the M2M client and scope; router target signs execute-api through the VPCE routing domain', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', { Name: 'llmar-gw', AuthorizerType: 'CUSTOM_JWT' })
    const gw = ofType('AWS::BedrockAgentCore::Gateway')[0]?.[1].Properties
    expect(gw?.AuthorizerConfiguration.CustomJWTAuthorizer.AllowedScopes).toEqual(['llmar/invoke'])
    const router = ofType('AWS::BedrockAgentCore::GatewayTarget').find(([, r]) => r.Properties?.Name === 'router')?.[1].Properties
    expect(router?.CredentialProviderConfigurations[0].CredentialProvider.IamCredentialProvider).toEqual({ Service: 'execute-api', Region: 'ap-southeast-1' })
    expect(JSON.stringify(router?.TargetConfiguration.Inference.Provider.Endpoint)).toContain('.execute-api.ap-southeast-1.amazonaws.com')
    expect(router?.PrivateEndpoint.ManagedVpcResource.RoutingDomain).toBeDefined()
    expect(router?.PrivateEndpoint.ManagedVpcResource.Tags).toEqual(SETTINGS.tags)
    expect(router?.MetadataConfiguration.AllowedRequestHeaders).toEqual(REQUEST_HEADERS)
    expect(REQUEST_HEADERS.length).toBeLessThanOrEqual(10)
    expect(REQUEST_HEADERS.some((h) => h.startsWith('x-amz') || h === 'x-router-caller-arn' || h === 'x-router-source-vpce')).toBe(false)
  })

  it('fails closed for auto aliases and concrete models: every rule routes only to the router, with no fallback or direct Bedrock target', () => {
    const rules = ofType('AWS::BedrockAgentCore::GatewayRule').map(([, r]) => r.Properties)
    expect(rules).toHaveLength(2)
    const auto = rules.find((r) => r?.Priority === RULE_PRIORITY.auto)
    expect(auto?.Conditions[0].MatchModels.AnyOf.map((m: any) => m.Value)).toEqual(['auto', 'auto:*'])
    for (const rule of rules) {
      expect(rule?.Actions).toEqual([{ RouteToTarget: { StaticRoute: { TargetName: 'router' } } }])
      expect(rule?.Actions[0].RouteToTarget.StaticRoute.Fallback).toBeUndefined()
    }
    const targets = ofType('AWS::BedrockAgentCore::GatewayTarget').map(([, r]) => r.Properties)
    expect(targets.map((t) => t?.Name)).toEqual(['router'])
    expect(targets[0]?.TargetConfiguration.Inference.Provider.Operations.map((o: any) => o.Path))
      .toEqual(['/v1/messages', '/v1/chat/completions', '/v1/responses'])
    expect(JSON.stringify(targets)).not.toContain('bedrock-runtime')
  })

  it('container binds 0.0.0.0 inside awsvpc with no host port, hop auth apigw-iam, 10 MiB cap, desired count 0 by default', () => {
    const c = ofType('AWS::ECS::TaskDefinition')[0]?.[1].Properties?.ContainerDefinitions[0]
    expect(c.PortMappings).toEqual([{ AppProtocol: 'http', ContainerPort: 8080, Name: 'http', Protocol: 'tcp' }])
    const env = Object.fromEntries(c.Environment.map((e: any) => [e.Name, e.Value]))
    expect(env).toMatchObject({ ROUTER_BIND: '0.0.0.0', ROUTER_HOP_AUTH: 'apigw-iam', ROUTER_MAX_BODY_BYTES: String(10 * 1024 * 1024) })
    expect(env.ROUTER_API_VPCE_ID).toBeDefined()
    expect(env.ROUTER_INBOUND_TEST_BYPASS).toBeUndefined()
    expect(env.ROUTER_FAULT_INJECT).toBeUndefined() // only with -c e2eFault
    expect(c.ReadonlyRootFilesystem).toBe(true)
    template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 0, LoadBalancers: [{ ContainerName: 'router', ContainerPort: 8080 }] })
  })

  it('every taggable resource carries Project/Owner/Purpose, and nothing is retained', () => {
    const want = { Project: 'llm-auto-router', Owner: 'test-owner', Purpose: 'mvp' }
    for (const [id, r] of Object.entries(resources)) {
      expect(r.DeletionPolicy ?? 'Delete', id).not.toBe('Retain')
      expect(r.UpdateReplacePolicy ?? 'Delete', id).not.toBe('Retain')
      const tags = r.Properties?.Tags ?? r.Properties?.UserPoolTags
      if (!tags) continue
      const map = Array.isArray(tags) ? Object.fromEntries(tags.map((t: any) => [t.Key, t.Value])) : tags
      expect(map, id).toMatchObject(want)
    }
    for (const t of ['AWS::EC2::VPC', 'AWS::ECS::Service', 'AWS::ApiGateway::RestApi', 'AWS::BedrockAgentCore::Gateway', 'AWS::IAM::Role', 'AWS::Logs::LogGroup']) {
      // The CDK auto-delete-objects provider role (config bucket teardown) is a framework CfnResource that takes no tags.
      for (const [id, r] of ofType(t)) if (!id.startsWith('CustomS3AutoDeleteObjects')) expect(r.Properties?.Tags, `${t} ${id}`).toBeTruthy()
    }
  })

  it('outputs carry no secrets', () => {
    const outs = JSON.stringify(template.toJSON().Outputs)
    expect(outs).not.toMatch(/ClientSecret|secret/i)
  })
})

describe('admin console identity (spike C1 decisions)', () => {
  it('every client with refresh token rotation sets no explicit auth flows (Cognito refuses ALLOW_REFRESH_TOKEN_AUTH with rotation)', () => {
    const rotating = ofType('AWS::Cognito::UserPoolClient').filter(([, c]) => c.Properties?.RefreshTokenRotation?.Feature === 'ENABLED')
    expect(rotating.length).toBeGreaterThan(0)
    for (const [id, c] of rotating) expect(c.Properties?.ExplicitAuthFlows ?? [], id).toEqual([])
  })
  const props = (type: string) => ofType(type).map(([, r]) => r.Properties ?? {})
  const target = (name: string) => props('AWS::BedrockAgentCore::GatewayTarget').find((t) => t.Name === name)

  it('the only gateway target forwards x-api-key (10th header) for router identity checks', () => {
    expect(REQUEST_HEADERS).toHaveLength(10)
    expect(REQUEST_HEADERS.at(-1)).toBe('x-api-key')
    expect(target('router')?.MetadataConfiguration.AllowedRequestHeaders).toContain('x-api-key')
    expect(target('bedrock')).toBeUndefined()
  })

  it('the router gateway target waits for the ECS service (model discovery must hit the new image, not the old one)', () => {
    const raw = resources as Record<string, { Type: string; DependsOn?: string | string[] }>
    const svc = Object.entries(raw).find(([, r]) => r.Type === 'AWS::ECS::Service')?.[0] as string
    const targets = Object.entries(raw).filter(([, r]) => r.Type === 'AWS::BedrockAgentCore::GatewayTarget')
    expect(targets).toHaveLength(1)
    for (const [, t] of targets) expect([t.DependsOn ?? []].flat()).toContain(svc)
  })

  it('gateway authorizer is scope-only (no allowedClients); a catch-all rule sends every other model id to the router', () => {
    const jwt = props('AWS::BedrockAgentCore::Gateway')[0]?.AuthorizerConfiguration.CustomJWTAuthorizer
    expect(jwt.AllowedClients).toBeUndefined()
    expect(jwt.AllowedScopes).toEqual(['llmar/invoke'])
    const rules = props('AWS::BedrockAgentCore::GatewayRule')
    expect(rules.map((r) => r.Priority).sort((a, b) => a - b)).toEqual([RULE_PRIORITY.auto, RULE_PRIORITY.catchAll])
    const catchAll = rules.find((r) => r.Priority === RULE_PRIORITY.catchAll)
    expect(catchAll?.Conditions).toBeUndefined()
    expect(catchAll?.Actions).toEqual([{ RouteToTarget: { StaticRoute: { TargetName: 'router' } } }])
  })

  it('pool: MFA off (deployer decision, matches the live pool), e-mail recovery, invoke + console scopes; cli client: PKCE on 127.0.0.1, 30-min tokens, rotation, branding', () => {
    const pool = props('AWS::Cognito::UserPool')[0]
    expect(pool?.MfaConfiguration ?? 'OFF').toBe('OFF')
    expect(pool?.EnabledMfas).toBeUndefined()
    expect(pool?.AccountRecoverySetting).toEqual({ RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] })
    expect(pool?.AdminCreateUserConfig.AllowAdminCreateUserOnly).toBe(true)
    expect(props('AWS::Cognito::UserPoolResourceServer')[0]?.Scopes.map((x: { ScopeName: string }) => x.ScopeName)).toEqual(['invoke', 'console'])
    const cli = props('AWS::Cognito::UserPoolClient').find((c) => c.ClientName === 'llmar-cli')
    expect(cli).toMatchObject({ GenerateSecret: false, AllowedOAuthFlows: ['code'], AccessTokenValidity: 60, IdTokenValidity: 60, EnableTokenRevocation: true,
      RefreshTokenRotation: { Feature: 'ENABLED', RetryGracePeriodSeconds: 30 } })
    expect(cli?.CallbackURLs).toEqual([52817, 52818, 52819, 52820].map((p) => `http://127.0.0.1:${p}/callback`))
    expect(JSON.stringify(cli?.AllowedOAuthScopes)).not.toContain('console')
    expect(props('AWS::Cognito::ManagedLoginBranding')).toHaveLength(1)
    expect(props('AWS::Cognito::UserPoolDomain')[0]?.ManagedLoginVersion).toBe(2)
  })

  it('config bucket: private; the router reads config/active.json and identity/* only, and only through the S3 gateway endpoint', () => {
    const b = props('AWS::S3::Bucket')[0]
    expect(b?.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true })
    expect(b?.VersioningConfiguration).toEqual({ Status: 'Enabled' })
    const stmts = props('AWS::S3::BucketPolicy').flatMap((p) => p.PolicyDocument.Statement as Array<Record<string, any>>)
    const deny = stmts.find((x) => x.Sid === 'RouterViaEndpointOnly')
    expect(deny?.Effect).toBe('Deny')
    expect(JSON.stringify(deny?.Condition)).toContain('aws:SourceVpce')
    const task = ofType('AWS::IAM::Policy').find(([id]) => id.startsWith('TaskRole'))?.[1].Properties?.PolicyDocument.Statement as Array<Record<string, any>>
    const s3 = task.filter((st) => [st.Action].flat().some((a: string) => a.startsWith('s3:')))
    expect(s3.flatMap((st) => [st.Action].flat()).sort()).toEqual(['s3:GetObject', 's3:ListBucket'])
    expect(JSON.stringify(s3)).toMatch(/config\/active\.json/)
    expect(JSON.stringify(s3)).toMatch(/identity\/\*/)
  })

  it('router env: config bucket, model universe and identity (env default observe, x-api-key, pool issuer, invoke scope)', () => {
    const env = Object.fromEntries((props('AWS::ECS::TaskDefinition')[0]?.ContainerDefinitions[0].Environment as Array<{ Name: string; Value: unknown }>).map((e) => [e.Name, e.Value]))
    expect(env.ROUTER_IDENTITY_MODE).toBe('observe')
    expect(env.ROUTER_IDENTITY_HEADER).toBe('x-api-key')
    expect(env.ROUTER_IDENTITY_SCOPE).toBe('llmar/invoke')
    expect(JSON.stringify(env.ROUTER_IDENTITY_ISSUER)).toContain('cognito-idp.')
    expect(JSON.stringify(env.ROUTER_CONFIG_BUCKET)).toContain('Config')
    expect(env.ROUTER_MODEL_UNIVERSE).toBe(MODELS.routerModels.join(','))
  })

  it('jwks-sync: every 5 minutes, outside the VPC, writes identity/jwks.json only', () => {
    const fn = props('AWS::Lambda::Function').find((f) => f.FunctionName === 'llmar-jwks-sync')
    expect(fn?.VpcConfig).toBeUndefined()
    expect(fn?.Environment.Variables.KEY).toBe('identity/jwks.json')
    expect(props('AWS::Events::Rule').find((r) => r.Name === 'llmar-jwks-sync')?.ScheduleExpression).toBe('rate(5 minutes)')
    const pol = ofType('AWS::IAM::Policy').find(([id]) => id.startsWith('JwksSyncRole'))?.[1].Properties?.PolicyDocument.Statement as Array<Record<string, any>>
    const writes = pol.filter((st) => [st.Action].flat().includes('s3:PutObject'))
    expect(JSON.stringify(writes.map((w) => w.Resource))).toMatch(/identity\/jwks\.json"\]/)
    expect(JWKS_SYNC_CODE).not.toMatch(/console\.log\([^)]*(body|doc|n:)/)
  })

  it('packs archive: uploaded to the config bucket root without pruning (older images\' packs stay); cdk-nag clean', () => {
    const t = build(false, SETTINGS, packsFixture()).template.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, any> }>
    const dep = Object.values(t).filter((r) => r.Type === 'Custom::CDKBucketDeployment')
    expect(dep).toHaveLength(1)
    expect(dep[0]?.Properties?.Prune).toBe(false)
    expect(dep[0]?.Properties?.DestinationBucketKeyPrefix).toBeUndefined()
    expect(JSON.stringify(dep[0]?.Properties?.DestinationBucketName)).toContain('Config')
    expect(dep[0]?.Properties?.SourceObjectKeys).toHaveLength(4) // packs archive + baked.json + baked/<version>.json + providers/active.json (empty registry)
    // No archive dir (-c packsArchive=off): the same deployment still stages the baked document.
    const [, only] = ofType('Custom::CDKBucketDeployment')[0] as [string, { Properties?: Record<string, any> }]
    expect(only.Properties?.SourceObjectKeys).toHaveLength(3) // baked.json, baked/<version>.json, providers/active.json
    expect(ofType('Custom::CDKBucketDeployment')).toHaveLength(1)
    expect(() => build(true, SETTINGS, packsFixture()).app.synth()).not.toThrow()
  })

  it('packs archive: the deployment Lambda may write only under packs/ (bucket-policy Deny); no other role is affected', () => {
    const t = build(false, SETTINGS, packsFixture()).template.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, any> }>
    const stmts = Object.values(t).filter((r) => r.Type === 'AWS::S3::BucketPolicy').flatMap((p) => p.Properties?.PolicyDocument.Statement as Array<Record<string, any>>)
    const deny = stmts.find((x) => x.Sid === 'PacksDeploymentOnlyUnderPacks')
    expect(deny?.Effect).toBe('Deny')
    expect([deny?.Action].flat().sort()).toEqual(['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObject', 's3:PutObjectAcl'])
    const notRes = JSON.stringify(deny?.NotResource)
    expect(notRes).toMatch(/\/packs\/\*"/)
    expect(notRes).toMatch(/\/config\/baked\.json"/)
    expect(notRes).toMatch(/\/config\/baked\/\*"/)
    expect(deny?.NotResource).toHaveLength(4) // packs/*, baked.json, baked/*, providers/active.json: never config/active.json, config/versions/* or identity/*
    expect(deny?.Resource).toBeUndefined()
    // The only principal is the BucketDeployment handler role, never the task, jwks-sync or auto-delete roles.
    const principal = JSON.stringify(deny?.Principal)
    expect(principal).toContain('CustomCDKBucketDeployment')
    for (const other of ['TaskRole', 'JwksSyncRole', 'CustomS3AutoDeleteObjects']) expect(principal).not.toContain(other)
    // Every Deny in the bucket policy names exactly one principal; the auto-delete role is only ever allowed.
    for (const s of stmts.filter((x) => x.Effect === 'Deny' && x.Principal !== '*')) expect([s.Principal.AWS].flat()).toHaveLength(1)
    const autoDelete = stmts.filter((x) => JSON.stringify(x.Principal).includes('CustomS3AutoDeleteObjects'))
    expect(autoDelete.length).toBeGreaterThan(0)
    for (const s of autoDelete) expect(s.Effect).toBe('Allow')
  })

  it('baked config document: the staged config/baked.json is what the router computes at boot from the same task env', () => {
    const fromEnv = (b: ReturnType<typeof build>) => {
      const [, td] = Object.entries(b.template.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, any> }>)
        .find(([, r]) => r.Type === 'AWS::ECS::TaskDefinition') as [string, { Properties?: Record<string, any> }]
      return Object.fromEntries((td.Properties?.ContainerDefinitions[0].Environment as Array<{ Name: string; Value: unknown }>).map((e) => [e.Name, e.Value]))
    }
    const staged = (b: ReturnType<typeof build>) => {
      // Source.data stages each object as a directory asset in the cloud assembly: read what will be uploaded.
      const out = b.app.synth().directory
      const found = readdirSync(out).filter((d) => d.startsWith('asset.')).flatMap((d) =>
        ['config/baked.json', `config/baked/${b.stack.baked.version}.json`].filter((k) => existsSync(join(out, d, k))).map((k) => [k, readFileSync(join(out, d, k), 'utf8')]))
      return Object.fromEntries(found) as Record<string, string>
    }
    const TEST_GATEWAY_ROLE = 'arn:aws:iam::000000000000:role/llmar-gateway-role'
    /** The router's side (main.ts): loadConfig of the task env, the image's packs, bakedConfigDocument. */
    const routerBaked = (env: Record<string, unknown>) => {
      const literal = Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      // Deploy-time tokens (ARNs, ids) are not baked inputs: placeholders of a valid shape for loadConfig.
      const bootEnv: Record<string, string> = { ...literal, ROUTER_CONFIG_BUCKET: 'llmar-config-test',
        ROUTER_IDENTITY_ISSUER: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_Example1', ROUTER_GATEWAY_ROLE_ARN: TEST_GATEWAY_ROLE,
        ROUTER_GATEWAY_ARN: 'arn:aws:bedrock-agentcore:ap-southeast-1:000000000000:gateway/llmar-gw-abc123', ROUTER_API_VPCE_ID: 'vpce-0123456789abcdef0' } // gitleaks:allow
      const config = loadConfig(bootEnv)
      return bakedConfigDocument({ policy: config.policy, env: bootEnv, packs: packInfos(config.packs ?? new Map()) }, (t) => createHash('sha256').update(t).digest('hex'))
    }
    const assessed = resolveSettings(ctx({ region: 'ap-southeast-1', account: '000000000000', identityMode: 'require', assessorMode: 'observe', assessorThreshold: '0.7' }), {}, DEFAULT_POLICY_FILE)
    const versions = new Set<string>()
    for (const b of [build(), build(false, assessed, packsFixture())]) {
      const env = fromEnv(b)
      const files = staged(b)
      expect(Object.keys(files).sort()).toEqual(['config/baked.json', `config/baked/${b.stack.baked.version}.json`].sort())
      expect(files['config/baked.json']).toBe(b.stack.baked.json)
      expect(files[`config/baked/${b.stack.baked.version}.json`]).toBe(b.stack.baked.json)
      const doc = JSON.parse(files['config/baked.json'] as string) as Record<string, any>
      // Same version and content as the router's generation 0 (seq is a runtime field, not staged).
      const { seq, ...routerDoc } = routerBaked(env)
      expect(seq).toBe(0)
      expect(doc).not.toHaveProperty('seq')
      expect(doc.version).toBe(routerDoc.version)
      expect(doc).toEqual(JSON.parse(JSON.stringify(routerDoc)))
      // And the fields the console shows, against the env directly.
      expect(doc.identity).toEqual({ mode: env.ROUTER_IDENTITY_MODE })
      expect(doc.policy).toEqual(JSON.parse(env.ROUTER_POLICY_JSON as string))
      expect(doc.access).toEqual({ groups: {} })
      expect(doc.assessor.mode).toBe(env.ROUTER_ASSESSOR_MODE ?? 'off')
      if (env.ROUTER_ASSESSOR_THRESHOLD !== undefined) expect(doc.assessor.threshold).toBe(Number(env.ROUTER_ASSESSOR_THRESHOLD))
      // The preset admin rules ride along whenever the assessor is on (observe state; the router's env assessor runs them too).
      if (doc.assessor.mode !== 'off') expect(doc.assessor.customRules.map((r: { id: string; state: string }) => [r.id, r.state])).toEqual([['x-visual-creative', 'observe']])
      else expect(doc.assessor).not.toHaveProperty('customRules')
      versions.add(doc.version)
    }
    expect(versions.size).toBe(2) // the version follows the content
  })

  it('publishes the console stack values as SSM parameters under /<prefix>/router/', () => {
    const names = props('AWS::SSM::Parameter').map((p) => p.Name).sort()
    expect(names).toEqual((Object.keys(ROUTER_PARAMS) as Array<keyof typeof ROUTER_PARAMS>).map((k) => routerParamName('llmar', k)).sort())

    // The Codex gateway_oauth callback port (Get started fills redirect_port from it; the CLI ports exclude it).
    const value = (k: keyof typeof ROUTER_PARAMS) => props('AWS::SSM::Parameter').find((p) => p.Name === routerParamName('llmar', k))?.Value
    expect(value('codexOauthPort')).toBe('52820')
    expect(value('callbackPorts')).toBe('52817,52818,52819')
  })
})

describe('router state store (-c stateStore) and graceful stop', () => {
  type Res = typeof resources
  const c = (extra: Record<string, string>) => ctx({ region: 'ap-southeast-1', account: '000000000000', tags: '{"Owner":"test-owner"}', ...extra })
  const STATEFUL = resolveSettings(c({ stateStore: 'dynamodb', routerDesiredCount: '2' }), {}, DEFAULT_POLICY_FILE)
  const statefulBuild = build(false, STATEFUL)
  const stateful = statefulBuild.template.toJSON() as { Resources: Res; Parameters: Record<string, Record<string, unknown>>; Outputs: Record<string, unknown> }
  const memory = template.toJSON() as typeof stateful
  const of = (res: Res, t: string) => Object.entries(res).filter(([, r]) => r.Type === t)
  const container = (res: Res) => of(res, 'AWS::ECS::TaskDefinition')[0]?.[1].Properties?.ContainerDefinitions[0]
  const envOf = (res: Res) => Object.fromEntries((container(res).Environment as Array<{ Name: string; Value: unknown }>).map((e) => [e.Name, e.Value]))
  const endpoint = (res: Res, service: string) => of(res, 'AWS::EC2::VPCEndpoint').filter(([, r]) => JSON.stringify(r.Properties?.ServiceName).includes(`.${service}"`))
  const routerEgress = (res: Res) => {
    const sg = of(res, 'AWS::EC2::SecurityGroup').find(([, r]) => r.Properties?.GroupName === 'llmar-router')?.[0] as string
    return of(res, 'AWS::EC2::SecurityGroupEgress').map(([, r]) => r.Properties ?? {}).filter((r) => JSON.stringify(r.GroupId).includes(sg))
  }
  /** Every statement with a DynamoDB action, in any IAM policy of the template (inline, managed, role-embedded). */
  const ddbStatements = (res: Res) => Object.entries(res).filter(([, r]) => r.Type.startsWith('AWS::IAM::'))
    .flatMap(([id, r]) => [r.Properties?.PolicyDocument, ...(r.Properties?.Policies ?? []).map((x: any) => x.PolicyDocument)].filter(Boolean)
      .flatMap((d: any) => d.Statement as Array<Record<string, any>>).filter((st) => [st.Action].flat().some((a: string) => a.startsWith('dynamodb:'))).map((st) => [id, st] as const))
  const tableId = of(stateful.Resources, 'AWS::DynamoDB::Table')[0]?.[0] as string
  const endpointId = endpoint(stateful.Resources, 'dynamodb')[0]?.[0] as string

  it('settings: memory by default, dynamodb is opt-in; other values are refused, and so is more than one task on memory', () => {
    expect(SETTINGS.stateStore).toBe('memory')
    expect(resolveSettings(c({ stateStore: 'memory', routerDesiredCount: '1' }), {}, DEFAULT_POLICY_FILE)).toMatchObject({ stateStore: 'memory', desiredCount: 1 })
    expect(resolveSettings(c({ stateStore: 'dynamodb' }), {}, DEFAULT_POLICY_FILE)).toMatchObject({ stateStore: 'dynamodb', desiredCount: 0 })
    expect(STATEFUL).toMatchObject({ stateStore: 'dynamodb', desiredCount: 2 })
    expect(() => resolveSettings(c({ stateStore: 'redis' }), {}, DEFAULT_POLICY_FILE)).toThrow(/stateStore: 'memory' \| 'dynamodb', got 'redis'/)
    expect(() => resolveSettings(c({ stateStore: 'DynamoDB' }), {}, DEFAULT_POLICY_FILE)).toThrow(/stateStore: 'memory' \| 'dynamodb'/)
    for (const extra of [{ routerDesiredCount: '2' }, { routerDesiredCount: '3', stateStore: 'memory' }] as Array<Record<string, string>>) {
      expect(() => resolveSettings(c(extra), {}, DEFAULT_POLICY_FILE))
        .toThrow(/routerDesiredCount: \d tasks need -c stateStore=dynamodb .*each keep their own routing state: a lineage's requests would land on different tasks and lose cache stickiness/)
    }
    // An unknown store is reported once, not as the task-count rule too.
    const both = (() => { try { resolveSettings(c({ stateStore: 'redis', routerDesiredCount: '2' }), {}, DEFAULT_POLICY_FILE); return '' } catch (e) { return (e as Error).message } })()
    expect(both).toMatch(/stateStore: 'memory' \| 'dynamodb', got 'redis'/)
    expect(both).not.toMatch(/tasks need/)
  })

  it('memory (default): no table, no DynamoDB endpoint, no parameter, no egress rule, no grant, no env, no output', () => {
    expect(of(memory.Resources, 'AWS::DynamoDB::Table')).toHaveLength(0)
    expect(endpoint(memory.Resources, 'dynamodb')).toHaveLength(0)
    expect(Object.keys(memory.Parameters).filter((k) => k.includes('PrefixList'))).toEqual(['S3PrefixListId'])
    expect(routerEgress(memory.Resources).map((r) => r.DestinationPrefixListId).filter(Boolean)).toEqual([{ Ref: 'S3PrefixListId' }])
    expect(ddbStatements(memory.Resources)).toEqual([])
    expect(envOf(memory.Resources).ROUTER_STATE_TABLE).toBeUndefined()
    expect(memory.Outputs.StateTableName).toBeUndefined()
    expect(JSON.stringify(memory)).not.toMatch(/dynamodb/i)
  })

  it('dynamodb: table <prefix>-router-state keyed by pk, on demand, TTL on exp, default encryption, no stream, no PITR, deleted with the stack', () => {
    const tables = of(stateful.Resources, 'AWS::DynamoDB::Table')
    expect(tables).toHaveLength(1)
    const table = tables[0]?.[1]
    // Exact: no SSESpecification (the default AWS owned key), no StreamSpecification, no sort key, no index.
    expect(table?.Properties).toEqual({
      TableName: 'llmar-router-state', AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST', TimeToLiveSpecification: { AttributeName: 'exp', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false }, DeletionProtectionEnabled: false,
      Tags: expect.arrayContaining([{ Key: 'Owner', Value: 'test-owner' }, { Key: 'Project', Value: 'llm-auto-router' }]),
    })
    expect([table?.DeletionPolicy, table?.UpdateReplacePolicy]).toEqual(['Delete', 'Delete'])
  })

  it('dynamodb: a gateway endpoint on the isolated subnets\' route tables; its policy admits only the task role, the three item actions, this table', () => {
    expect(endpoint(stateful.Resources, 'dynamodb')).toHaveLength(1)
    expect(of(stateful.Resources, 'AWS::EC2::VPCEndpoint')).toHaveLength(of(memory.Resources, 'AWS::EC2::VPCEndpoint').length + 1)
    const ep = stateful.Resources[endpointId]?.Properties
    expect(ep?.VpcEndpointType).toBe('Gateway')
    expect(ep?.RouteTableIds).toHaveLength(2)
    expect(ep?.RouteTableIds).toEqual(endpoint(stateful.Resources, 's3')[0]?.[1].Properties?.RouteTableIds)
    // Gateway endpoint policies: Principal "*", the principal named with aws:PrincipalArn (the role ARN spelled out: no cycle with the boundary).
    expect(ep?.PolicyDocument.Statement).toEqual([{ Effect: 'Allow', Principal: '*', Action: [...STATE_TABLE_ACTIONS], Resource: { 'Fn::GetAtt': [tableId, 'Arn'] },
      Condition: { ArnEquals: { 'aws:PrincipalArn': { 'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'AWS::AccountId' }, ':role/llmar-router-task']] } } } }])
    expect(of(stateful.Resources, 'AWS::IAM::Role').filter(([, r]) => r.Properties?.RoleName === 'llmar-router-task')).toHaveLength(1)
    expect(STATE_TABLE_ACTIONS).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'])
  })

  it('dynamodb: DynamoDbPrefixListId parameter (the shape of S3PrefixListId) and one more router egress rule, 443 to it', () => {
    expect(stateful.Parameters.DynamoDbPrefixListId).toEqual({ ...stateful.Parameters.S3PrefixListId,
      Description: 'com.amazonaws.ap-southeast-1.dynamodb managed prefix list (router state table)' })
    expect(stateful.Parameters.DynamoDbPrefixListId).toMatchObject({ Type: 'String', AllowedPattern: '^pl-[0-9a-f]+$' })
    expect(stateful.Parameters.DynamoDbPrefixListId?.Default).toBeUndefined()
    const egress = routerEgress(stateful.Resources)
    expect(egress).toHaveLength(routerEgress(memory.Resources).length + 1)
    for (const e of egress) expect([e.FromPort, e.ToPort]).toEqual([443, 443])
    expect(egress.filter((e) => JSON.stringify(e.DestinationPrefixListId) === '{"Ref":"DynamoDbPrefixListId"}')).toEqual([expect.objectContaining({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443 })])
  })

  it('dynamodb: the task role may use the three actions on the table through the endpoint only (its own policy); the boundary has the same statement', () => {
    const want = { Sid: 'StateStore', Effect: 'Allow', Action: [...STATE_TABLE_ACTIONS], Resource: { 'Fn::GetAtt': [tableId, 'Arn'] },
      Condition: { StringEquals: { 'aws:SourceVpce': { Ref: endpointId } } } }
    const found = ddbStatements(stateful.Resources)
    expect(found.map(([id]) => id.replace(/[0-9A-F]{8}$/, ''))).toEqual(['RouterBoundary', 'TaskRoleStateStore'])
    for (const [, st] of found) expect(st).toEqual(want)
    const policy = stateful.Resources[found[1]?.[0] as string]?.Properties
    expect(policy?.PolicyDocument.Statement).toEqual([want])
    expect(policy?.Roles).toEqual([{ Ref: expect.stringMatching(/^TaskRole/) }])
    // The role's other policies and the rest of the boundary are what they are with memory.
    for (const [id, r] of [...of(memory.Resources, 'AWS::IAM::Policy'), ...of(memory.Resources, 'AWS::IAM::ManagedPolicy')]) {
      const now = stateful.Resources[id]?.Properties?.PolicyDocument.Statement as unknown[]
      expect(id.startsWith('RouterBoundary') ? now.slice(0, -1) : now, id).toEqual(r.Properties?.PolicyDocument.Statement)
    }
  })

  it('dynamodb: ROUTER_STATE_TABLE names the table, the service waits for the endpoint and the grant, the table name is an output; cdk-nag clean', () => {
    expect(envOf(stateful.Resources).ROUTER_STATE_TABLE).toEqual({ Ref: tableId })
    const svc = of(stateful.Resources, 'AWS::ECS::Service')[0]?.[1] as { DependsOn?: string[]; Properties?: Record<string, any> }
    expect(svc.Properties?.DesiredCount).toBe(2)
    expect(svc.DependsOn).toEqual(expect.arrayContaining([endpointId, ddbStatements(stateful.Resources)[1]?.[0]]))
    expect(stateful.Outputs.StateTableName).toEqual({ Value: { Ref: tableId } })
    // Neither the table name nor the grace period is an input of the baked config document.
    expect(statefulBuild.stack.baked.json).toBe(build().stack.baked.json)
    expect(() => build(true, STATEFUL).app.synth()).not.toThrow()
  })

  it('graceful stop (both modes): stopTimeout is the Fargate maximum, the router\'s grace is 15 s less, the NLB keeps its 30 s delay and never cuts connections', () => {
    expect(STOP_TIMEOUT_S).toBe(120)
    expect(SHUTDOWN_MARGIN_S).toBe(15)
    expect(SHUTDOWN_GRACE_MS).toBe((STOP_TIMEOUT_S - SHUTDOWN_MARGIN_S) * 1000)
    expect(DEREGISTRATION_DELAY_S).toBe(30)
    for (const res of [memory.Resources, stateful.Resources]) {
      expect(container(res).StopTimeout).toBe(120)
      expect(envOf(res).ROUTER_SHUTDOWN_GRACE_MS).toBe('105000')
      expect(of(res, 'AWS::ElasticLoadBalancingV2::TargetGroup')[0]?.[1].Properties?.TargetGroupAttributes).toEqual([
        { Key: 'deregistration_delay.timeout_seconds', Value: '30' }, { Key: 'deregistration_delay.connection_termination.enabled', Value: 'false' }])
      // Unchanged: rolling deploy shape, circuit breaker, health check.
      const svc = of(res, 'AWS::ECS::Service')[0]?.[1].Properties
      expect(svc?.DeploymentConfiguration).toMatchObject({ MinimumHealthyPercent: 100, MaximumPercent: 200, DeploymentCircuitBreaker: { Enable: true, Rollback: true } })
      expect(svc?.HealthCheckGracePeriodSeconds).toBe(30)
      expect(of(res, 'AWS::ElasticLoadBalancingV2::TargetGroup')[0]?.[1].Properties).toMatchObject({
        HealthCheckPath: '/healthz', HealthCheckProtocol: 'HTTP', HealthCheckIntervalSeconds: 10, HealthyThresholdCount: 2, UnhealthyThresholdCount: 2 })
    }
  })
})

describe('router autoscaling (-c routerAutoscale)', () => {
  const c = (extra: Record<string, string>) => ctx({ region: 'ap-southeast-1', account: '000000000000', tags: '{"Owner":"test-owner"}', ...extra })
  const settings = (extra: Record<string, string>) => resolveSettings(c(extra), {}, DEFAULT_POLICY_FILE)
  const error = (extra: Record<string, string>) => { try { settings(extra); return '' } catch (e) { return (e as Error).message } }
  const SCALED = settings({ stateStore: 'dynamodb', routerAutoscale: '2,4' })
  type Res = Record<string, { Type: string; Properties?: Record<string, any> }>
  const res = build(false, SCALED).template.toJSON().Resources as Res
  const of = (r: Res, t: string) => Object.entries(r).filter(([, x]) => x.Type === t)

  it('settings: off by default; <min>,<max> with a CPU target (default 60); bad values, a fixed count and memory with several tasks are refused', () => {
    expect(SETTINGS.autoscale).toBeUndefined()
    expect(SCALED.autoscale).toEqual({ min: 2, max: 4, cpuTarget: 60 })
    expect(settings({ stateStore: 'dynamodb', routerAutoscale: '1, 6', routerScaleCpu: '50' }).autoscale).toEqual({ min: 1, max: 6, cpuTarget: 50 })
    // One task on memory is allowed (scaling between 1 and 1 only replaces the fixed count).
    expect(settings({ routerAutoscale: '1,1' }).autoscale).toEqual({ min: 1, max: 1, cpuTarget: 60 })
    for (const v of ['2', '0,2', '3,2', `1,${MAX_ROUTER_TASKS + 1}`, '1,2,3', 'a,b']) {
      expect(error({ stateStore: 'dynamodb', routerAutoscale: v })).toMatch(/routerAutoscale: '<min>,<max>'/)
    }
    for (const v of ['5', '95', '60.5']) expect(error({ stateStore: 'dynamodb', routerAutoscale: '2,4', routerScaleCpu: v })).toMatch(/routerScaleCpu: integer percent from 10 to 90/)
    expect(error({ routerScaleCpu: '60' })).toMatch(/routerScaleCpu: needs -c routerAutoscale/)
    expect(error({ stateStore: 'dynamodb', routerAutoscale: '2,4', routerDesiredCount: '2' })).toMatch(/routerDesiredCount: drop it when routerAutoscale is set/)
    expect(error({ routerAutoscale: '1,3' })).toMatch(/routerAutoscale: up to 3 tasks need -c stateStore=dynamodb/)
  })

  it('template: no DesiredCount (a deploy keeps the scaled count), a scalable target on the service and CPU target tracking; cdk-nag clean', () => {
    const service = of(res, 'AWS::ECS::Service')[0]?.[1].Properties ?? {}
    expect(service.DesiredCount).toBeUndefined()
    const target = of(res, 'AWS::ApplicationAutoScaling::ScalableTarget')
    expect(target).toHaveLength(1)
    expect(target[0]?.[1].Properties).toMatchObject({ MinCapacity: 2, MaxCapacity: 4, ScalableDimension: 'ecs:service:DesiredCount', ServiceNamespace: 'ecs' })
    expect(JSON.stringify(target[0]?.[1].Properties?.ResourceId)).toMatch(/"service\/".*GetAtt.*Router.*Name/)
    const policy = of(res, 'AWS::ApplicationAutoScaling::ScalingPolicy')
    expect(policy).toHaveLength(1)
    expect(policy[0]?.[1].Properties).toMatchObject({ PolicyName: 'llmar-router-cpu', PolicyType: 'TargetTrackingScaling',
      TargetTrackingScalingPolicyConfiguration: { TargetValue: 60, ScaleOutCooldown: SCALE_OUT_COOLDOWN_S, ScaleInCooldown: SCALE_IN_COOLDOWN_S,
        PredefinedMetricSpecification: { PredefinedMetricType: 'ECSServiceAverageCPUUtilization' } } })
    expect(() => build(true, SCALED).app.synth()).not.toThrow()
  })

  it('without it: a fixed DesiredCount and no scaling resources', () => {
    expect(ofType('AWS::ECS::Service')[0]?.[1].Properties?.DesiredCount).toBe(0)
    expect(ofType('AWS::ApplicationAutoScaling::ScalableTarget')).toHaveLength(0)
    expect(ofType('AWS::ApplicationAutoScaling::ScalingPolicy')).toHaveLength(0)
  })
})
