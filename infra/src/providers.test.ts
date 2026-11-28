// External providers in the router stack (design docs/tasks/11-28-external-providers §5, ADR 0001).
import { readFileSync } from 'node:fs'
import { App, Validations, aws_ecr as ecr, aws_ecs as ecs, aws_lambda as lambda } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks } from 'cdk-nag'
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY_FILE, deployModels } from './models.ts'
import { resolveSettings, type Settings } from './settings.ts'
import { providerKeys } from '@auto-router/pricing'
import { RouterStack } from './stack.ts'
import { bakedArtifact } from './baked.ts'
import { testTempDir } from './test-outdir.ts'

const ctx = (c: Record<string, string>) => ({ tryGetContext: (k: string) => c[k] })
const BASE = { region: 'ap-southeast-1', account: '000000000000', tags: '{"Owner":"test-owner"}' }
const ARN = 'arn:aws:secretsmanager:ap-southeast-1:000000000000:secret:llmar/vllm-key-AbCdEf'

const registry = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, version: 'reg-1',
  providers: [{
    id: 'vllm', baseUrl: 'https://vllm.internal.example', auth: { scheme: 'bearer', secret: { arn: ARN } },
    models: [{ upstreamModel: 'qwen3-coder', family: 'other', tier: 'standard', dialects: ['openai-chat'], contextWindow: 262144,
      price: { input: 0, output: 0, cacheRead: 0, cacheWrite: {} }, cache: { mode: 'none', minTokens: 0, ttls: [], defaultTtl: '5m' } }],
    ...over,
  }],
})

/** The shipped default policy plus the registry model as a standard-tier sibling in the openai-chat pool. */
function policyWithExternal(): string {
  const p = JSON.parse(readFileSync(DEFAULT_POLICY_FILE, 'utf8'))
  p.pools['openai-chat'].models.push({ model: 'vllm/qwen3-coder', tier: 'standard' })
  return JSON.stringify(p)
}

/** A registry deploy: private provider egress (providerEgressMode=private, one CIDR) unless `c` says otherwise. */
function settings(c: Record<string, string> = {}): Settings {
  return { ...resolveSettings(ctx({ ...BASE, providerEgressMode: 'private', providerEgress: '10.20.0.0/16', ...c }), {}, DEFAULT_POLICY_FILE), policyFile: '/virtual/policy.json', providersFile: '/virtual/providers.json' }
}
const reader = (reg: unknown) => (p: string): string =>
  p === '/virtual/policy.json' ? policyWithExternal() : p === '/virtual/providers.json' ? JSON.stringify(reg) : readFileSync(p, 'utf8')

function build(s: Settings, reg: unknown, nag = false) {
  const models = deployModels(s, reader(reg))
  const app = new App({ outdir: testTempDir('infra-providers-test') })
  const stack = new RouterStack(app, 'llmar-router', { env: { account: s.account, region: s.region }, settings: s, models,
    image: ecs.ContainerImage.fromRegistry(`${s.account}.dkr.ecr.${s.region}.amazonaws.com/llmar-router:test`),
    lambdaCode: (sc, cmd) => lambda.DockerImageCode.fromEcr(ecr.Repository.fromRepositoryName(sc, `Repo${cmd.replace(/[^A-Za-z]/g, '')}`, 'llmar-catalog-test'), { cmd: [cmd] }) })
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app))
  return { app, models, resources: Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, any> }> }
}
const ofType = (res: Record<string, { Type: string; Properties?: Record<string, any> }>, t: string) => Object.entries(res).filter(([, r]) => r.Type === t)
const envOf = (res: Record<string, { Type: string; Properties?: Record<string, any> }>): Record<string, unknown> => {
  const c = ofType(res, 'AWS::ECS::TaskDefinition')[0]?.[1].Properties?.ContainerDefinitions[0]
  return Object.fromEntries((c.Environment as { Name: string; Value: unknown }[]).map((e) => [e.Name, e.Value]))
}

describe('settings: providersFile and providerEgress', () => {
  it('parses providerEgress as IPv4 <cidr>[:<port>] (default 443) and refuses anything internet-wide', () => {
    expect(resolveSettings(ctx({ ...BASE, providerEgress: '10.20.0.0/16, 10.30.1.0/24:8443' }), {}, DEFAULT_POLICY_FILE).providerEgress)
      .toEqual([{ cidr: '10.20.0.0/16', port: 443 }, { cidr: '10.30.1.0/24', port: 8443 }])
    expect(resolveSettings(ctx(BASE), {}, DEFAULT_POLICY_FILE).providerEgress).toBeUndefined()
    expect(() => resolveSettings(ctx({ ...BASE, providerEgress: '0.0.0.0/0' }), {}, DEFAULT_POLICY_FILE)).toThrow(/wider than \/8/)
    expect(() => resolveSettings(ctx({ ...BASE, providerEgress: 'vllm.internal' }), {}, DEFAULT_POLICY_FILE)).toThrow(/not an IPv4/)
    expect(() => resolveSettings(ctx({ ...BASE, providerEgress: '10.0.0.0/8:99999' }), {}, DEFAULT_POLICY_FILE)).toThrow(/bad port/)
    expect(resolveSettings(ctx({ ...BASE, providersFile: '/x/providers.json' }), {}, DEFAULT_POLICY_FILE).providersFile).toBe('/x/providers.json')
  })
})

describe('deployModels with a provider registry', () => {
  it('checks the policy against Bedrock metadata plus the registry, and keeps registry models out of the IAM-granted sets', () => {
    const m = deployModels(settings(), reader(registry()))
    expect(m.registry?.version).toBe('reg-1')
    expect(m.providerSecretArns).toEqual([ARN])
    expect(m.meta.models.find((x) => x.modelId === 'vllm/qwen3-coder')).toMatchObject({ dialects: ['openai-chat'], endpointScope: 'in-region' })
    expect(m.routerModels.some((id) => id.includes('/'))).toBe(false)
    expect(m.routerResponsesModels.some((id) => id.includes('/'))).toBe(false)
    expect(m.routerModels).toEqual(deployModels(resolveSettings(ctx(BASE), {}, DEFAULT_POLICY_FILE)).routerModels)
  })

  it('a policy naming an unregistered external model fails at synth', () => {
    const s = { ...settings() }
    delete s.providersFile
    expect(() => deployModels(s, reader(registry()))).toThrow(/vllm\/qwen3-coder/)
  })

  it('refuses env secrets, http endpoints and secrets of another Region or account', () => {
    const at = (over: Record<string, unknown>) => () => deployModels(settings(), reader(registry(over)))
    expect(at({ auth: { scheme: 'bearer', secret: { env: 'VLLM_KEY' } }, baseUrl: 'http://127.0.0.1:8000' })).toThrow(/https baseUrl/)
    expect(at({ auth: { scheme: 'bearer', secret: { env: 'VLLM_KEY' } }, baseUrl: 'http://127.0.0.1:8000' })).toThrow(/env secrets are for local runs/)
    expect(at({ auth: { scheme: 'bearer', secret: { arn: ARN.replace('ap-southeast-1', 'us-west-2') } } })).toThrow(/not the deploy region/)
    expect(at({ auth: { scheme: 'bearer', secret: { arn: ARN.replace(':000000000000:', ':111111111111:') } } })).toThrow(/another account/)
    expect(() => deployModels(settings(), reader({ schemaVersion: 1, version: 'x', providers: [{ id: 'bedrock' }] }))).toThrow(/providersFile/)
  })

  it('auth none needs no secret and adds no secret grant', () => {
    expect(deployModels(settings(), reader(registry({ auth: { scheme: 'none' } }))).providerSecretArns).toEqual([])
  })
})

describe('router stack with a provider registry', () => {
  const s = settings({ providerEgress: '10.20.0.0/16' })
  const { resources, models } = build({ ...s, providerEgress: [{ cidr: '10.20.0.0/16', port: 443 }] }, registry())

  it('passes the registry to the router and uploads its immutable version for usage-ingest', () => {
    expect(JSON.parse(envOf(resources).ROUTER_PROVIDERS_JSON as string)).toEqual(models.registry)
    expect(providerKeys.version('reg-1')).toBe('providers/versions/reg-1.json')
    const bucketPolicy = JSON.stringify(ofType(resources, 'AWS::S3::BucketPolicy').map(([, r]) => r.Properties))
    expect(bucketPolicy).toContain('providers/versions/*')
  })

  it('grants exactly the registry secrets, through a secretsmanager endpoint whose policy names only the task role', () => {
    const vpces = ofType(resources, 'AWS::EC2::VPCEndpoint').filter(([, r]) => JSON.stringify(r.Properties?.ServiceName).includes('secretsmanager'))
    expect(vpces.length).toBe(1)
    const doc = JSON.stringify(vpces[0]?.[1].Properties?.PolicyDocument)
    expect(doc).toContain('secretsmanager:GetSecretValue')
    expect(doc).toContain(ARN)
    const grants = ofType(resources, 'AWS::IAM::Policy').flatMap(([, r]) => r.Properties?.PolicyDocument.Statement as { Sid?: string; Action: unknown; Resource: unknown }[])
      .filter((st) => JSON.stringify(st.Action).includes('secretsmanager'))
    // The registry's arn plus the console-written <prefix>/providers/* (ADR 0002; this deploy has an egress mode).
    const managed = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':secretsmanager:ap-southeast-1:', { Ref: 'AWS::AccountId' }, ':secret:llmar/providers/*']] }
    expect(grants).toEqual([expect.objectContaining({ Sid: 'ProviderSecrets', Action: 'secretsmanager:GetSecretValue', Resource: [ARN, managed],
      Condition: { StringEquals: { 'aws:SourceVpce': { Ref: vpces[0]?.[0] } } } })])
    // The router learns the boundary and the prefix; the console reads them from SSM.
    expect(JSON.parse(envOf(resources).ROUTER_PROVIDER_BOUNDARY as string)).toEqual({ mode: 'private', hosts: [], cidrs: ['10.20.0.0/16'] })
    expect(envOf(resources).ROUTER_SECRET_PREFIX).toBe('llmar')
    const ssmParams = Object.fromEntries(ofType(resources, 'AWS::SSM::Parameter').map(([, r]) => [r.Properties?.Name, r.Properties?.Value]))
    expect(JSON.parse(ssmParams['/llmar/router/provider-boundary'])).toEqual({ mode: 'private', hosts: [], cidrs: ['10.20.0.0/16'] })
    expect(ssmParams['/llmar/router/provider-secret-prefix']).toBe('llmar')
    // The permissions boundary carries the same statement (else the grant would be capped away).
    const boundary = ofType(resources, 'AWS::IAM::ManagedPolicy').map(([, r]) => JSON.stringify(r.Properties?.PolicyDocument)).find((d) => d.includes('ProviderSecrets'))
    expect(boundary).toContain(ARN)
  })

  it('adds router egress only to the declared provider CIDR, and still no internet path', () => {
    const egress = ofType(resources, 'AWS::EC2::SecurityGroup').flatMap(([, r]) => (r.Properties?.SecurityGroupEgress ?? []) as { CidrIp?: string; FromPort?: number }[])
      .filter((e) => e.CidrIp !== undefined && e.CidrIp !== '255.255.255.255/32')
    expect(egress).toEqual([expect.objectContaining({ CidrIp: '10.20.0.0/16', FromPort: 443, ToPort: 443, IpProtocol: 'tcp' })])
    expect(ofType(resources, 'AWS::EC2::InternetGateway')).toEqual([])
    expect(ofType(resources, 'AWS::EC2::NatGateway')).toEqual([])
  })

  it('bakes the providersFile registry into the baked document (ADR 0002) and leaves a registry-less one unchanged', () => {
    const withReg = bakedArtifact(models.policy, {}, undefined, models.registry)
    expect((withReg.doc.providers as { providers: unknown[] }).providers).toEqual(models.registry?.providers)
    const without = bakedArtifact(models.policy, {})
    expect(without.doc.providers).toBeUndefined()
    expect(without.version).not.toBe(withReg.version)
    // Staged: baked.json, baked/<v>.json, providers/active.json, providers/versions/<registry v>.json, providers/versions/<baked v>.json.
    expect(ofType(resources, 'Custom::CDKBucketDeployment')[0]?.[1].Properties?.SourceObjectKeys).toHaveLength(5)
  })

  it('a providersFile outside the boundary fails synth with the router\'s own check', () => {
    const fw = { ...settings({ providerEgressMode: 'firewall', providerEgressAzs: '1', providerHosts: 'api.other.example' }), providerEgress: [] }
    // The registry's own host joins the firewall allowlist, so it is inside; an IP literal outside every CIDR is not.
    expect(() => deployModels(fw, reader(registry({ baseUrl: 'https://10.99.0.5' })))).toThrow(/outside the deployment's provider address ranges|no providerEgress rule covers/)
  })

  it('without a registry: no secretsmanager endpoint, no ROUTER_PROVIDERS_JSON', () => {
    const plain = resolveSettings(ctx(BASE), {}, DEFAULT_POLICY_FILE)
    const r = build(plain, undefined).resources
    expect(envOf(r).ROUTER_PROVIDERS_JSON).toBeUndefined()
    expect(envOf(r).ROUTER_PROVIDER_BOUNDARY).toBeUndefined()
    const ssmParams = Object.fromEntries(ofType(r, 'AWS::SSM::Parameter').map(([, x]) => [x.Properties?.Name, x.Properties?.Value]))
    expect(JSON.parse(ssmParams['/llmar/router/provider-boundary'])).toEqual({ mode: 'none', hosts: [], cidrs: [] })
    expect(ssmParams['/llmar/router/provider-secret-prefix']).toBe('none')
    // providers/active.json is still written (the explicit empty registry), so it never outlives the deploy that set it.
    // (Source.data keys are content hashes: count the staged objects, and read the handler's write allowance.)
    expect(ofType(r, 'Custom::CDKBucketDeployment')[0]?.[1].Properties?.SourceObjectKeys).toHaveLength(3) // baked.json, baked/<v>.json, providers/active.json
    const allowance = JSON.stringify(ofType(r, 'AWS::S3::BucketPolicy').map(([, x]) => x.Properties))
    expect(allowance).toContain('providers/active.json')
    expect(allowance).not.toContain('providers/versions/')
    expect(ofType(r, 'AWS::EC2::VPCEndpoint').some(([, x]) => JSON.stringify(x.Properties?.ServiceName).includes('secretsmanager'))).toBe(false)
  })

  it('cdk-nag clean', () => {
    expect(() => build({ ...s, providerEgress: [{ cidr: '10.20.0.0/16', port: 443 }] }, registry(), true).app.synth()).not.toThrow()
  })
})
