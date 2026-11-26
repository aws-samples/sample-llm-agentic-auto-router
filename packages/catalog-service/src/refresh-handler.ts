// catalog-refresh Lambda entry (router stack, outside the VPC). Invoked by the daily EventBridge rule
// ({ mode: 'scheduled' }), by console-api ({ mode: 'manual', acceptIncomplete?, resumeAfterRollback? }, async) and by
// the deploy-time CDK Trigger (no payload = deploy). In deploy mode a blocked refresh throws one line listing the block
// notices; the Trigger turns it into the CloudFormation status reason. Clients and the environment are read on first use.
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import { S3Client } from '@aws-sdk/client-s3'
import { bedrockClient, pricingClient, sdkCaptureClients } from './capture-sdk.ts'
import { bucketFromEnv, grantFunctionFromEnv, log, regionFromEnv, type CatalogEnv } from './env.ts'
import { deployFailureMessage, parseRefreshInput, RefreshInputError, runRefresh, type RefreshDeps, type RefreshResult } from './refresh.ts'
import { s3Store } from './s3-store.ts'

/** The handler logic with its dependencies injected (tests). */
export async function handleRefresh(event: unknown, deps: RefreshDeps): Promise<RefreshResult> {
  let input
  try { input = parseRefreshInput(event) } catch (e) {
    if (e instanceof RefreshInputError) log('catalog-refresh', { outcome: 'rejected', reason: e.message })
    throw e
  }
  const r = await runRefresh(deps, input)
  log('catalog-refresh', { outcome: r.outcome, mode: r.mode, version: r.version, attemptedVersion: r.attemptedVersion, counts: r.counts,
    notices: r.notices.map((n) => ({ kind: n.kind, severity: n.severity, modelId: n.modelId })) })
  // Deploy mode fails only on models the deploy itself introduces (see runRefresh); everything else is a notice.
  if (r.deploy?.fails) throw new Error(deployFailureMessage(deps.region, r.notices.filter((n) => n.severity === 'block' && n.modelId && r.deploy!.missing.includes(n.modelId))))
  return r
}

let deps: RefreshDeps | undefined

export async function handler(event: unknown): Promise<RefreshResult> {
  if (!deps) {
    const env = process.env as CatalogEnv
    const region = regionFromEnv(env)
    const grantFunction = grantFunctionFromEnv(env)
    const lambda = new LambdaClient({ region })
    deps = {
      store: s3Store(new S3Client({ region }), bucketFromEnv(env)), capture: sdkCaptureClients(pricingClient(), bedrockClient(region)), region, now: () => new Date(),
      baseUniverse: (env.BASE_UNIVERSE ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      ...(env.DEPLOY_INPUTS && /^[0-9a-f]{8,64}$/.test(env.DEPLOY_INPUTS) ? { deployInputs: env.DEPLOY_INPUTS } : {}),
      ...(grantFunction ? { invokeGrant: async () => {
        await lambda.send(new InvokeCommand({ FunctionName: grantFunction, InvocationType: 'Event', Payload: new TextEncoder().encode('{"action":"sync"}') }))
      } } : {}),
    }
  }
  return handleRefresh(event, deps)
}
