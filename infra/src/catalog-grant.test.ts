// C2a: router task role permissions boundary, catalog-grant Lambda IAM scope, destroy cleanup.
// C2b: catalog-refresh, its schedule and deploy-time Trigger, bucket-policy write restrictions, console grants, synth
// for a Region without a bundled catalog.
import { App, Tags, Validations, aws_ecr as ecr, aws_ecs as ecs, aws_lambda as lambda } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { DYN_POLICY_SLOTS, policyDocument } from '@auto-router/catalog-service'
import { AwsSolutionsChecks } from 'cdk-nag'
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY_FILE, deployModels } from './models.ts'
import { resolveSettings, type Settings } from './settings.ts'
import { CATALOG_LAMBDA_CMD, GRANT_PROPAGATION_DELAY_MS, GRANT_TIMEOUT_S, GRANT_UNCONFIRM_DELAY_MS, RouterStack } from './stack.ts'
import { ConsoleStack, resolveConsoleSettings, routerParamName } from './console-stack.ts'
import { testTempDir } from './test-outdir.ts'

const ACCOUNT = '0'.repeat(12)
const ctx = (c: Record<string, string>) => ({ tryGetContext: (k: string) => c[k] })
const settingsFor = (region: string, universe?: string, extra: Record<string, string> = {}) =>
  resolveSettings(ctx({ region, account: ACCOUNT, tags: '{"Owner":"test-owner"}', ...(universe ? { allowedModelUniverse: universe } : {}), ...extra }), {}, DEFAULT_POLICY_FILE)

type Res = Record<string, { Type: string; Properties?: Record<string, any>; DependsOn?: string | string[] }>
function build(settings: Settings, nag = false) {
  const app = new App({ outdir: testTempDir('infra-test') })
  const stack = new RouterStack(app, 'llmar-router', { env: { account: settings.account, region: settings.region }, settings, models: deployModels(settings),
    image: ecs.ContainerImage.fromRegistry(`${settings.account}.dkr.ecr.${settings.region}.amazonaws.com/llmar-router:test`),
    lambdaCode: (s, cmd) => lambda.DockerImageCode.fromEcr(ecr.Repository.fromRepositoryName(s, `Repo${cmd.replace(/[^A-Za-z]/g, '')}`, 'llmar-catalog-test'), { cmd: [cmd] }) })
  for (const [k, v] of Object.entries(settings.tags)) Tags.of(app).add(k, v)
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app))
  return { app, resources: Template.fromStack(stack).toJSON().Resources as Res }
}

const BUCKET = 'arn:aws:s3:::config-bucket'
/** Renders the CloudFormation intrinsics used in these policies to plain strings (account id, bucket ARN, role ARN). */
function render(v: unknown, res: Res): any {
  if (Array.isArray(v)) return v.map((x) => render(x, res))
  if (v && typeof v === 'object') {
    const o = v as Record<string, any>
    if ('Fn::Join' in o) return (render(o['Fn::Join'][1], res) as string[]).join(o['Fn::Join'][0])
    if ('Ref' in o) return o.Ref === 'AWS::AccountId' ? ACCOUNT : o.Ref === 'AWS::Region' ? 'REGION' : o.Ref === 'AWS::Partition' ? 'aws' : `REF:${o.Ref}`
    if ('Fn::GetAtt' in o) {
      const [id, attr] = o['Fn::GetAtt'] as [string, string]
      if (res[id]?.Type === 'AWS::S3::Bucket' && attr === 'Arn') return BUCKET
      if (res[id]?.Type === 'AWS::IAM::Role' && attr === 'Arn') return `arn:aws:iam::${ACCOUNT}:role/${res[id]!.Properties?.RoleName ?? id}`
      return `GETATT:${id}.${attr}`
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, render(x, res)]))
  }
  return v
}
const list = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x])
const globRe = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
const idOf = (res: Res, type: string, pred: (r: Res[string]) => boolean) => Object.entries(res).find(([, r]) => r.Type === type && pred(r))?.[0]
const taskRoleId = (res: Res) => idOf(res, 'AWS::IAM::Role', (r) => r.Properties?.RoleName === 'llmar-router-task')!
const boundaryOf = (res: Res) => {
  const id = idOf(res, 'AWS::IAM::ManagedPolicy', (r) => r.Properties?.ManagedPolicyName === 'llmar-router-boundary')!
  return { id, statements: render(res[id]!.Properties!.PolicyDocument.Statement, res) as Array<{ Sid: string; Effect: string; Action: string | string[]; Resource: string | string[]; Condition?: unknown }> }
}
/** Every policy statement attached to a role: inline (AWS::IAM::Policy) and managed (CDK overflow) policies. */
const roleStatements = (res: Res, roleId: string) => Object.values(res)
  .filter((r) => (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') && JSON.stringify(r.Properties?.Roles ?? []).includes(`"${roleId}"`))
  .flatMap((r) => render(r.Properties!.PolicyDocument.Statement, res) as any[])

const VARIANTS = [['ap-southeast-1', undefined], ['ap-southeast-1', 'catalog'], ['ap-northeast-1', 'catalog'], ['us-west-2', 'catalog']] as const
const DEFAULT = build(settingsFor('ap-southeast-1'))

describe('router task role permissions boundary', () => {
  it('is the task role\'s PermissionsBoundary and allows exactly Bedrock invoke + config reads', () => {
    const res = DEFAULT.resources
    const { id, statements } = boundaryOf(res)
    expect(res[taskRoleId(res)]!.Properties!.PermissionsBoundary).toEqual({ Ref: id })
    expect(res[id]!.Properties!.Roles).toBeUndefined()
    const R = 'ap-southeast-1'
    expect(statements).toEqual([
      { Sid: 'BedrockInvoke', Effect: 'Allow', Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        Resource: [`arn:aws:bedrock:${R}:${ACCOUNT}:inference-profile/*`, 'arn:aws:bedrock:*::foundation-model/*', 'arn:aws:bedrock:::foundation-model/*'] },
      { Sid: 'BedrockResponsesProject', Effect: 'Allow', Action: 'bedrock:InvokeModel', Resource: `arn:aws:bedrock:${R}:${ACCOUNT}:project/*` },
      { Sid: 'ConfigRead', Effect: 'Allow', Action: 's3:GetObject', Resource: [`${BUCKET}/config/active.json`, `${BUCKET}/identity/*`] },
      { Sid: 'ConfigList', Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET },
      { Sid: 'CatalogRead', Effect: 'Allow', Action: 's3:GetObject', Resource: [`${BUCKET}/catalog/current.json`, `${BUCKET}/catalog/universe.json`, `${BUCKET}/catalog/versions/*`] },
    ])
  })

  it.each(VARIANTS)('covers every statement the task role has (%s, universe %s): inline and overflow policies', (region, universe) => {
    const { resources: res } = universe ? build(settingsFor(region, universe)) : DEFAULT
    const boundary = boundaryOf(res).statements
    const own = roleStatements(res, taskRoleId(res))
    expect(own.length).toBeGreaterThanOrEqual(5)
    if (universe === 'catalog') expect(Object.values(res).some((r) => r.Type === 'AWS::IAM::ManagedPolicy' && JSON.stringify(r.Properties?.Roles ?? []).includes(taskRoleId(res)))).toBe(true)
    for (const st of own) {
      expect(st.Effect).toBe('Allow')
      for (const a of list<string>(st.Action)) for (const r of list<string>(st.Resource)) {
        const ok = boundary.some((b) => list(b.Action).includes(a) && list<string>(b.Resource).some((p) => globRe(p).test(r)))
        expect(ok, `${st.Sid}: ${a} on ${r}`).toBe(true)
      }
    }
  })

  it.each([undefined, 'catalog'])('state store (-c stateStore=dynamodb, universe %s): the boundary gains the role\'s exact grant and still covers every statement', (universe) => {
    const { resources: res } = build(settingsFor('ap-southeast-1', universe, { stateStore: 'dynamodb' }))
    const boundary = boundaryOf(res).statements
    const own = roleStatements(res, taskRoleId(res))
    const tableArn = `GETATT:${idOf(res, 'AWS::DynamoDB::Table', (r) => r.Properties?.TableName === 'llmar-router-state')}.Arn`
    const endpointId = idOf(res, 'AWS::EC2::VPCEndpoint', (r) => JSON.stringify(r.Properties?.ServiceName).includes('.dynamodb"'))
    const grant = { Sid: 'StateStore', Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'], Resource: tableArn,
      Condition: { StringEquals: { 'aws:SourceVpce': `REF:${endpointId}` } } }
    // Same actions, same table, same endpoint condition on both sides; the rest of the boundary is the memory-mode one.
    expect(own.filter((st) => list<string>(st.Action).some((a) => a.startsWith('dynamodb:')))).toEqual([grant])
    expect(boundary.at(-1)).toEqual(grant)
    expect(boundary.slice(0, -1)).toEqual(boundaryOf(DEFAULT.resources).statements)
    const allowed = (a: string, r: string) => boundary.some((b) => list(b.Action).includes(a) && list<string>(b.Resource).some((p) => globRe(p).test(r)))
    for (const st of own) {
      expect(st.Effect).toBe('Allow')
      for (const a of list<string>(st.Action)) for (const r of list<string>(st.Resource)) expect(allowed(a, r), `${st.Sid}: ${a} on ${r}`).toBe(true)
    }
    // The ceiling stays at the grant: no other DynamoDB action, no other table, no index.
    for (const a of ['dynamodb:DeleteItem', 'dynamodb:Scan', 'dynamodb:Query', 'dynamodb:BatchWriteItem', 'dynamodb:DeleteTable']) expect(allowed(a, tableArn), a).toBe(false)
    expect(allowed('dynamodb:GetItem', `arn:aws:dynamodb:ap-southeast-1:${ACCOUNT}:table/llmar-console`)).toBe(false)
    expect(allowed('dynamodb:GetItem', `${tableArn}/index/any`)).toBe(false)
  })

  it('covers the dynamic documents the grant Lambda writes (global, geo, in-Region, Responses)', () => {
    const { resources: res } = build(settingsFor('ap-northeast-1', 'catalog'))
    const boundary = boundaryOf(res).statements
    const doc = policyDocument([
      { id: 'global.openai.gpt-6.1-sol', endpointScope: 'global', dialects: ['openai-chat', 'openai-responses'] },
      { id: 'jp.anthropic.claude-opus-5-5', endpointScope: 'geo', dialects: ['anthropic-messages'] },
      { id: 'moonshotai.kimi-k2.5', endpointScope: 'in-region', dialects: ['openai-chat'] },
    ], 'ap-northeast-1', ACCOUNT)
    for (const st of doc.Statement) for (const a of st.Action) for (const r of st.Resource) {
      expect(boundary.some((b) => list(b.Action).includes(a) && list<string>(b.Resource).some((p) => globRe(p).test(r))), `${a} on ${r}`).toBe(true)
    }
  })

  it('denies (by omission) what a dynamic policy might add: IAM, S3 writes, other Bedrock actions, other Regions\' profiles', () => {
    const boundary = boundaryOf(DEFAULT.resources).statements
    const allowed = (a: string, r: string) => boundary.some((b) => list(b.Action).includes(a) && list<string>(b.Resource).some((p) => globRe(p).test(r)))
    expect(allowed('iam:AttachRolePolicy', '*')).toBe(false)
    expect(allowed('s3:PutObject', `${BUCKET}/config/active.json`)).toBe(false)
    expect(allowed('s3:GetObject', `${BUCKET}/other/key`)).toBe(false)
    expect(allowed('bedrock:CreateModelCustomizationJob', 'arn:aws:bedrock:*::foundation-model/*')).toBe(false)
    expect(allowed('bedrock:InvokeModel', `arn:aws:bedrock:us-east-1:${ACCOUNT}:inference-profile/global.x.y`)).toBe(false)
    // stateStore=memory (default): nothing on DynamoDB at all.
    expect(boundary.some((b) => list<string>(b.Action).some((a) => a.startsWith('dynamodb:')))).toBe(false)
    expect(allowed('dynamodb:GetItem', `arn:aws:dynamodb:ap-southeast-1:${ACCOUNT}:table/llmar-router-state`)).toBe(false)
  })
})

describe('catalog-grant Lambda', () => {
  const res = DEFAULT.resources
  const fnId = idOf(res, 'AWS::Lambda::Function', (r) => r.Properties?.FunctionName === 'llmar-catalog-grant')!
  const fn = res[fnId]!.Properties!
  const roleId = idOf(res, 'AWS::IAM::Role', (r) => r.Properties?.RoleName === 'llmar-catalog-grant-role')!
  const dynArns = Array.from({ length: DYN_POLICY_SLOTS }, (_, i) => `arn:aws:iam::${ACCOUNT}:policy/llmar-dyn-models-${i + 1}`)

  it('image function outside the VPC, its own handler, the deployment\'s base universe', () => {
    expect(fn.PackageType).toBe('Image')
    expect(fn.ImageConfig).toEqual({ Command: [CATALOG_LAMBDA_CMD.grant] })
    expect(fn.VpcConfig).toBeUndefined()
    expect(fn.Architectures).toEqual(['arm64'])
    expect(fn.Timeout).toBe(GRANT_TIMEOUT_S)
    // The un-confirm wait covers one router poll (30 s) and fits the timeout with the IAM sync and retries.
    expect(GRANT_UNCONFIRM_DELAY_MS).toBeGreaterThan(30_000)
    expect(GRANT_TIMEOUT_S * 1000).toBeGreaterThanOrEqual(GRANT_UNCONFIRM_DELAY_MS + 3 * 20_000 + GRANT_PROPAGATION_DELAY_MS * 2)
    const env = render(fn.Environment.Variables, res)
    expect(env).toEqual({ PREFIX: 'llmar', ROLE_NAME: `REF:${taskRoleId(res)}`, REGION: 'ap-southeast-1', ACCOUNT_ID: ACCOUNT,
      BASE_UNIVERSE: deployModels(settingsFor('ap-southeast-1')).routerModels.join(','), PROPAGATION_DELAY_MS: String(GRANT_PROPAGATION_DELAY_MS),
      CONFIG_BUCKET: expect.stringMatching(/^REF:Config/), UNCONFIRM_DELAY_MS: '35000' })
    expect(fn.Role).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] })
  })

  it('IAM: the four dynamic policies only, attach/detach only on the task role and only those policies; no wildcard resource', () => {
    const statements = roleStatements(res, roleId)
    expect(statements).toEqual([
      { Sid: 'OwnLogs', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: expect.stringMatching(/^GETATT:CatalogGrantLogs.*\.Arn:\*$/) },
      { Sid: 'DynamicPolicies', Effect: 'Allow', Resource: dynArns, Action: ['iam:CreatePolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion',
        'iam:DeletePolicy', 'iam:ListPolicyVersions', 'iam:GetPolicyVersion'] },
      { Sid: 'AttachDynamicPolicies', Effect: 'Allow', Action: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'], Resource: `arn:aws:iam::${ACCOUNT}:role/llmar-router-task`,
        Condition: { ArnEquals: { 'iam:PolicyARN': dynArns } } },
      { Sid: 'CatalogWrite', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: [`${BUCKET}/catalog/models.json`, `${BUCKET}/catalog/universe.json`] },
      { Sid: 'CatalogRead', Effect: 'Allow', Action: 's3:GetObject', Resource: [`${BUCKET}/catalog/current.json`, `${BUCKET}/catalog/versions/*`] },
      { Sid: 'ConfigList', Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET },
      { Sid: 'ConfigAndDrainingRead', Effect: 'Allow', Action: 's3:GetObject', Resource: [`${BUCKET}/config/active.json`, `${BUCKET}/config/baked.json`, `${BUCKET}/catalog/grant-draining`] },
    ])
    for (const s of statements) for (const r of list<string>(s.Resource)) expect(r === '*' || r.includes('dyn-models-*')).toBe(false)
    // The boundary is not one of the policies it may write or attach.
    expect(dynArns.some((a) => a.endsWith('router-boundary'))).toBe(false)
  })

  const cleanupId = idOf(res, 'AWS::Lambda::Function', (r) => r.Properties?.FunctionName === 'llmar-catalog-grant-cleanup')!
  const cleanupRoleId = idOf(res, 'AWS::IAM::Role', (r) => r.Properties?.RoleName === 'llmar-catalog-grant-cleanup-role')!

  it('cleanup function: same image, its own CMD and role; only list/detach/delete on the dynamic policies', () => {
    const cfn = res[cleanupId]!.Properties!
    expect(cfn.PackageType).toBe('Image')
    expect(cfn.ImageConfig).toEqual({ Command: [CATALOG_LAMBDA_CMD.grantCleanup] })
    expect(cfn.VpcConfig).toBeUndefined()
    expect(cfn.Role).toEqual({ 'Fn::GetAtt': [cleanupRoleId, 'Arn'] })
    expect(render(cfn.Environment.Variables, res)).toEqual({ PREFIX: 'llmar', ROLE_NAME: `REF:${taskRoleId(res)}`, REGION: 'ap-southeast-1', ACCOUNT_ID: ACCOUNT,
      CONFIG_BUCKET: expect.stringMatching(/^REF:Config/) })
    expect(roleStatements(res, cleanupRoleId)).toEqual([
      { Sid: 'OwnLogs', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: expect.stringMatching(/^GETATT:CatalogGrantCleanupLogs.*\.Arn:\*$/) },
      { Sid: 'DeleteDynamicPolicies', Effect: 'Allow', Resource: dynArns, Action: ['iam:ListPolicyVersions', 'iam:DeletePolicyVersion', 'iam:DeletePolicy'] },
      { Sid: 'DrainingMarker', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: `${BUCKET}/catalog/grant-draining` },
      { Sid: 'ConfigList', Effect: 'Allow', Action: 's3:ListBucket', Resource: expect.anything() },
      { Sid: 'DetachDynamicPolicies', Effect: 'Allow', Action: 'iam:DetachRolePolicy', Resource: `arn:aws:iam::${ACCOUNT}:role/llmar-router-task`,
        Condition: { ArnEquals: { 'iam:PolicyARN': dynArns } } },
    ])
  })

  it('cleanup custom resource: depends on the task role (deleted first), constant properties; the Provider invokes the cleanup function only', () => {
    const cr = Object.values(res).find((r) => r.Type === 'Custom::CatalogGrantCleanup')!
    expect(list(cr.DependsOn)).toEqual(expect.arrayContaining([taskRoleId(res)]))
    expect(Object.keys(cr.Properties!).sort()).toEqual(['ServiceToken', 'slots'])
    expect(cr.Properties!.slots).toBe(DYN_POLICY_SLOTS)
    const providerFns = Object.values(res).filter((r) => r.Type === 'AWS::Lambda::Function' && JSON.stringify(r.Properties?.Environment ?? {}).includes('USER_ON_EVENT_FUNCTION_ARN'))
    expect(providerFns).toHaveLength(1)
    const providerEnv = JSON.stringify(providerFns[0]!.Properties!.Environment)
    expect(providerEnv).toContain(cleanupId)
    expect(providerEnv).not.toContain(`"${fnId}"`)
    // In this stack only catalog-refresh may invoke the grant function (after a publish); console-api is granted in its own stack.
    const invokers = Object.entries(res).filter(([, r]) => (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::Lambda::Permission')
      && JSON.stringify(r.Properties).includes(`"${fnId}"`) && JSON.stringify(r.Properties).includes('lambda:InvokeFunction')).map(([id]) => id)
    expect(invokers).toEqual([expect.stringMatching(/^CatalogRefreshRoleDefaultPolicy/)])
  })

  it('passes cdk-nag AwsSolutions (geo/in-Region catalog universe)', () => {
    expect(() => build(settingsFor('ap-northeast-1', 'catalog'), true).app.synth()).not.toThrow()
  })
})

describe('catalog-refresh (C2b)', () => {
  const res = DEFAULT.resources
  const fnId = idOf(res, 'AWS::Lambda::Function', (r) => r.Properties?.FunctionName === 'llmar-catalog-refresh')!
  const grantId = idOf(res, 'AWS::Lambda::Function', (r) => r.Properties?.FunctionName === 'llmar-catalog-grant')!
  const roleId = idOf(res, 'AWS::IAM::Role', (r) => r.Properties?.RoleName === 'llmar-catalog-refresh-role')!
  const roleArn = (name: string) => `arn:aws:iam::${ACCOUNT}:role/${name}`

  it('image function outside the VPC with its own CMD, the bucket, the grant function and the deploy inputs', () => {
    const f = res[fnId]!.Properties!
    expect(f.ImageConfig).toEqual({ Command: [CATALOG_LAMBDA_CMD.refresh] })
    expect(f.VpcConfig).toBeUndefined()
    expect(f.Timeout).toBe(300)
    expect(render(f.Environment.Variables, res)).toEqual({ CONFIG_BUCKET: expect.stringMatching(/^REF:Config/), REGION: 'ap-southeast-1',
      GRANT_FUNCTION: `REF:${grantId}`, DEPLOY_INPUTS: expect.stringMatching(/^[0-9a-f]{16}$/), BASE_UNIVERSE: deployModels(settingsFor('ap-southeast-1')).routerModels.join(',') })
  })

  it('IAM: read-only capture calls, catalog objects, config reads, ListBucket, invoke of the grant function only', () => {
    const k = (key: string) => `${BUCKET}/${key}`
    expect(roleStatements(res, roleId)).toEqual([
      { Sid: 'OwnLogs', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: expect.stringMatching(/^GETATT:CatalogRefreshLogs.*\.Arn:\*$/) },
      { Sid: 'Capture', Effect: 'Allow', Resource: '*', Action: ['pricing:GetProducts', 'bedrock:ListInferenceProfiles', 'bedrock:ListFoundationModels'] },
      { Sid: 'CatalogWrite', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: ['catalog/models.json', 'catalog/current.json',
        'catalog/versions/*', 'catalog/changes/*', 'catalog/snapshots/*', 'catalog/notices.json', 'catalog/deploy-inputs.json'].map(k) },
      { Sid: 'ConfigRead', Effect: 'Allow', Action: 's3:GetObject', Resource: [k('config/active.json'), k('config/baked.json')] },
      { Sid: 'ConfigList', Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET },
      { Sid: 'InvokeGrant', Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: `GETATT:${grantId}.Arn` },
    ])
  })

  it('daily schedule with { mode: scheduled }', () => {
    const rule = Object.values(res).find((r) => r.Type === 'AWS::Events::Rule' && r.Properties?.Name === 'llmar-catalog-refresh')!
    expect(rule.Properties!.ScheduleExpression).toBe('cron(0 3 * * ? *)')
    expect(rule.Properties!.Targets).toEqual([expect.objectContaining({ Arn: { 'Fn::GetAtt': [fnId, 'Arn'] }, Input: '{"mode":"scheduled"}' })])
  })

  it('deploy-time Trigger: after the bucket, the baked document and the refresh role policy; before the ECS service', () => {
    const [trigId, trig] = Object.entries(res).find(([, r]) => r.Type === 'Custom::Trigger')!
    const deps = list(trig.DependsOn)
    const bucket = idOf(res, 'AWS::S3::Bucket', () => true)!
    const packs = idOf(res, 'Custom::CDKBucketDeployment', () => true)!
    expect(deps).toEqual(expect.arrayContaining([bucket, packs, expect.stringMatching(/^CatalogRefreshRoleDefaultPolicy/)]))
    expect(JSON.stringify(trig.Properties?.HandlerArn)).toMatch(/CatalogRefreshCurrentVersion/)
    expect(trig.Properties?.InvocationType).toBe('RequestResponse')
    const service = Object.values(res).find((r) => r.Type === 'AWS::ECS::Service')!
    expect(list(service.DependsOn)).toContain(trigId)
  })

  it('a policy or universe change changes DEPLOY_INPUTS (the Trigger re-runs); the same inputs keep it', () => {
    const inputs = (r: Res) => Object.values(r).find((x) => x.Properties?.FunctionName === 'llmar-catalog-refresh')!.Properties!.Environment.Variables.DEPLOY_INPUTS
    expect(inputs(build(settingsFor('ap-southeast-1')).resources)).toBe(inputs(res))
    expect(inputs(build(settingsFor('ap-southeast-1', 'catalog')).resources)).not.toBe(inputs(res))
  })

  it('SSM params name the refresh and grant functions for the console stack', () => {
    const param = (p: 'catalogRefreshFunction' | 'catalogGrantFunction') => Object.values(res).find((r) => r.Type === 'AWS::SSM::Parameter' && r.Properties?.Name === routerParamName('llmar', p))?.Properties?.Value
    expect(param('catalogRefreshFunction')).toBe('llmar-catalog-refresh')
    expect(param('catalogGrantFunction')).toEqual({ Ref: grantId })
  })

  describe('bucket policy write restrictions', () => {
    const policy = Object.values(res).find((r) => r.Type === 'AWS::S3::BucketPolicy')!
    const statements = render(policy.Properties!.PolicyDocument.Statement, res) as Array<Record<string, any>>
    /** Whether an explicit Deny in the bucket policy applies to `principal` doing `action` on `key`. */
    const denied = (principal: string, action: string, key: string) => statements.some((st) => {
      if (st.Effect !== 'Deny' || !list<string>(st.Action).some((a) => globRe(a).test(action))) return false
      if (st.Condition?.Bool?.['aws:SecureTransport'] === 'false') return false // requests here use TLS (enforceSSL)
      const r = `${BUCKET}/${key}`
      if (st.Resource && !list<string>(st.Resource).some((p) => globRe(p).test(r))) return false
      if (st.NotResource && list<string>(st.NotResource).some((p) => globRe(p).test(r))) return false
      const pr = st.Principal === '*' ? ['*'] : list<string>(st.Principal?.AWS)
      if (!pr.includes('*') && !pr.includes(principal)) return false
      const notArn = st.Condition?.ArnNotEquals?.['aws:PrincipalArn']
      if (notArn !== undefined && list<string>(notArn).includes(principal)) return false
      return !st.Condition?.StringNotEquals // the endpoint deny (task role reads only) is not a write rule
    })
    const refresh = roleArn('llmar-catalog-refresh-role')
    const grant = roleArn('llmar-catalog-grant-role')
    const consoleApi = roleArn('llmar-console-api-role')
    const packsRole = render({ 'Fn::GetAtt': [Object.entries(res).find(([k, r]) => r.Type === 'AWS::IAM::Role' && k.startsWith('CustomCDKBucketDeployment'))![0], 'Arn'] }, res) as string

    it('a third principal cannot write catalog/versions/, changes/, snapshots/, notices.json or universe.json', () => {
      for (const key of ['catalog/versions/2026-11-16.1.json', 'catalog/changes/2026-11-16.1.json', 'catalog/snapshots/20261116T030000Z.json', 'catalog/notices.json', 'catalog/universe.json']) {
        expect(denied(consoleApi, 's3:PutObject', key), key).toBe(true)
      }
    })

    it('each writer keeps its own keys: refresh the versions and notices, grant the universe; not each other\'s', () => {
      for (const key of ['catalog/versions/2026-11-16.1.json', 'catalog/changes/2026-11-16.1.json', 'catalog/snapshots/20261116T030000Z.json', 'catalog/notices.json']) {
        expect(denied(refresh, 's3:PutObject', key), key).toBe(false)
        expect(denied(grant, 's3:PutObject', key), key).toBe(true)
      }
      expect(denied(grant, 's3:PutObject', 'catalog/universe.json')).toBe(false)
      expect(denied(refresh, 's3:PutObject', 'catalog/universe.json')).toBe(true)
    })

    const cleanup = roleArn('llmar-catalog-grant-cleanup-role')
    const teardown = render({ 'Fn::GetAtt': [Object.entries(res).find(([k, r]) => r.Type === 'AWS::IAM::Role' && k.startsWith('CustomS3AutoDeleteObjects'))![0], 'Arn'] }, res) as string
    const third = roleArn('someone-else')

    it('the deploy-time writers and console-api\'s keys still work (models.json, current.json, config/, baked.json)', () => {
      for (const p of [refresh, grant, consoleApi]) for (const key of ['catalog/models.json', 'catalog/current.json']) expect(denied(p, 's3:PutObject', key), `${p} ${key}`).toBe(false)
      expect(denied(consoleApi, 's3:PutObject', 'config/active.json')).toBe(false)
      expect(denied(packsRole, 's3:PutObject', 'config/baked.json')).toBe(false)
      expect(denied(packsRole, 's3:PutObject', 'catalog/models.json')).toBe(true) // the existing packs-only rule
      expect(denied(cleanup, 's3:PutObject', 'catalog/grant-draining')).toBe(false)
    })

    it('finding 8: a third principal can neither write nor delete models.json / current.json (or any catalog-owned key)', () => {
      for (const key of ['catalog/models.json', 'catalog/current.json', 'catalog/universe.json', 'catalog/versions/2026-11-16.1.json', 'catalog/grant-draining', 'catalog/deploy-inputs.json']) {
        for (const a of ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion']) expect(denied(third, a, key), `${a} ${key}`).toBe(true)
      }
      expect(denied(consoleApi, 's3:DeleteObject', 'catalog/versions/2026-11-16.1.json')).toBe(true)
      expect(denied(grant, 's3:PutObject', 'catalog/grant-draining')).toBe(true)
    })

    it('finding 8: stack teardown (auto-delete-objects) may still delete every catalog object', () => {
      for (const key of ['catalog/models.json', 'catalog/current.json', 'catalog/universe.json', 'catalog/versions/2026-11-16.1.json', 'catalog/snapshots/20261116T030000Z.json', 'catalog/grant-draining']) {
        for (const a of ['s3:DeleteObject', 's3:DeleteObjectVersion']) expect(denied(teardown, a, key), `${a} ${key}`).toBe(false)
      }
    })
  })

  it('finding 11: noncurrent object versions under catalog/ expire after 30 days; current versions stay', () => {
    const bucket = Object.values(res).find((r) => r.Type === 'AWS::S3::Bucket')!
    expect(bucket.Properties!.LifecycleConfiguration).toEqual({ Rules: [{ Id: 'catalog-noncurrent-versions', Prefix: 'catalog/', Status: 'Enabled',
      NoncurrentVersionExpiration: { NoncurrentDays: 30 } }] })
  })

  it('finding 3: catalog-grant has reserved concurrency 1; -c catalogGrantConcurrency=none drops it', () => {
    const grantFn = (r: Res) => Object.values(r).find((x) => x.Properties?.FunctionName === 'llmar-catalog-grant')!.Properties!
    expect(grantFn(res).ReservedConcurrentExecutions).toBe(1)
    const none = resolveSettings(ctx({ region: 'ap-southeast-1', account: ACCOUNT, catalogGrantConcurrency: 'none' }), {}, DEFAULT_POLICY_FILE)
    expect(grantFn(build(none).resources).ReservedConcurrentExecutions).toBeUndefined()
    expect(() => resolveSettings(ctx({ region: 'ap-southeast-1', account: ACCOUNT, catalogGrantConcurrency: '5' }), {}, DEFAULT_POLICY_FILE)).toThrow(/catalogGrantConcurrency/)
  })

  it('finding 10: the cleanup custom resource is deleted before the config bucket (it writes the draining marker there)', () => {
    const cr = Object.values(res).find((r) => r.Type === 'Custom::CatalogGrantCleanup')!
    expect(list(cr.DependsOn)).toEqual(expect.arrayContaining([idOf(res, 'AWS::S3::Bucket', () => true)]))
  })

  it('no bundled catalog (eu-west-1): synthesizes, base universe = the shipped global models, cdk-nag clean', () => {
    const s = resolveSettings(ctx({ region: 'eu-west-1', account: ACCOUNT, azIds: 'euw1-az1,euw1-az2', allowedModelUniverse: 'catalog', tags: '{"Owner":"test-owner"}' }), {}, DEFAULT_POLICY_FILE)
    const m = deployModels(s)
    expect(m.catalog).toBeUndefined()
    expect(m.routerModels.length).toBeGreaterThan(6)
    expect(m.routerModels.every((id) => id.startsWith('global.'))).toBe(true)
    expect(() => build(s, true).app.synth()).not.toThrow()
  })
})

describe('console stack catalog grants (C2b)', () => {
  const cs = resolveConsoleSettings(ctx({ region: 'ap-southeast-1', account: ACCOUNT }), {})
  const app = new App({ outdir: testTempDir('infra-test-console') })
  const stack = new ConsoleStack(app, 'llmar-console', { env: { account: cs.account, region: cs.region }, settings: cs,
    code: (s, cmd) => lambda.DockerImageCode.fromEcr(ecr.Repository.fromRepositoryName(s, `Repo${cmd.replace(/[^A-Za-z]/g, '')}`, 'llmar-console-test'), { cmd: [cmd] }) })
  const res = Template.fromStack(stack).toJSON().Resources as Res
  const ssm = (p: string) => `SSM:${p}`
  const r2 = (v: unknown): any => {
    if (Array.isArray(v)) return v.map(r2)
    if (v && typeof v === 'object') {
      const o = v as Record<string, any>
      if ('Fn::Join' in o) return (r2(o['Fn::Join'][1]) as string[]).join(o['Fn::Join'][0])
      if ('Ref' in o) {
        const p = Object.keys(res).includes(o.Ref) ? undefined : o.Ref
        if (o.Ref === 'AWS::AccountId') return ACCOUNT
        if (o.Ref === 'AWS::Region') return 'ap-southeast-1'
        return p && /SsmParameterValue/.test(p) ? ssm(p.replace(/^SsmParameterValuellmarrouter/, '').replace(/C96584B6F00A464EAD1953AFF4B05118Parameter$/, '')) : `REF:${o.Ref}`
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, r2(x)]))
    }
    return v
  }
  const fnOf = (name: string) => Object.values(res).find((r) => r.Type === 'AWS::Lambda::Function' && r.Properties?.FunctionName === name)!
  const statementsOf = (roleName: string) => {
    const id = idOf(res, 'AWS::IAM::Role', (r) => r.Properties?.RoleName === roleName)!
    return Object.values(res).filter((r) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties?.Roles).includes(`"${id}"`))
      .flatMap((r) => r2(r.Properties!.PolicyDocument.Statement) as any[])
  }

  it('console-api: the two function names as env, invoke on both, Get/Put on models.json and current.json, Get on catalog/*', () => {
    const env = r2(fnOf('llmar-console-api').Properties!.Environment.Variables)
    expect(env.CATALOG_REFRESH_FUNCTION).toBe(ssm('catalogrefreshfunction'))
    expect(env.CATALOG_GRANT_FUNCTION).toBe(ssm('cataloggrantfunction'))
    const st = statementsOf('llmar-console-api-role')
    const bucket = `arn:aws:s3:::${ssm('configbucket')}`
    expect(st.find((s) => s.Sid === 'CatalogWrite')).toMatchObject({ Action: ['s3:GetObject', 's3:PutObject'], Resource: [`${bucket}/catalog/models.json`, `${bucket}/catalog/current.json`] })
    expect(st.find((s) => s.Sid === 'CatalogRead')).toMatchObject({ Action: 's3:GetObject', Resource: `${bucket}/catalog/*` })
    expect(st.find((s) => s.Sid === 'CatalogFunctions')).toMatchObject({ Action: 'lambda:InvokeFunction', Resource: [
      `arn:aws:lambda:ap-southeast-1:${ACCOUNT}:function:${ssm('catalogrefreshfunction')}`, `arn:aws:lambda:ap-southeast-1:${ACCOUNT}:function:${ssm('cataloggrantfunction')}`] })
    expect(st.some((s) => list<string>(s.Action).includes('s3:PutObject') && JSON.stringify(s.Resource).includes('catalog/versions'))).toBe(false)
  })

  it('usage-ingest: Get on catalog/versions/* only', () => {
    const st = statementsOf('llmar-usage-ingest-role').filter((s) => JSON.stringify(s.Resource).includes('catalog/'))
    expect(st).toEqual([{ Sid: 'CatalogVersions', Effect: 'Allow', Action: 's3:GetObject', Resource: `arn:aws:s3:::${ssm('configbucket')}/catalog/versions/*` }])
  })

  it('passes cdk-nag', () => {
    const a = new App({ outdir: testTempDir('infra-test-console-nag') })
    new ConsoleStack(a, 'llmar-console', { env: { account: cs.account, region: cs.region }, settings: cs,
      code: (s, cmd) => lambda.DockerImageCode.fromEcr(ecr.Repository.fromRepositoryName(s, `Repo${cmd.replace(/[^A-Za-z]/g, '')}`, 'llmar-console-test'), { cmd: [cmd] }) })
    Validations.of(a).addPlugins(new AwsSolutionsChecks(a))
    expect(() => a.synth()).not.toThrow()
  })
})
