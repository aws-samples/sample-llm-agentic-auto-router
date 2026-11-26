// Lambda entry for the console API (a3's ConsoleStack; image shim infra/lambda/handlers/console-api.mjs). The AWS
// adapters are built once per container from the environment; a missing key fails the cold start (no partial API).
import { randomUUID } from 'node:crypto'
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control'
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch'
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { ECSClient } from '@aws-sdk/client-ecs'
import { LambdaClient } from '@aws-sdk/client-lambda'
import { S3Client } from '@aws-sdk/client-s3'
import { catalogRegions, findModel, loadCatalog } from '@auto-router/pricing'
import { bedrockTransport, createSigV4Signer } from '@auto-router/router'
import { createHandler } from './app.ts'
import { catalogView, withCatalog } from './catalog.ts'
import { createRulesTranslator, type RulesTranslator } from './rules-translate.ts'
import { DynamoConsoleStore, DynamoUsageStore, type Sender } from './aws/dynamo.ts'
import { AgentCoreGateway, CloudWatchHealth, CognitoClientDirectory, CognitoDirectory, EcsRouterTasks, LambdaInvoker, S3ObjectStore } from './aws/services.ts'
import type { HttpApiEvent, HttpApiResult } from './http.ts'
import type { BaseDeps } from './ports.ts'
import { activeVersion, routerState } from './routes/config.ts'

export interface AwsClients { dynamodb: Sender; s3: Sender; cognito: Sender; agentcore: Sender; cloudwatch: Sender; ecs: Sender; lambda?: Sender }

export class EnvError extends Error {
  constructor(missing: string[]) { super(`console-api: missing or invalid environment: ${missing.join(', ')}`); this.name = 'EnvError' }
}

const REQUIRED = ['CONSOLE_TABLE', 'USAGE_TABLE', 'CONFIG_BUCKET', 'USER_POOL_ID', 'PREFIX', 'CONSOLE_SCOPE', 'INVOKE_SCOPE', 'GATEWAY_ID',
  'MODEL_UNIVERSE', 'ROUTER_CLUSTER', 'ROUTER_SERVICE', 'CLI_CLIENT_ID'] as const
const list = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)

/**
 * The console-api dependencies from the Lambda environment (keys: a3's ConsoleStack). Optional: GATEWAY_URL,
 * INFERENCE_URL, COGNITO_DOMAIN (the authorize/token/revoke endpoints derive from it), CALLBACK_PORTS,
 * CODEX_OAUTH_PORT, IDENTITY_HEADER (empty = none; default x-api-key), REFRESH_DAYS (30), CATALOG_REGION (AWS_REGION),
 * METRICS_NAMESPACE (LlmAutoRouter), RECORD_RETENTION_DAYS (90), RESERVED_CLIENT_IDS (app clients never touched, besides CLI_CLIENT_ID),
 * CONSOLE_RULES_MODEL (rule translation model; empty or none = off), CATALOG_REFRESH_FUNCTION and CATALOG_GRANT_FUNCTION
 * (dynamic catalog C2b; both or neither).
 *
 * The bundled catalog of the Region is optional (dynamic catalog C3): each request reads the bucket's current one and
 * falls back to it; a Region without either answers 503 catalog-unavailable wherever a price is needed.
 */
export function depsFromEnv(env: NodeJS.ProcessEnv, clients: AwsClients): BaseDeps {
  const missing: string[] = REQUIRED.filter((k) => !env[k])
  const region = env.CATALOG_REGION || env.AWS_REGION || ''
  if (!region) missing.push('CATALOG_REGION|AWS_REGION')
  const ports = list(env.CALLBACK_PORTS).map(Number)
  if (ports.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535)) missing.push('CALLBACK_PORTS')
  const refreshDays = env.REFRESH_DAYS ? Number(env.REFRESH_DAYS) : 30
  if (!Number.isInteger(refreshDays) || refreshDays < 1) missing.push('REFRESH_DAYS')
  const retentionDays = env.RECORD_RETENTION_DAYS ? Number(env.RECORD_RETENTION_DAYS) : 90
  if (!Number.isInteger(retentionDays) || retentionDays < 1) missing.push('RECORD_RETENTION_DAYS')
  const codexPort = env.CODEX_OAUTH_PORT ? Number(env.CODEX_OAUTH_PORT) : undefined
  if (codexPort !== undefined && !Number.isInteger(codexPort)) missing.push('CODEX_OAUTH_PORT')
  // Rule translation (11-10-console-routing-ux): CONSOLE_RULES_MODEL names the model; empty or 'none' turns it off.
  const rulesModel = env.CONSOLE_RULES_MODEL && env.CONSOLE_RULES_MODEL !== 'none' ? env.CONSOLE_RULES_MODEL : undefined
  const catalog = region && catalogRegions().includes(region) ? loadCatalog(region) : undefined
  if (rulesModel && catalog && !findModel(catalog, rulesModel)) missing.push('CONSOLE_RULES_MODEL (not in the price catalog)')
  const refreshFn = env.CATALOG_REFRESH_FUNCTION || undefined
  const grantFn = env.CATALOG_GRANT_FUNCTION || undefined
  if ((refreshFn === undefined) !== (grantFn === undefined)) missing.push('CATALOG_REFRESH_FUNCTION and CATALOG_GRANT_FUNCTION (both or neither)')
  if (refreshFn && !clients.lambda) missing.push('lambda client')
  if (missing.length) throw new EnvError(missing)
  const domain = env.COGNITO_DOMAIN?.replace(/\/+$/, '')
  const console = new DynamoConsoleStore(clients.dynamodb, env.CONSOLE_TABLE as string)
  const usage = new DynamoUsageStore(clients.dynamodb, env.USAGE_TABLE as string, { retentionDays })
  const transport = () => bedrockTransport(new URL(`https://bedrock-runtime.${region}.amazonaws.com`), createSigV4Signer(region))
  let rules: RulesTranslator | undefined
  if (rulesModel && catalog) rules = createRulesTranslator({ model: rulesModel, catalog, transport: transport() })
  else if (rulesModel) {
    // No bundled catalog: the translator prices its call with the bucket's catalog, built on first use.
    let built: RulesTranslator | undefined
    rules = {
      model: rulesModel,
      async translate(...args) {
        if (!built) {
          const v = await catalogView(deps)
          if (!v) throw new Error('rules translator: no price catalog')
          built = createRulesTranslator({ model: rulesModel, catalog: v.catalog, transport: transport() })
        }
        return built.translate(...args)
      },
    }
  }
  const deps: BaseDeps = {
    console, usage, ...(catalog ? { catalog } : {}),
    objects: new S3ObjectStore(clients.s3, env.CONFIG_BUCKET as string),
    directory: new CognitoDirectory(clients.cognito, env.USER_POOL_ID as string),
    clients: new CognitoClientDirectory(clients.cognito, {
      userPoolId: env.USER_POOL_ID as string, prefix: env.PREFIX as string, invokeScope: env.INVOKE_SCOPE as string,
      reserved: [env.CLI_CLIENT_ID as string, ...list(env.RESERVED_CLIENT_IDS)],
    }),
    gateway: new AgentCoreGateway(clients.agentcore, env.GATEWAY_ID as string),
    tasks: new EcsRouterTasks(clients.ecs, env.ROUTER_CLUSTER as string, env.ROUTER_SERVICE as string),
    metrics: new CloudWatchHealth(clients.cloudwatch, clients.ecs, {
      namespace: env.METRICS_NAMESPACE || 'LlmAutoRouter', cluster: env.ROUTER_CLUSTER as string, service: env.ROUTER_SERVICE as string,
      alarmPrefix: env.PREFIX as string,
      activeVersion: async () => {
        const d = await withCatalog(deps)
        const a = await activeVersion(d)
        const st = await routerState(d, a)
        const rejections = (await usage.configReports(200)).filter((r) => (r.outcome ?? r.status) === 'rejected').length
        return { active: a.meta.version, ...(st.reportedVersion ? { reported: st.reportedVersion } : {}), rejections }
      },
    }),
    env: {
      prefix: env.PREFIX as string, consoleScope: env.CONSOLE_SCOPE as string, region,
      ...(env.GATEWAY_URL ? { gatewayUrl: env.GATEWAY_URL } : {}), ...(env.INFERENCE_URL ? { inferenceUrl: env.INFERENCE_URL } : {}),
      ...(domain ? { cognitoDomain: domain, authorizeEndpoint: `${domain}/oauth2/authorize`, tokenEndpoint: `${domain}/oauth2/token`, revokeEndpoint: `${domain}/oauth2/revoke` } : {}),
      cliClientId: env.CLI_CLIENT_ID as string, invokeScope: env.INVOKE_SCOPE as string, ...(ports.length ? { callbackPorts: ports } : {}),
      ...(codexPort !== undefined ? { codexOauthPort: codexPort } : {}),
      identityHeader: env.IDENTITY_HEADER === undefined ? 'x-api-key' : env.IDENTITY_HEADER === '' ? null : env.IDENTITY_HEADER,
      refreshDays, modelUniverse: list(env.MODEL_UNIVERSE), retentionDays,
      ...(refreshFn && grantFn ? { catalogRefreshFunction: refreshFn, catalogGrantFunction: grantFn } : {}),
    },
    ...(refreshFn && clients.lambda ? { invoker: new LambdaInvoker(clients.lambda) } : {}),
    ...(rules ? { rules } : {}),
    now: () => Date.now(),
    uuid: () => randomUUID(),
    // One JSON line per entry: ids and codes only (handlers never pass tokens, secrets or e-mail addresses).
    log: (e) => { process.stdout.write(`${JSON.stringify(e)}\n`) },
  }
  return deps
}

export function awsClients(region: string | undefined): AwsClients {
  const o = region ? { region } : {}
  return {
    dynamodb: new DynamoDBClient(o), s3: new S3Client(o), cognito: new CognitoIdentityProviderClient(o),
    agentcore: new BedrockAgentCoreControlClient(o), cloudwatch: new CloudWatchClient(o), ecs: new ECSClient(o), lambda: new LambdaClient(o),
  }
}

let cached: ((event: HttpApiEvent) => Promise<HttpApiResult>) | undefined

export async function handler(event: HttpApiEvent): Promise<HttpApiResult> {
  cached ??= createHandler(depsFromEnv(process.env, awsClients(process.env.AWS_REGION)))
  return cached(event)
}
