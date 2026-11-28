// Router stack (design §3/§4, hop shape verified in V9d). Every deployment value comes from Settings (settings.ts).
//
//   client --JWT (Cognito client credentials)--> AgentCore Gateway (CUSTOM_JWT)
//     -> SigV4 execute-api, managed private endpoint (routingDomain = execute-api VPC endpoint)
//     -> private REST API (AWS_IAM; resource policy: the gateway role through this endpoint only)
//     -> VPC link -> internal NLB (SG: no ingress; PrivateLink traffic only) -> ECS Fargate router
//     -> bedrock-runtime / ECR / Logs interface endpoints + S3 gateway endpoint (no IGW, no NAT unless a provider
//        egress mode adds them: firewall or nat-dns, egress.ts)
//     -> with -c stateStore=dynamodb: the router state table through a DynamoDB gateway endpoint
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  Aws, type CfnElement, CfnOutput, CfnParameter, type CfnResource, Duration, Fn, IgnoreMode, RemovalPolicy, Stack, type StackProps, Validations,
  aws_apigateway as apigw, aws_bedrockagentcore as agentcore, aws_cognito as cognito, aws_dynamodb as ddb, aws_ec2 as ec2,
  aws_ecr_assets as ecrAssets, aws_ecs as ecs, aws_elasticloadbalancingv2 as elbv2, aws_events as events,
  aws_events_targets as eventsTargets, aws_iam as iam, aws_lambda as lambda, aws_logs as logs, aws_s3 as s3, aws_s3_deployment as s3deploy, aws_ssm as ssm,
  CustomResource, custom_resources as cr, triggers,
} from 'aws-cdk-lib'
import { boundaryBedrockStatements, DEPLOY_INPUTS_KEY, DYN_POLICY_SLOTS, dynPolicyArn, GRANT_DRAINING_KEY, UNCONFIRM_DELAY_MS } from '@auto-router/catalog-service'
import { catalogKeys, managedSecretName, providerKeys } from '@auto-router/pricing'
import type { Construct } from 'constructs'
import { BAKED_KEY, bakedArtifact, bakedVersionKey, type BakedArtifact } from './baked.ts'
import { routerParamName, type RouterParam } from './console-stack.ts'
import { baseModelId, INVOKE_ACTIONS, invokeStatements, PROJECT_ACTIONS, responsesProjectStatement, type DeployModels } from './models.ts'
import { EgressFirewall, EgressNatDns } from './egress.ts'
import type { Settings } from './settings.ts'

export const ROUTER_PORT = 8080
/** REST API stage name: the gateway appends the operation path, so `/v1/messages` maps with no providerPath. */
export const STAGE = 'v1'
/** API Gateway REST payload cap (V9d: 12 MB gets 413 at the API). The router rejects above it too. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024
/**
 * Request headers the gateway forwards to the router (at most 10). `x-api-key` carries the client's Cognito access
 * token a second time; the router verifies it (admin console design v1 0.1, spike C1: forwarded unchanged).
 */
export const REQUEST_HEADERS = [
  'x-claude-code-session-id', 'x-session-id', 'anthropic-beta', 'anthropic-version', 'openai-beta',
  'x-router-session', 'x-router-parent-session', 'x-router-agent-id', 'x-router-hint', 'x-api-key',
]
/** Gateway rule priorities (lower number first): auto* and the catch-all both route only to the router. */
export const RULE_PRIORITY = { auto: 100, catchAll: 1_000_000 } as const
/** Identity objects the router reads from the config bucket (router identity.ts, runtime config). */
/** providers/active.json of a deploy without -c providersFile (design 11-28 P3: the console reads it). */
export const EMPTY_REGISTRY = { schemaVersion: 1, version: 'none', providers: [] } as const
export const CONFIG_KEYS = { document: 'config/active.json', identityPrefix: 'identity/', jwks: 'identity/jwks.json' } as const
/** jwks-sync period: a Cognito key rotation is picked up within this, plus the router's 30 s poll. */
export const JWKS_SYNC_MINUTES = 5
/**
 * jwks-sync (inline, CommonJS, AWS SDK v3 from the Lambda runtime): copies the pool's JWKS into identity/jwks.json when it
 * changed. Shape checks only; the router validates the keys on load and keeps the last good set.
 */
export const JWKS_SYNC_CODE = `const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});
const log = (o) => console.log(JSON.stringify({ kind: 'jwks-sync', ...o }));
exports.handler = async () => {
  const res = await fetch(process.env.JWKS_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('jwks fetch HTTP ' + res.status);
  const doc = JSON.parse(await res.text());
  const keys = Array.isArray(doc && doc.keys) ? doc.keys : [];
  if (keys.length < 1 || keys.length > 10 || !keys.every((k) => k && k.kty === 'RSA' && typeof k.kid === 'string' && typeof k.n === 'string' && typeof k.e === 'string')) throw new Error('jwks shape');
  const body = JSON.stringify({ keys: keys.map((k) => ({ kid: k.kid, kty: k.kty, alg: k.alg, use: k.use, n: k.n, e: k.e })) });
  const Bucket = process.env.BUCKET, Key = process.env.KEY;
  let current;
  try { current = await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToString(); } catch (e) { if (e.name !== 'NoSuchKey') throw e; }
  if (current === body) { log({ outcome: 'unchanged', keys: keys.length }); return; }
  await s3.send(new PutObjectCommand({ Bucket, Key, Body: body, ContentType: 'application/json' }));
  log({ outcome: 'written', keys: keys.length });
};`
export const RESPONSE_HEADERS = ['x-router-decision', 'x-router-model', 'x-router-reason']
const PATHS = ['/v1/messages', '/v1/chat/completions', '/v1/responses'] as const
/**
 * Integration request headers set by API Gateway. The identity values come from the IAM-verified caller; client
 * values for these names are overwritten (V9d check 3). x-amz-security-token is the gateway role's session token,
 * which API Gateway would otherwise pass through: it is replaced with a constant.
 */
export const INTEGRATION_HEADERS: Readonly<Record<string, string>> = {
  'integration.request.header.x-router-caller-arn': 'context.identity.userArn',
  'integration.request.header.x-router-source-vpce': 'context.identity.vpceId',
  'integration.request.header.x-amz-security-token': "'redacted'",
}

const GEO_REASON = 'A geographic cross-Region inference profile routes to the foundation model in any destination Region of the profile; '
  + 'the statement is limited to these profiles with bedrock:InferenceProfileArn.'
const REPO_ROOT = new URL('../../', import.meta.url).pathname
/** Image CMDs of infra/lambda/catalog.Dockerfile (one handler per function). */
export const CATALOG_LAMBDA_CMD = {
  grant: 'handlers/catalog-grant.handler', grantCleanup: 'handlers/catalog-grant-cleanup.handler', refresh: 'handlers/catalog-refresh.handler',
  providerDns: 'handlers/catalog-provider-dns.handler',
} as const
/** Catalog objects the router reads (C3): the pointer, the granted universe and the immutable versions. */
export const ROUTER_CATALOG_READS = [catalogKeys.current, catalogKeys.universe, `${catalogKeys.versionsPrefix}*`] as const
/** Catalog objects only catalog-refresh writes (bucket policy) and only catalog-grant writes. */
export const REFRESH_ONLY_KEYS = [`${catalogKeys.versionsPrefix}*`, `${catalogKeys.changesPrefix}*`, `${catalogKeys.snapshotsPrefix}*`, catalogKeys.notices,
  DEPLOY_INPUTS_KEY] as const
export const GRANT_ONLY_KEYS = [catalogKeys.universe] as const
/** Written only by catalog-grant-cleanup at stack delete; grant syncs refuse while it exists. */
export const CLEANUP_ONLY_KEYS = [GRANT_DRAINING_KEY] as const
/** Shared writers' keys: refresh, grant and console-api only (bucket policy allowlist). */
export const SHARED_CATALOG_KEYS = [catalogKeys.models, catalogKeys.current] as const
/** Noncurrent object versions under catalog/ expire after this (the current versions stay: they are referenced). */
export const CATALOG_NONCURRENT_DAYS = 30
const DELETE_ACTIONS = ['s3:DeleteObject', 's3:DeleteObjectVersion'] as const
/** Daily scheduled refresh (UTC). */
export const REFRESH_SCHEDULE = { minute: '0', hour: '3' } as const
/** Wait after a dynamic-grant change before the grant Lambda reports success (IAM is eventually consistent). */
export const GRANT_PROPAGATION_DELAY_MS = 10_000
/**
 * Un-confirm: wait between writing catalog/universe.json without a model and revoking its grant. At least one router
 * config poll (ROUTER_CONFIG_POLL_MS, 30 s by default; the stack does not change it) plus a margin.
 */
export const GRANT_UNCONFIRM_DELAY_MS = UNCONFIRM_DELAY_MS
/** catalog-grant timeout: the un-confirm wait, the IAM sync with its read-back and propagation wait, and conflict retries. */
export const GRANT_TIMEOUT_S = 180
/**
 * Router container stopTimeout: the Fargate maximum (ECS ContainerDefinition: 2-120 s on Fargate, default 30). ECS sends
 * SIGTERM, then SIGKILL this long after it. LLM streams run for minutes, so the router gets the longest stop ECS allows.
 */
export const STOP_TIMEOUT_S = 120
/**
 * Left between the router's own deadline and SIGKILL: the aborted requests record their state and write their log lines
 * (usage billed so far), and the process flushes stdout and exits. The router bounds this at 9 s (server.ts
 * SHUTDOWN_LOG_MS plus main.ts EXIT_FLUSH_MS).
 */
export const SHUTDOWN_MARGIN_S = 15
/**
 * ROUTER_SHUTDOWN_GRACE_MS: after SIGTERM the router stops accepting connections, lets in-flight requests finish for
 * this long, then aborts the rest. Derived from the stop timeout, so the two cannot drift.
 */
export const SHUTDOWN_GRACE_MS = (STOP_TIMEOUT_S - SHUTDOWN_MARGIN_S) * 1000
/**
 * NLB target group deregistration delay, kept at 30 s. The stop sequence of a service task behind a load balancer (ECS
 * task lifecycle; ECS "connection draining" guide):
 *   1. DEACTIVATING: ECS deregisters the target and waits for the load balancer to report it `unused`, which the NLB
 *      does after this delay. The router is not signalled and serves as usual; the NLB stops opening connections to it
 *      (a few may still arrive while the change propagates) and existing connections carry on.
 *   2. STOPPING: only now ECS sends SIGTERM, and SIGKILL after STOP_TIMEOUT_S.
 * So the delay is not the router's drain window. It has to cover the propagation of the deregistration, so that no new
 * connection arrives once the router stops accepting at SIGTERM. A running stream gets this delay plus
 * SHUTDOWN_GRACE_MS (135 s) to finish. A longer delay (the NLB guide recommends at least 120 s so that requests
 * complete; here the router's grace period does that) would add its seconds to that window and to every task stop of
 * every deploy (150 s worst case now), with the router still unaware that it is draining. This holds only while the NLB keeps established connections after the delay:
 * `deregistration_delay.connection_termination.enabled` must stay false (the default for TCP target groups; the stack
 * sets it explicitly). With true, the NLB would close every stream at the end of the delay, before SIGTERM.
 */
export const DEREGISTRATION_DELAY_S = 30
/** routerAutoscale cooldowns: add tasks after a minute, remove them only after five (a task stop drains for up to 165 s). */
export const SCALE_OUT_COOLDOWN_S = 60
export const SCALE_IN_COOLDOWN_S = 300
/** Router state table (-c stateStore=dynamodb): the item key, the TTL attribute and the only actions the router uses (its contract). */
export const STATE_TABLE = { partitionKey: 'pk', ttlAttribute: 'exp' } as const
export const STATE_TABLE_ACTIONS = ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'] as const

/** infra/lambda/catalog.Dockerfile: the router stack's catalog Lambdas (packages/catalog-service, packages/pricing, packages/core). */
export const catalogLambdaCode = (_: Construct, cmd: string): lambda.DockerImageCode => lambda.DockerImageCode.fromImageAsset(REPO_ROOT, {
  file: 'infra/lambda/catalog.Dockerfile', cmd: [cmd], platform: ecrAssets.Platform.LINUX_ARM64, ignoreMode: IgnoreMode.DOCKER,
  exclude: ['**', '!package.json', '!pnpm-lock.yaml', '!pnpm-workspace.yaml', '!tsconfig.base.json', '!infra/lambda/catalog.Dockerfile',
    '!infra/lambda/handlers/catalog-*.mjs', ...['pricing', 'core', 'catalog-service'].flatMap((p) => [`!packages/${p}/package.json`, `!packages/${p}/src/**`]),
    '**/node_modules'],
})

/** Router env for the identity gate (router identity.ts): the env default mode, the pool issuer and the invoke scope. */
export function identityEnv(mode: Settings['identity']['mode'], issuer: string, scope: string): Record<string, string> {
  return { ROUTER_IDENTITY_MODE: mode, ROUTER_IDENTITY_HEADER: 'x-api-key', ROUTER_IDENTITY_ISSUER: issuer, ROUTER_IDENTITY_SCOPE: scope }
}

/** Router env for the assessor settings; unset fields keep the router's defaults. */
export function assessorEnv(a: Settings['assessor']): Record<string, string> {
  if (!a) return {}
  return {
    ROUTER_ASSESSOR_MODE: a.mode,
    ...(a.model ? { ROUTER_ASSESSOR_MODEL: a.model } : {}),
    ...(a.threshold ? { ROUTER_ASSESSOR_THRESHOLD: a.threshold } : {}),
    ...(a.pack ? { ROUTER_ASSESSOR_PACK: a.pack } : {}),
    ...(a.timeoutMs ? { ROUTER_ASSESSOR_TIMEOUT_MS: a.timeoutMs } : {}),
    ...(a.autoRules ? { ROUTER_ASSESSOR_AUTO_RULES: a.autoRules } : {}),
  }
}

export interface RouterStackProps extends StackProps {
  settings: Settings
  models: DeployModels
  /** Router image; defaults to building packages/router/Dockerfile (ARM64) as a CDK asset. */
  image?: ecs.ContainerImage
  /**
   * Staged packs archive (`<dir>/packs/current.json` + `<dir>/packs/<packVersion>.json`, from the committed manifest:
   * stagePacksArchive in packs.ts). Uploaded to the config bucket root without pruning, so the packs of older images
   * stay readable for old records. Absent: no upload.
   */
  packsArchiveDir?: string
  /** Code of the router stack's catalog Lambdas for an image CMD; defaults to infra/lambda/catalog.Dockerfile. Tests inject a registry image. */
  lambdaCode?: (scope: Construct, cmd: string) => lambda.DockerImageCode
}

export class RouterStack extends Stack {
  readonly gatewayName: string
  /** The baked configuration document staged as config/baked.json (from the router env's own inputs). */
  readonly baked: BakedArtifact
  /**
   * Subnets are placed by AZ ID (cfg.azIds), so the AZ names CDK would look up for a concrete account/Region (a
   * context lookup that needs credentials at synth) are never used; two Fn::GetAZs placeholders keep synth offline.
   */
  // Nothing may consume these AZ-name placeholders (e.g. EFS mount targets, lookupSupportedAzs): subnets use AZ IDs.
  override get availabilityZones(): string[] {
    return [Fn.select(0, Fn.getAzs()), Fn.select(1, Fn.getAzs())]
  }
  constructor(scope: Construct, id: string, props: RouterStackProps) {
    super(scope, id, props)
    const { settings: cfg, models } = props
    const n = (x: string) => `${cfg.prefix}-${x}`
    this.gatewayName = n('gw')
    const invokeScope = `${cfg.prefix}/invoke`
    const s3Pl = new CfnParameter(this, 'S3PrefixListId', {
      type: 'String', allowedPattern: '^pl-[0-9a-f]+$', description: `com.amazonaws.${cfg.region}.s3 managed prefix list (ECR image layers)`,
    }).valueAsString
    // -c stateStore=dynamodb only: with memory the template has no parameter, table, endpoint or env for it, so existing
    // deployments and their deploy commands are unchanged.
    const ddbPl = cfg.stateStore === 'dynamodb' ? new CfnParameter(this, 'DynamoDbPrefixListId', {
      type: 'String', allowedPattern: '^pl-[0-9a-f]+$', description: `com.amazonaws.${cfg.region}.dynamodb managed prefix list (router state table)`,
    }).valueAsString : undefined

    // ---------------------------------------------------------------- network: private isolated subnets only
    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: n('vpc'), ipAddresses: ec2.IpAddresses.cidr('10.90.0.0/24'), maxAzs: 2, natGateways: 0,
      subnetConfiguration: [{ name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 26 }],
      restrictDefaultSecurityGroup: true, // strips the default SG's rules (CDK custom resource)
    })
    vpc.isolatedSubnets.forEach((subnet, i) => {
      const cfn = subnet.node.defaultChild as ec2.CfnSubnet
      cfn.addPropertyDeletionOverride('AvailabilityZone')
      cfn.addPropertyOverride('AvailabilityZoneId', cfg.azIds[i]) // AgentCore managed private endpoints need supported AZ IDs
    })
    // The default-SG restriction is a CDK custom-resource provider (raw CfnResources the Tags aspect skips): tag it.
    const crp = this.node.tryFindChild('Custom::VpcRestrictDefaultSGCustomResourceProvider')
    for (const id of ['Role', 'Handler']) {
      (crp?.node.tryFindChild(id) as CfnResource | undefined)?.addPropertyOverride('Tags', Object.entries(cfg.tags).map(([Key, Value]) => ({ Key, Value })))
    }
    const flowLogs = new logs.LogGroup(this, 'FlowLogs', { logGroupName: `/${cfg.prefix}/vpc-flow`, retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY })
    vpc.addFlowLog('Flow', { destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogs), trafficType: ec2.FlowLogTrafficType.REJECT })
    const subnets = { subnets: vpc.isolatedSubnets }

    const sg = (id: string, name: string, description: string) => new ec2.SecurityGroup(this, id, { vpc, securityGroupName: n(name), description, allowAllOutbound: false })
    const routerSg = sg('RouterSg', 'router', 'router task: 8080 from the NLB only; 443 to endpoints and S3')
    const nlbSg = sg('NlbSg', 'nlb', 'internal NLB: no ingress rules (VPC link / PrivateLink traffic only); 8080 to the router')
    const endpointSg = sg('EndpointSg', 'endpoints', 'AWS service endpoints: 443 from the router only')
    const rgwSg = sg('ResourceGatewaySg', 'gw-egress', 'AgentCore managed resource gateway: egress 443 to the execute-api endpoint only')
    const apiVpceSg = sg('ApiVpceSg', 'api-vpce', 'execute-api endpoint: 443 from the AgentCore resource gateway only')
    routerSg.addIngressRule(nlbSg, ec2.Port.tcp(ROUTER_PORT), 'NLB traffic and health checks')
    nlbSg.addEgressRule(routerSg, ec2.Port.tcp(ROUTER_PORT), 'router tasks')
    routerSg.addEgressRule(endpointSg, ec2.Port.tcp(443), 'AWS service endpoints')
    routerSg.addEgressRule(ec2.Peer.prefixList(s3Pl), ec2.Port.tcp(443), 'S3 gateway endpoint (ECR image layers)')
    // A gateway endpoint is a route to the service's public addresses: the task SG must allow them (the SG's description
    // above still says "endpoints and S3": changing a description replaces the security group).
    if (ddbPl) routerSg.addEgressRule(ec2.Peer.prefixList(ddbPl), ec2.Port.tcp(443), 'DynamoDB gateway endpoint (router state table)')
    endpointSg.addIngressRule(routerSg, ec2.Port.tcp(443), 'router tasks')
    rgwSg.addEgressRule(apiVpceSg, ec2.Port.tcp(443), 'execute-api endpoint')
    apiVpceSg.addIngressRule(rgwSg, ec2.Port.tcp(443), 'AgentCore managed resource gateway')

    const bedrockVpce = vpc.addInterfaceEndpoint('BedrockRuntime', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME, subnets, securityGroups: [endpointSg], privateDnsEnabled: true, open: false,
    })
    for (const [eid, service] of [['EcrApi', ec2.InterfaceVpcEndpointAwsService.ECR],
      ['EcrDkr', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER], ['Logs', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS]] as const) {
      vpc.addInterfaceEndpoint(eid, { service, subnets, securityGroups: [endpointSg], privateDnsEnabled: true, open: false })
    }
    const s3Endpoint = vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3, subnets: [subnets] })
    // External providers (design 11-28 §5, ADR 0001): private endpoints only, by explicit CIDR; routes and DNS are the
    // deployer's. A registry with Secrets Manager secrets adds this VPC's secretsmanager endpoint.
    for (const e of cfg.providerEgress ?? []) routerSg.addEgressRule(ec2.Peer.ipv4(e.cidr), ec2.Port.tcp(e.port), 'external provider endpoint (providerEgress)')
    // Public provider egress (P2, egress.ts): only with an explicit providerEgressMode. firewall: NAT behind a Network
    // Firewall that passes TLS on 443 to the registry's hostnames; nat-dns: NAT with a DNS Firewall that resolves only
    // AWS service names and the registry's hostnames (ADR 0003); bring-your-own: the deployer's route and filtering.
    // Both NAT modes use the construct id ProviderEgress: their shared NAT layer keeps its logical ids across a switch.
    if (cfg.providerEgressMode === 'firewall' || cfg.providerEgressMode === 'nat-dns' || (cfg.providerEgressMode === 'bring-your-own' && !cfg.providerEgress?.length)) {
      routerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), `external providers on the internet (providerEgressMode=${cfg.providerEgressMode})`)
    }
    if (cfg.providerEgressMode === 'firewall') {
      new EgressFirewall(this, 'ProviderEgress', { prefix: cfg.prefix, vpc, routerSubnets: vpc.isolatedSubnets, azIds: cfg.azIds, azs: cfg.providerEgressAzs ?? 2, hosts: models.egressHosts })
    }
    // nat-dns: the provider allow list's content is not in the template; provider-dns-sync (below) keeps it.
    const natDns = cfg.providerEgressMode === 'nat-dns'
      ? new EgressNatDns(this, 'ProviderEgress', { prefix: cfg.prefix, vpc, routerSubnets: vpc.isolatedSubnets, azIds: cfg.azIds, azs: cfg.providerEgressAzs ?? 2 })
      : undefined
    if (cfg.providerEgressMode === 'bring-your-own') {
      new CfnOutput(this, 'RouterRouteTableIds', {
        value: Fn.join(',', vpc.isolatedSubnets.map((x) => x.routeTable.routeTableId)),
        description: 'providerEgressMode=bring-your-own: add your egress route (e.g. 0.0.0.0/0 to a transit gateway) to these route tables',
      })
    }
    // Provider secrets (ADR 0002): the deployer's arns (providersFile) and, with any egress mode, the console-written
    // `<prefix>/providers/*`. Read only through this VPC's secretsmanager endpoint.
    const providerSecretResources = [...models.providerSecretArns,
      ...(cfg.providerEgressMode ? [`arn:${Aws.PARTITION}:secretsmanager:${cfg.region}:${Aws.ACCOUNT_ID}:secret:${managedSecretName(cfg.prefix, 'x').replace(/x$/, '*')}`] : [])]
    const secretsVpce = providerSecretResources.length
      ? vpc.addInterfaceEndpoint('SecretsManager', { service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER, subnets, securityGroups: [endpointSg], privateDnsEnabled: true, open: false })
      : undefined

    // ---------------------------------------------------------------- inbound auth: Cognito (machine clients and members)
    // Members are admin-created only (no self sign-up). MFA is off by deployer decision for this sample (the live pool's
    // setting); production deployments should require TOTP MFA (mfa: REQUIRED, mfaSecondFactor { otp: true }).
    // Account recovery is e-mail only: members are invited by e-mail and have no phone numbers.
    const pool = new cognito.UserPool(this, 'Users', {
      userPoolName: n('users'), selfSignUpEnabled: false, signInAliases: { username: true }, removalPolicy: RemovalPolicy.DESTROY,
      passwordPolicy: { minLength: 14, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      featurePlan: cognito.FeaturePlan.ESSENTIALS, deletionProtection: false,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    })
    const scopeDef = new cognito.ResourceServerScope({ scopeName: 'invoke', scopeDescription: 'Call the router through the gateway' })
    // `console`: the admin console API (ConsoleStack's console client); never granted to router callers.
    const consoleScopeDef = new cognito.ResourceServerScope({ scopeName: 'console', scopeDescription: 'Call the admin console API' })
    const rs = pool.addResourceServer('Api', { identifier: cfg.prefix, scopes: [scopeDef, consoleScopeDef] })
    const client = pool.addClient('Agent', {
      userPoolClientName: n('agent-m2m'), generateSecret: true, authFlows: {}, preventUserExistenceErrors: true,
      oAuth: { flows: { clientCredentials: true }, scopes: [cognito.OAuthScope.resourceServer(rs, scopeDef)] },
      accessTokenValidity: Duration.minutes(60),
    })
    // Globally unique, non-identifying prefix: the first block of the stack GUID (never the account id).
    const suffix = Fn.select(0, Fn.split('-', Fn.select(2, Fn.split('/', Aws.STACK_ID))))
    const domain = pool.addDomain('Domain', { cognitoDomain: { domainPrefix: Fn.join('-', [cfg.prefix, suffix]) },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN })
    // Member CLI (llmar login, Codex gateway_oauth): public client, auth code + PKCE on 127.0.0.1 loopback callbacks.
    const cliPorts = [...cfg.identity.cliRedirectPorts, cfg.identity.codexOauthPort]
    const cli = pool.addClient('Cli', {
      userPoolClientName: n('cli'), generateSecret: false, authFlows: {}, preventUserExistenceErrors: true, enableTokenRevocation: true,
      oAuth: { flows: { authorizationCodeGrant: true }, scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.resourceServer(rs, scopeDef)],
        callbackUrls: cliPorts.map((p) => `http://127.0.0.1:${p}/callback`) },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.minutes(60), idTokenValidity: Duration.minutes(60), refreshTokenValidity: Duration.days(cfg.identity.cliRefreshDays),
    })
    ;(cli.node.defaultChild as cognito.CfnUserPoolClient).refreshTokenRotation = { feature: 'ENABLED', retryGracePeriodSeconds: 30 }
    // Managed login v2: an interactive client without a branding style has no sign-in pages.
    new cognito.CfnManagedLoginBranding(this, 'CliBranding', { userPoolId: pool.userPoolId, clientId: cli.userPoolClientId, useCognitoProvidedValues: true })
      .node.addDependency(domain)

    // ---------------------------------------------------------------- gateway role (router hop signer only; no Bedrock access)
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      roleName: n('gateway-role'),
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', { conditions: {
        StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
        ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:gateway/${this.gatewayName}-*` },
      } }),
    })
    const grantInvoke = (role: iam.Role, ids: readonly string[], responsesIds: readonly string[], sidPrefix: string) => {
      for (const st of invokeStatements(ids, models.meta, cfg.region, Aws.ACCOUNT_ID)) {
        role.addToPolicy(new iam.PolicyStatement({ sid: `${sidPrefix}${st.sid}`, actions: [...INVOKE_ACTIONS],
          resources: st.resources, ...(st.conditions ? { conditions: st.conditions } : {}) }))
      }
      const project = responsesProjectStatement(responsesIds, cfg.region, Aws.ACCOUNT_ID)
      if (project) role.addToPolicy(new iam.PolicyStatement({ sid: `${sidPrefix}${project.sid}`, actions: [...PROJECT_ACTIONS], resources: project.resources, conditions: project.conditions }))
    }

    // ---------------------------------------------------------------- execute-api endpoint (private DNS off) + NLB
    // The endpoint policy admits only the gateway role (the API's resource policy names the endpoint, so the endpoint
    // policy cannot name the API without a template cycle; the role's own policy limits it to this API).
    const apiVpce = vpc.addInterfaceEndpoint('ExecuteApi', {
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY, subnets, securityGroups: [apiVpceSg], privateDnsEnabled: false, open: false,
    })
    apiVpce.addToPolicy(new iam.PolicyStatement({
      principals: [new iam.ArnPrincipal(gatewayRole.roleArn)], actions: ['execute-api:Invoke'],
      resources: [`arn:aws:execute-api:${Aws.REGION}:${Aws.ACCOUNT_ID}:*/${STAGE}/*/*`],
    }))
    const vpceDns = Fn.select(1, Fn.split(':', Fn.select(0, apiVpce.vpcEndpointDnsEntries)))

    const nlb = new elbv2.NetworkLoadBalancer(this, 'Nlb', {
      loadBalancerName: n('nlb'), vpc, internetFacing: false, vpcSubnets: subnets, securityGroups: [nlbSg],
      enforceSecurityGroupInboundRulesOnPrivateLinkTraffic: false, crossZoneEnabled: true,
    })
    const nlbListener = nlb.addListener('Router', { port: ROUTER_PORT, protocol: elbv2.Protocol.TCP })
    const vpcLink = new apigw.CfnVpcLink(this, 'VpcLink', { name: n('link'), targetArns: [nlb.loadBalancerArn] })

    // ---------------------------------------------------------------- private REST API (AWS_IAM, streaming)
    const api = new apigw.CfnRestApi(this, 'RouterApi', {
      name: n('api'), description: 'llm-auto-router hop (private, AWS_IAM)',
      endpointConfiguration: { types: ['PRIVATE'], vpcEndpointIds: [apiVpce.vpcEndpointId] },
      policy: { Version: '2012-10-17', Statement: [
        { Sid: 'GatewayRoleViaEndpoint', Effect: 'Allow', Principal: { AWS: gatewayRole.roleArn }, Action: 'execute-api:Invoke',
          Resource: `execute-api:/${STAGE}/*/*`, Condition: { StringEquals: { 'aws:SourceVpce': apiVpce.vpcEndpointId } } },
        { Sid: 'DenyOtherEndpoints', Effect: 'Deny', Principal: '*', Action: 'execute-api:Invoke', Resource: 'execute-api:/*',
          Condition: { StringNotEquals: { 'aws:SourceVpce': apiVpce.vpcEndpointId } } },
        // Same account: an identity-policy Allow alone would admit any role, so every other principal is denied explicitly.
        { Sid: 'DenyOtherPrincipals', Effect: 'Deny', Principal: '*', Action: 'execute-api:Invoke', Resource: 'execute-api:/*',
          Condition: { ArnNotEquals: { 'aws:PrincipalArn': gatewayRole.roleArn } } },
      ] },
    })
    const proxy = new apigw.CfnResource(this, 'ProxyResource', { restApiId: api.ref, parentId: api.attrRootResourceId, pathPart: '{proxy+}' })
    const method = new apigw.CfnMethod(this, 'ProxyAny', {
      restApiId: api.ref, resourceId: proxy.ref, httpMethod: 'ANY', authorizationType: 'AWS_IAM',
      requestParameters: { 'method.request.path.proxy': true },
      integration: {
        type: 'HTTP_PROXY', integrationHttpMethod: 'ANY', connectionType: 'VPC_LINK', connectionId: vpcLink.ref,
        uri: `http://${nlb.loadBalancerDnsName}:${ROUTER_PORT}/${STAGE}/{proxy}`,
        requestParameters: { 'integration.request.path.proxy': 'method.request.path.proxy', ...INTEGRATION_HEADERS },
        responseTransferMode: 'STREAM', timeoutInMillis: 900_000, passthroughBehavior: 'WHEN_NO_MATCH',
      },
    })
    const deployment = new apigw.CfnDeployment(this, 'ApiDeployment', { restApiId: api.ref, description: 'router hop' })
    deployment.node.addDependency(method)
    // Stage throttling: API Gateway and Bedrock quotas are shared by everything in the account and Region.
    const stage = new apigw.CfnStage(this, 'ApiStage', {
      restApiId: api.ref, deploymentId: deployment.ref, stageName: STAGE,
      methodSettings: [{ resourcePath: '/*', httpMethod: '*', throttlingRateLimit: cfg.throttle.rate, throttlingBurstLimit: cfg.throttle.burst }],
    })
    gatewayRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeRouterApi', actions: ['execute-api:Invoke'], resources: [`arn:aws:execute-api:${Aws.REGION}:${Aws.ACCOUNT_ID}:${api.ref}/${STAGE}/*/*`],
    }))

    // ---------------------------------------------------------------- AgentCore Gateway (CUSTOM_JWT)
    const gateway = new agentcore.CfnGateway(this, 'Gateway', {
      name: this.gatewayName, authorizerType: 'CUSTOM_JWT', roleArn: gatewayRole.roleArn, description: 'llm-auto-router front door',
      authorizerConfiguration: { customJwtAuthorizer: {
        discoveryUrl: `https://cognito-idp.${Aws.REGION}.amazonaws.com/${pool.userPoolId}/.well-known/openid-configuration`,
        // Scope-only (design v1 0.4): any client an admin gave the invoke scope (agent, cli, service clients) passes;
        // the console client never has it. The router verifies the caller again from x-api-key.
        allowedScopes: [invokeScope],
      } },
    })
    const routerTarget = new agentcore.CfnGatewayTarget(this, 'RouterTarget', {
      gatewayIdentifier: gateway.attrGatewayIdentifier, name: 'router', description: 'llm-auto-router data plane (private REST API, SigV4)',
      targetConfiguration: { inference: { provider: {
        endpoint: `https://${api.ref}.execute-api.${cfg.region}.amazonaws.com`,
        operations: PATHS.map((path) => ({ path, models: [{ model: 'auto' }, { model: 'auto:*' }] })),
      } } },
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE', credentialProvider: { iamCredentialProvider: { service: 'execute-api', region: cfg.region } } }],
      privateEndpoint: { managedVpcResource: {
        vpcIdentifier: vpc.vpcId, subnetIds: vpc.isolatedSubnets.map((x) => x.subnetId), endpointIpAddressType: 'IPV4',
        securityGroupIds: [rgwSg.securityGroupId], routingDomain: vpceDns, tags: cfg.tags,
      } },
      metadataConfiguration: { allowedRequestHeaders: REQUEST_HEADERS, allowedResponseHeaders: RESPONSE_HEADERS },
    })
    // Target creation runs model discovery (GET /v1/models) through the stage, so the API must be deployed first.
    routerTarget.node.addDependency(stage)
    // Fail closed: router errors, connection failures and timeouts return to the client. There is no fallback
    // target that could bypass the router's identity checks, routing policy or accounting.
    // CloudFormation documents MatchModels; this aws-cdk-lib's L1 and bundled schema predate it.
    const rule = new agentcore.CfnGatewayRule(this, 'RouteAuto', {
      gatewayIdentifier: gateway.attrGatewayIdentifier, priority: RULE_PRIORITY.auto,
      description: 'auto* -> router only; fail closed on router errors or unavailability',
      actions: [{ routeToTarget: { staticRoute: { targetName: 'router' } } }],
    })
    rule.addPropertyOverride('Conditions', [
      { MatchModels: { AnyOf: [{ Value: 'auto', Operator: 'StringEquals' }, { Value: 'auto:*', Operator: 'StringLike' }] } },
    ])
    // Target creation runs model discovery with the gateway role (execute-api for the router).
    // addToPolicy grants live in the role's separate DefaultPolicy resource, so the target must wait for it,
    // or discovery races the policy attachment and the target goes FAILED (seen on the first MVP deploy).
    const gatewayPolicy = gatewayRole.node.tryFindChild('DefaultPolicy')
    if (!gatewayPolicy) throw new Error('gateway role has no DefaultPolicy')
    routerTarget.node.addDependency(gatewayPolicy)
    rule.node.addDependency(routerTarget)
    Validations.of(rule).acknowledge({ id: 'CloudFormation-Validate::F3018',
      reason: 'MatchModels is a documented AWS::BedrockAgentCore::GatewayRule property; the schema bundled with aws-cdk-lib predates it.' })
    // Catch-all (no conditions, lowest precedence): every other model id goes to the router too, so a concrete Bedrock id
    // can no longer reach the bedrock target directly and skip the router's identity checks (design v1 0.3, spike C1 S7).
    // The router answers ids outside its policy with 400 pin-not-allowed. This route also has no fallback.
    const catchAll = new agentcore.CfnGatewayRule(this, 'RouteCatchAll', {
      gatewayIdentifier: gateway.attrGatewayIdentifier, priority: RULE_PRIORITY.catchAll,
      description: 'every other model id -> router (identity checks, pin-not-allowed); no direct bedrock target access',
      actions: [{ routeToTarget: { staticRoute: { targetName: 'router' } } }],
    })
    catchAll.node.addDependency(routerTarget)
    catchAll.node.addDependency(rule)

    // ---------------------------------------------------------------- config bucket (runtime config, identity objects)
    // Written by the console (config/, identity/blocks.json, identity/principals.json), usage-ingest
    // (identity/budget-blocks.json) and jwks-sync (identity/jwks.json); read by the router through the S3 gateway endpoint.
    const configBucket = new s3.Bucket(this, 'Config', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true, versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED, removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    })
    // catalog/ objects are rewritten daily (snapshots, notices, models): noncurrent versions expire; the current ones,
    // which the pointer, the change logs and ingest reference, are kept.
    configBucket.addLifecycleRule({ id: 'catalog-noncurrent-versions', prefix: 'catalog/', noncurrentVersionExpiration: Duration.days(CATALOG_NONCURRENT_DAYS) })

    // ---------------------------------------------------------------- router state store (-c stateStore=dynamodb)
    // Per-session routing state (the model a conversation lineage is on, cache-warmth records; no prompt content), shared
    // by every task and kept across restarts. One item per key, expired by TTL (`exp`). Rebuildable and short-lived, so
    // the table is destroyed with the stack and has no point-in-time recovery and no stream. Encryption at rest is the
    // DynamoDB default (AWS owned key). Gateway endpoints carry no additional charge.
    const taskRoleName = n('router-task')
    let stateStore: { table: ddb.Table; endpoint: ec2.GatewayVpcEndpoint; grant: (sid: string) => iam.PolicyStatement } | undefined
    if (ddbPl) {
      const table = new ddb.Table(this, 'RouterState', {
        tableName: n('router-state'), partitionKey: { name: STATE_TABLE.partitionKey, type: ddb.AttributeType.STRING },
        billingMode: ddb.BillingMode.PAY_PER_REQUEST, timeToLiveAttribute: STATE_TABLE.ttlAttribute,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false }, removalPolicy: RemovalPolicy.DESTROY, deletionProtection: false,
      })
      const endpoint = vpc.addGatewayEndpoint('DynamoDb', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB, subnets: [subnets] })
      // Endpoint policy: only the router task role, only the three item actions, only this table. A gateway endpoint
      // policy must have Principal "*" and names the principal with aws:PrincipalArn (VPC endpoint policy guide). The
      // role ARN is spelled out: the role's boundary names this endpoint, so a reference to the role would be a cycle.
      endpoint.addToPolicy(new iam.PolicyStatement({
        principals: [new iam.StarPrincipal()], actions: [...STATE_TABLE_ACTIONS], resources: [table.tableArn],
        conditions: { ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${Aws.ACCOUNT_ID}:role/${taskRoleName}` } },
      }))
      // The role's grant and its boundary counterpart: the same actions on the same table, and only through this endpoint
      // (DynamoDB sets aws:SourceVpce on requests that arrive through a gateway endpoint).
      const grant = (sid: string) => new iam.PolicyStatement({ sid, actions: [...STATE_TABLE_ACTIONS], resources: [table.tableArn],
        conditions: { StringEquals: { 'aws:SourceVpce': endpoint.vpcEndpointId } } })
      stateStore = { table, endpoint, grant }
    }

    // ---------------------------------------------------------------- ECS Fargate router
    // Container Insights off: the router's EMF metrics cover requests, cost, errors and latency.
    const cluster = new ecs.Cluster(this, 'Cluster', { clusterName: n('cluster'), vpc, containerInsightsV2: ecs.ContainerInsights.DISABLED })
    const routerLogs = new logs.LogGroup(this, 'RouterLogs', { logGroupName: `/${cfg.prefix}/router`, retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY })
    // Provider secrets (design 11-28 §5): exactly the registry's ARNs, read only, through this VPC's endpoint only.
    const secretsGrant = secretsVpce ? (sid: string) => new iam.PolicyStatement({ sid, actions: ['secretsmanager:GetSecretValue'],
      resources: providerSecretResources, conditions: { StringEquals: { 'aws:SourceVpce': secretsVpce.vpcEndpointId } } }) : undefined
    // Permissions boundary: what the router uses (Bedrock invoke on profiles, foundation models and the Responses
    // default project; read of the runtime config and identity objects; with -c stateStore=dynamodb the three item
    // actions on the state table through its endpoint) and nothing else. It caps the dynamic policies
    // the catalog-grant Lambda attaches (D4); the CloudFormation grants below are inside it (stack.test.ts checks).
    const boundary = new iam.ManagedPolicy(this, 'RouterBoundary', {
      managedPolicyName: n('router-boundary'),
      description: 'llm-auto-router task role permissions boundary: Bedrock invoke and config reads only',
      statements: [
        ...boundaryBedrockStatements(cfg.region, Aws.ACCOUNT_ID).map((b) => new iam.PolicyStatement({ sid: b.sid, actions: [...b.actions], resources: b.resources })),
        new iam.PolicyStatement({ sid: 'ConfigRead', actions: ['s3:GetObject'],
          resources: [configBucket.arnForObjects(CONFIG_KEYS.document), configBucket.arnForObjects(`${CONFIG_KEYS.identityPrefix}*`)] }),
        new iam.PolicyStatement({ sid: 'ConfigList', actions: ['s3:ListBucket'], resources: [configBucket.bucketArn] }),
        new iam.PolicyStatement({ sid: 'CatalogRead', actions: ['s3:GetObject'], resources: ROUTER_CATALOG_READS.map((k) => configBucket.arnForObjects(k)) }),
        ...(stateStore ? [stateStore.grant('StateStore')] : []),
        ...(secretsGrant ? [secretsGrant('ProviderSecrets')] : []),
      ],
    })
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: taskRoleName, permissionsBoundary: boundary, assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com', { conditions: {
        StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
        ArnLike: { 'aws:SourceArn': `arn:aws:ecs:${Aws.REGION}:${Aws.ACCOUNT_ID}:*` },
      } }),
    })
    grantInvoke(taskRole, models.routerModels, models.routerResponsesModels, 'Router')
    // Runtime config and identity objects: read only. ListBucket makes a missing key 404 (absent) instead of 403.
    taskRole.addToPolicy(new iam.PolicyStatement({ sid: 'ConfigRead', actions: ['s3:GetObject'],
      resources: [configBucket.arnForObjects(CONFIG_KEYS.document), configBucket.arnForObjects(`${CONFIG_KEYS.identityPrefix}*`)] }))
    taskRole.addToPolicy(new iam.PolicyStatement({ sid: 'ConfigList', actions: ['s3:ListBucket'], resources: [configBucket.bucketArn] }))
    // Dynamic catalog (C3 reads): its own policy resource, so the role's default/overflow policies stay as they were.
    const taskCatalogRead = new iam.Policy(this, 'TaskRoleCatalogRead', { roles: [taskRole], statements: [
      new iam.PolicyStatement({ sid: 'CatalogRead', actions: ['s3:GetObject'], resources: ROUTER_CATALOG_READS.map((k) => configBucket.arnForObjects(k)) })] })
    // State store: its own policy resource too (the role's default/overflow policies are the same in both modes).
    const taskStateStore = stateStore ? new iam.Policy(this, 'TaskRoleStateStore', { roles: [taskRole], statements: [stateStore.grant('StateStore')] }) : undefined
    const taskProviderSecrets = secretsGrant ? new iam.Policy(this, 'TaskRoleProviderSecrets', { roles: [taskRole], statements: [secretsGrant('ProviderSecrets')] }) : undefined
    // ... and only through this VPC's S3 gateway endpoint.
    configBucket.addToResourcePolicy(new iam.PolicyStatement({ sid: 'RouterViaEndpointOnly', effect: iam.Effect.DENY,
      principals: [new iam.ArnPrincipal(taskRole.roleArn)], actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [configBucket.bucketArn, configBucket.arnForObjects('*')],
      conditions: { StringNotEquals: { 'aws:SourceVpce': s3Endpoint.vpcEndpointId } } }))
    // Provider secrets: the endpoint admits only the task role, only GetSecretValue, only the registry's ARNs. The role
    // ARN is spelled out (as for the DynamoDB endpoint): the role's boundary names this endpoint, so a reference would
    // be a cycle.
    if (secretsVpce) secretsVpce.addToPolicy(new iam.PolicyStatement({
      principals: [new iam.StarPrincipal()], actions: ['secretsmanager:GetSecretValue'], resources: providerSecretResources,
      conditions: { ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${Aws.ACCOUNT_ID}:role/${taskRoleName}` } },
    }))
    // bedrock-runtime endpoint: only the router task role, only model invocation.
    bedrockVpce.addToPolicy(new iam.PolicyStatement({
      principals: [new iam.ArnPrincipal(taskRole.roleArn)], actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], resources: ['*'],
    }))
    const task = new ecs.FargateTaskDefinition(this, 'Task', {
      family: n('router'), cpu: 1024, memoryLimitMiB: 2048, taskRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    })
    const image = props.image ?? ecs.ContainerImage.fromDockerImageAsset(new ecrAssets.DockerImageAsset(this, 'RouterImage', {
      directory: REPO_ROOT, file: 'packages/router/Dockerfile', platform: ecrAssets.Platform.LINUX_ARM64, ignoreMode: IgnoreMode.DOCKER,
      exclude: [...readFileSync(new URL('packages/router/Dockerfile.dockerignore', `file://${REPO_ROOT}`), 'utf8').split('\n').filter((l) => l.trim()),
        '!packages/router/Dockerfile', '!packages/router/Dockerfile.dockerignore'],
    }))
    const routerEnv: Record<string, string> = {
      // awsvpc with no published host port: the wildcard bind is reachable only through the task SG (NLB SG only).
      ROUTER_BIND: '0.0.0.0', ROUTER_PORT: String(ROUTER_PORT), ROUTER_REGION: cfg.region,
      ROUTER_MAX_BODY_BYTES: String(MAX_BODY_BYTES),
      ROUTER_HOP_AUTH: 'apigw-iam', ROUTER_GATEWAY_ROLE_ARN: gatewayRole.roleArn, ROUTER_GATEWAY_ARN: gateway.attrGatewayArn,
      ROUTER_API_VPCE_ID: apiVpce.vpcEndpointId,
      // The deploy's policy (validated against the region catalog at synth); the router re-validates it at boot.
      ROUTER_POLICY_JSON: JSON.stringify(models.policy),
      ...(models.catalog ? { ROUTER_CATALOG_JSON: JSON.stringify(models.catalog) } : {}),
      // The provider registry (validated at synth; the router re-validates it at boot). Absent = Bedrock only.
      ...(models.registry ? { ROUTER_PROVIDERS_JSON: JSON.stringify(models.registry) } : {}),
      // The egress boundary console providers must lie in, and the console-written secrets' prefix (ADR 0002). Absent
      // without an egress mode: the router then allows no providers other than Bedrock in a configuration document.
      ...(cfg.providerEgressMode ? { ROUTER_PROVIDER_BOUNDARY: JSON.stringify(models.boundary), ROUTER_SECRET_PREFIX: cfg.prefix } : {}),
      ROUTER_HINTS: JSON.stringify({ chatIncludeUsage: 'inject-strip' }),
      // E2E task revisions only (-c e2eFault=… / -c e2eIdleTimeoutMs=…); the router logs a startup warning.
      ...(cfg.e2e?.fault ? { ROUTER_FAULT_INJECT: cfg.e2e.fault, ROUTER_FAULT_INJECT_ALLOW: '1' } : {}),
      ...(cfg.e2e?.idleTimeoutMs ? { ROUTER_STREAM_IDLE_TIMEOUT_MS: String(cfg.e2e.idleTimeoutMs) } : {}),
      // Tier assessor (-c assessorMode=observe|auto …): absent = off. It calls its model with this task role.
      ...assessorEnv(cfg.assessor),
      ...(cfg.assessorHoldTiers ? { ROUTER_ASSESSOR_HOLD_TIERS: cfg.assessorHoldTiers } : {}),
      // Runtime configuration (config/active.json) and identity objects, polled every 30 s (admin console C2/C3).
      ROUTER_CONFIG_BUCKET: configBucket.bucketName,
      // Every model the task role may invoke: bounds what any runtime configuration can name.
      ROUTER_MODEL_UNIVERSE: models.routerModels.join(','),
      ...identityEnv(cfg.identity.mode, `https://cognito-idp.${Aws.REGION}.amazonaws.com/${pool.userPoolId}`, invokeScope),
      // Graceful stop: how long in-flight requests may finish after SIGTERM (the container's stopTimeout less a margin).
      ROUTER_SHUTDOWN_GRACE_MS: String(SHUTDOWN_GRACE_MS),
      // Set = the router keeps its routing state in this table (dynamodb.<ROUTER_REGION>.amazonaws.com); absent = in memory.
      ...(stateStore ? { ROUTER_STATE_TABLE: stateStore.table.tableName } : {}),
    }
    // The baked document comes from this exact env (the router reads the same keys at boot): staged below.
    // The providersFile registry is part of the baked document (ADR 0002), as the router builds it from ROUTER_PROVIDERS_JSON.
    this.baked = bakedArtifact(models.policy, routerEnv, undefined, models.registry)
    const container = task.addContainer('router', {
      containerName: 'router', image, essential: true, readonlyRootFilesystem: true, user: 'node',
      portMappings: [{ name: 'http', containerPort: ROUTER_PORT, appProtocol: ecs.AppProtocol.http }],
      environment: routerEnv, stopTimeout: Duration.seconds(STOP_TIMEOUT_S),
      logging: ecs.LogDrivers.awsLogs({ logGroup: routerLogs, streamPrefix: 'router' }),
    })
    const service = new ecs.FargateService(this, 'Router', {
      serviceName: n('router'), cluster, taskDefinition: task, assignPublicIp: false,
      // With routerAutoscale the scaling policy owns the count: no DesiredCount in the template, so a deploy keeps it.
      ...(cfg.autoscale ? {} : { desiredCount: cfg.desiredCount }),
      vpcSubnets: subnets, securityGroups: [routerSg], circuitBreaker: { rollback: true }, minHealthyPercent: 100, maxHealthyPercent: 200,
      enableExecuteCommand: false, propagateTags: ecs.PropagatedTagSource.SERVICE, healthCheckGracePeriod: Duration.seconds(30),
    })
    if (cfg.autoscale) {
      // Target tracking on average CPU (1-minute ECS metrics). The router is one Node process per task, so CPU is
      // its capacity signal: about 0.46 % per short streamed request/s on 1 vCPU, saturating near 210 RPS
      // (docs/experiments/router-loadtest.zh-CN.md). Scale-in is slower than scale-out, and each stopped task drains
      // for the deregistration delay plus SHUTDOWN_GRACE_MS, so running streams finish.
      const scaling = service.autoScaleTaskCount({ minCapacity: cfg.autoscale.min, maxCapacity: cfg.autoscale.max })
      scaling.scaleOnCpuUtilization('RouterCpuScaling', {
        policyName: n('router-cpu'), targetUtilizationPercent: cfg.autoscale.cpuTarget,
        scaleOutCooldown: Duration.seconds(SCALE_OUT_COOLDOWN_S), scaleInCooldown: Duration.seconds(SCALE_IN_COOLDOWN_S),
      })
    }
    // No task starts before the route to DynamoDB, the SG rule that lets it out and the role's grant exist (the service waits for the role and its default policy only).
    if (stateStore && taskStateStore) service.node.addDependency(stateStore.endpoint, taskStateStore, routerSg)
    if (secretsVpce && taskProviderSecrets) service.node.addDependency(secretsVpce, taskProviderSecrets)
    // ---------------------------------------------------------------- jwks-sync (pool JWKS -> identity/jwks.json, every 5 min)
    // Outside the VPC (it reads the pool's public JWKS); writes one object. The router never fetches keys at request time.
    const jwksLogs = new logs.LogGroup(this, 'JwksSyncLogs', { logGroupName: `/aws/lambda/${n('jwks-sync')}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    const jwksRole = new iam.Role(this, 'JwksSyncRole', { roleName: n('jwks-sync-role'), assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com', {
      conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } } }) })
    jwksRole.addToPolicy(new iam.PolicyStatement({ sid: 'OwnLogs', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${jwksLogs.logGroupArn}:*`] }))
    jwksRole.addToPolicy(new iam.PolicyStatement({ sid: 'JwksObject', actions: ['s3:GetObject', 's3:PutObject'], resources: [configBucket.arnForObjects(CONFIG_KEYS.jwks)] }))
    jwksRole.addToPolicy(new iam.PolicyStatement({ sid: 'JwksList', actions: ['s3:ListBucket'], resources: [configBucket.bucketArn] }))
    const jwksSync = new lambda.Function(this, 'JwksSync', {
      functionName: n('jwks-sync'), runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.ARM_64, handler: 'index.handler',
      code: lambda.Code.fromInline(JWKS_SYNC_CODE), role: jwksRole, logGroup: jwksLogs, timeout: Duration.seconds(30), memorySize: 128,
      environment: { JWKS_URL: `https://cognito-idp.${Aws.REGION}.amazonaws.com/${pool.userPoolId}/.well-known/jwks.json`, BUCKET: configBucket.bucketName, KEY: CONFIG_KEYS.jwks },
    })
    new events.Rule(this, 'JwksSyncSchedule', { ruleName: n('jwks-sync'), schedule: events.Schedule.rate(Duration.minutes(JWKS_SYNC_MINUTES)),
      targets: [new eventsTargets.LambdaFunction(jwksSync, { retryAttempts: 2 })] })

    // ---------------------------------------------------------------- catalog-grant (dynamic model grants, D4)
    // Outside the VPC (IAM is a global endpoint). `{ action: 'sync' }` from console-api and from catalog-refresh after a
    // publish: reads catalog/models.json and the current catalog, writes <prefix>-dyn-models-1..4 and attaches them to the
    // task role (capped by the boundary above), then catalog/universe.json and the models' grant fields. CloudFormation
    // events are refused: stack-delete cleanup is its own function below.
    const dynPolicyArns = Array.from({ length: DYN_POLICY_SLOTS }, (_, i) => dynPolicyArn(Aws.ACCOUNT_ID, cfg.prefix, i + 1))
    const grantLogs = new logs.LogGroup(this, 'CatalogGrantLogs', { logGroupName: `/aws/lambda/${n('catalog-grant')}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    const grantRole = new iam.Role(this, 'CatalogGrantRole', { roleName: n('catalog-grant-role'), assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com', {
      conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } } }) })
    grantRole.addToPolicy(new iam.PolicyStatement({ sid: 'OwnLogs', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${grantLogs.logGroupArn}:*`] }))
    grantRole.addToPolicy(new iam.PolicyStatement({ sid: 'DynamicPolicies', resources: dynPolicyArns, actions: ['iam:CreatePolicy', 'iam:CreatePolicyVersion',
      'iam:DeletePolicyVersion', 'iam:DeletePolicy', 'iam:ListPolicyVersions', 'iam:GetPolicyVersion'] }))
    grantRole.addToPolicy(new iam.PolicyStatement({ sid: 'AttachDynamicPolicies', actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
      resources: [taskRole.roleArn], conditions: { ArnEquals: { 'iam:PolicyARN': dynPolicyArns } } }))
    grantRole.addToPolicy(new iam.PolicyStatement({ sid: 'CatalogWrite', actions: ['s3:GetObject', 's3:PutObject'],
      resources: [catalogKeys.models, catalogKeys.universe].map((k) => configBucket.arnForObjects(k)) }))
    grantRole.addToPolicy(new iam.PolicyStatement({ sid: 'CatalogRead', actions: ['s3:GetObject'],
      resources: [catalogKeys.current, `${catalogKeys.versionsPrefix}*`].map((k) => configBucket.arnForObjects(k)) }))
    grantRole.addToPolicy(new iam.PolicyStatement({ sid: 'ConfigList', actions: ['s3:ListBucket'], resources: [configBucket.bucketArn] }))
    // The configuration documents (models they use stay granted) and the stack-delete draining marker.
    grantRole.addToPolicy(new iam.PolicyStatement({ sid: 'ConfigAndDrainingRead', actions: ['s3:GetObject'],
      resources: [CONFIG_KEYS.document, BAKED_KEY, GRANT_DRAINING_KEY].map((k) => configBucket.arnForObjects(k)) }))
    const grantFn = new lambda.DockerImageFunction(this, 'CatalogGrant', {
      functionName: n('catalog-grant'), code: (props.lambdaCode ?? catalogLambdaCode)(this, CATALOG_LAMBDA_CMD.grant), architecture: lambda.Architecture.ARM_64,
      role: grantRole, logGroup: grantLogs, memorySize: 256, timeout: Duration.seconds(GRANT_TIMEOUT_S),
      // One sync at a time (async invokes queue and are retried); -c catalogGrantConcurrency=none drops the reservation.
      ...(cfg.catalogGrantConcurrency ? { reservedConcurrentExecutions: cfg.catalogGrantConcurrency } : {}),
      environment: { PREFIX: cfg.prefix, ROLE_NAME: taskRole.roleName, REGION: cfg.region, ACCOUNT_ID: Aws.ACCOUNT_ID,
        BASE_UNIVERSE: models.routerModels.join(','), PROPAGATION_DELAY_MS: String(GRANT_PROPAGATION_DELAY_MS), CONFIG_BUCKET: configBucket.bucketName,
        UNCONFIRM_DELAY_MS: String(GRANT_UNCONFIRM_DELAY_MS) },
    })
    // Async invokes (console-api, catalog-refresh): one retry for transient AWS errors; deterministic failures are
    // recorded in the models' grant fields and the invocation succeeds.
    grantFn.configureAsyncInvoke({ retryAttempts: 1, maxEventAge: Duration.hours(1) })
    // Destroy: a separate function (same image) whose role can only list, detach and delete the dynamic policies, and
    // which only the Provider framework invokes (console-api's invoke grant names catalog-grant alone). The custom
    // resource depends on the task role, so CloudFormation deletes it (detach + delete every dynamic policy) before the
    // role. Create/Update are no-ops with a constant physical id (no replacement Delete on update).
    const cleanupLogs = new logs.LogGroup(this, 'CatalogGrantCleanupLogs', { logGroupName: `/aws/lambda/${n('catalog-grant-cleanup')}`,
      retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    const cleanupRole = new iam.Role(this, 'CatalogGrantCleanupRole', { roleName: n('catalog-grant-cleanup-role'), assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com', {
      conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } } }) })
    cleanupRole.addToPolicy(new iam.PolicyStatement({ sid: 'OwnLogs', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${cleanupLogs.logGroupArn}:*`] }))
    cleanupRole.addToPolicy(new iam.PolicyStatement({ sid: 'DeleteDynamicPolicies', resources: dynPolicyArns,
      actions: ['iam:ListPolicyVersions', 'iam:DeletePolicyVersion', 'iam:DeletePolicy'] }))
    // Get + ListBucket: the marker is rewritten with If-Match (draining false on Create/Update, true on Delete), and a
    // missing marker must read as 404, not 403.
    cleanupRole.addToPolicy(new iam.PolicyStatement({ sid: 'DrainingMarker', actions: ['s3:GetObject', 's3:PutObject'], resources: [configBucket.arnForObjects(GRANT_DRAINING_KEY)] }))
    cleanupRole.addToPolicy(new iam.PolicyStatement({ sid: 'ConfigList', actions: ['s3:ListBucket'], resources: [configBucket.bucketArn] }))
    cleanupRole.addToPolicy(new iam.PolicyStatement({ sid: 'DetachDynamicPolicies', actions: ['iam:DetachRolePolicy'],
      resources: [taskRole.roleArn], conditions: { ArnEquals: { 'iam:PolicyARN': dynPolicyArns } } }))
    const cleanupFn = new lambda.DockerImageFunction(this, 'CatalogGrantCleanupFn', {
      functionName: n('catalog-grant-cleanup'), code: (props.lambdaCode ?? catalogLambdaCode)(this, CATALOG_LAMBDA_CMD.grantCleanup),
      architecture: lambda.Architecture.ARM_64, role: cleanupRole, logGroup: cleanupLogs, memorySize: 256, timeout: Duration.seconds(120),
      environment: { PREFIX: cfg.prefix, ROLE_NAME: taskRole.roleName, REGION: cfg.region, ACCOUNT_ID: Aws.ACCOUNT_ID, CONFIG_BUCKET: configBucket.bucketName },
    })
    const grantProvider = new cr.Provider(this, 'CatalogGrantProvider', { onEventHandler: cleanupFn, logGroup: cleanupLogs })
    const grantCleanup = new CustomResource(this, 'CatalogGrantCleanup', { serviceToken: grantProvider.serviceToken, resourceType: 'Custom::CatalogGrantCleanup',
      properties: { slots: DYN_POLICY_SLOTS } })
    grantCleanup.node.addDependency(taskRole)
    grantCleanup.node.addDependency(configBucket) // deleted before the bucket: it writes the draining marker there

    // Updating a gateway target re-runs model discovery (GET /v1/models) against the router: CloudFormation must finish
    // the ECS rolling update to the new image first (2026-11-08: the target updated before the task definition, so
    // discovery hit the old image and the target went UPDATE_UNSUCCESSFUL).
    routerTarget.node.addDependency(service)

    const routerTargets = nlbListener.addTargets('RouterTasks', {
      port: ROUTER_PORT, protocol: elbv2.Protocol.TCP, deregistrationDelay: Duration.seconds(DEREGISTRATION_DELAY_S),
      targets: [service.loadBalancerTarget({ containerName: container.containerName, containerPort: ROUTER_PORT })],
      healthCheck: { protocol: elbv2.Protocol.HTTP, path: '/healthz', interval: Duration.seconds(10), healthyThresholdCount: 2, unhealthyThresholdCount: 2 },
    })
    // Explicit (also the default for TCP): established connections outlive the deregistration delay, so streams run on
    // into the router's own grace period after SIGTERM (see DEREGISTRATION_DELAY_S).
    routerTargets.setAttribute('deregistration_delay.connection_termination.enabled', 'false')

    // ---------------------------------------------------------------- outputs (no secrets, no account ids)
    new CfnOutput(this, 'GatewayUrl', { value: gateway.attrGatewayUrl })
    new CfnOutput(this, 'TokenEndpoint', { value: `${domain.baseUrl()}/oauth2/token` })
    new CfnOutput(this, 'UserPoolId', { value: pool.userPoolId })
    new CfnOutput(this, 'AgentClientId', { value: client.userPoolClientId })
    new CfnOutput(this, 'RestApiId', { value: api.ref })
    new CfnOutput(this, 'ApiVpceId', { value: apiVpce.vpcEndpointId })
    // For the E2E runner's in-VPC probe (E0): where to place it and what to try to reach.
    new CfnOutput(this, 'VpcId', { value: vpc.vpcId })
    new CfnOutput(this, 'VpcCidr', { value: vpc.vpcCidrBlock })
    new CfnOutput(this, 'PrivateSubnetIds', { value: Fn.join(',', vpc.isolatedSubnets.map((x) => x.subnetId)) })
    new CfnOutput(this, 'ApiVpceSgId', { value: apiVpceSg.securityGroupId })
    new CfnOutput(this, 'ApiVpceDns', { value: vpceDns })
    new CfnOutput(this, 'ApiHost', { value: `${api.ref}.execute-api.${cfg.region}.amazonaws.com` })
    new CfnOutput(this, 'NlbDns', { value: nlb.loadBalancerDnsName })
    new CfnOutput(this, 'RouterLogGroup', { value: routerLogs.logGroupName })
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName })
    new CfnOutput(this, 'ServiceName', { value: service.serviceName })
    new CfnOutput(this, 'CliClientId', { value: cli.userPoolClientId })
    new CfnOutput(this, 'ConfigBucketName', { value: configBucket.bucketName })
    if (stateStore) new CfnOutput(this, 'StateTableName', { value: stateStore.table.tableName })

    // ---------------------------------------------------------------- values for ConsoleStack (SSM, not stack exports)
    const gatewayBase = Fn.join('', ['https://', Fn.select(2, Fn.split('/', gateway.attrGatewayUrl))])
    const params: Record<RouterParam, string> = {
      userPoolId: pool.userPoolId, userPoolArn: pool.userPoolArn, cognitoDomain: domain.baseUrl(), gatewayId: gateway.attrGatewayIdentifier,
      gatewayUrl: gatewayBase, configBucket: configBucket.bucketName, logGroupName: routerLogs.logGroupName, clusterName: cluster.clusterName,
      serviceName: service.serviceName, serviceArn: service.serviceArn, cliClientId: cli.userPoolClientId, agentClientId: client.userPoolClientId,
      callbackPorts: cfg.identity.cliRedirectPorts.join(','), codexOauthPort: String(cfg.identity.codexOauthPort), modelUniverse: models.routerModels.join(','), identityHeader: 'x-api-key',
      catalogRefreshFunction: n('catalog-refresh'), catalogGrantFunction: grantFn.functionName,
      providerBoundary: JSON.stringify(models.boundary), providerSecretPrefix: cfg.providerEgressMode ? cfg.prefix : 'none',
      providerDnsSyncFunction: natDns ? n('provider-dns-sync') : 'none',
    }
    for (const [k, v] of Object.entries(params) as Array<[RouterParam, string]>) {
      new ssm.StringParameter(this, `Param-${k}`, { parameterName: routerParamName(cfg.prefix, k), stringValue: v, description: `llm-auto-router ${k} (read by the console stack)` })
    }

    // ---------------------------------------------------------------- cdk-nag (v3: Validations acknowledgements)
    const ack = (c: Construct, id: string, reason: string) => Validations.of(c).acknowledge({ id, reason })
    ack(pool, 'AwsSolutions-COG2', 'MFA off by deployer decision for this sample; enable TOTP MFA for production (see infra/README).')
    ack(pool, 'AwsSolutions-COG3', 'Invited team, admin-created users only (no self sign-up); threat protection needs the Plus plan (a deploy option).')
    ack(pool, 'AwsSolutions-COG8', 'Essentials plan: invited users only, no self sign-up; Plus (threat protection) is a deploy option for larger audiences.')
    // ---------------------------------------------------------------- packs archive (console: pack rules behind decisions)
    // ---------------------------------------------------------------- baked config document + packs archive
    // config/baked.json (mutable, read by ETag) and config/baked/<version>.json (immutable): the document the router
    // runs for every section the active document does not set (0d-effective-config §1–3). Built above from the task
    // definition's environment, the validated policy and the committed manifest's packs.
    // The construct id stays PacksArchive (an existing custom resource: no replacement). Prune off: packs of older images
    // and older baked versions stay readable for old records.
    const packs = new s3deploy.BucketDeployment(this, 'PacksArchive', {
      destinationBucket: configBucket, prune: false, memoryLimit: 256,
      sources: [
        ...(props.packsArchiveDir ? [s3deploy.Source.asset(props.packsArchiveDir)] : []),
        s3deploy.Source.data(BAKED_KEY, this.baked.json), s3deploy.Source.data(bakedVersionKey(this.baked.version), this.baked.json),
        // The deploy's registry, which the console reads: written on every deploy (the explicit empty registry without
        // -c providersFile), so it never outlives the deploy that set it. Its immutable version, for usage-ingest's
        // `<catalog>+<registry>` lines, only for a real registry.
        s3deploy.Source.data(providerKeys.active, JSON.stringify(models.registry ?? EMPTY_REGISTRY)),
        ...(models.registry ? [s3deploy.Source.data(providerKeys.version(models.registry.version), JSON.stringify(models.registry)),
          // The router names the baked registry by the baked document's version (catalog `<catalog>+<baked version>`).
          s3deploy.Source.data(providerKeys.version(this.baked.version), JSON.stringify({ ...models.registry, version: this.baked.version }))] : []),
      ],
    })
    // BucketDeployment grants its framework Lambda read/write on the whole bucket. Outside packs/ and the baked document
    // that would let it write or delete config/active.json and the identity objects without the console's audit, so the
    // bucket denies it there.
    configBucket.addToResourcePolicy(new iam.PolicyStatement({ sid: 'PacksDeploymentOnlyUnderPacks', effect: iam.Effect.DENY,
      principals: [new iam.ArnPrincipal(packs.handlerRole.roleArn)],
      actions: ['s3:PutObject', 's3:PutObjectAcl', 's3:DeleteObject', 's3:DeleteObjectVersion'],
      notResources: [configBucket.arnForObjects('packs/*'), configBucket.arnForObjects(BAKED_KEY), configBucket.arnForObjects('config/baked/*'),
        configBucket.arnForObjects(providerKeys.active),
        ...(models.registry ? [configBucket.arnForObjects(`${providerKeys.versionsPrefix}*`)] : [])] }))
    // ---------------------------------------------------------------- catalog-refresh (prices, availability, versions)
    // Outside the VPC (Price List us-east-1 endpoint, Bedrock control plane). Daily schedule, console "refresh now"
    // (async) and a deploy-time Trigger: after the bucket and the baked document, before the ECS service, so the router
    // starts with a published catalog; a blocking notice (a policy model not offered) fails the deploy (R3).
    const refreshLogs = new logs.LogGroup(this, 'CatalogRefreshLogs', { logGroupName: `/aws/lambda/${n('catalog-refresh')}`,
      retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    const refreshRole = new iam.Role(this, 'CatalogRefreshRole', { roleName: n('catalog-refresh-role'), assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com', {
      conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } } }) })
    refreshRole.addToPolicy(new iam.PolicyStatement({ sid: 'OwnLogs', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${refreshLogs.logGroupArn}:*`] }))
    refreshRole.addToPolicy(new iam.PolicyStatement({ sid: 'Capture', resources: ['*'],
      actions: ['pricing:GetProducts', 'bedrock:ListInferenceProfiles', 'bedrock:ListFoundationModels'] }))
    refreshRole.addToPolicy(new iam.PolicyStatement({ sid: 'CatalogWrite', actions: ['s3:GetObject', 's3:PutObject'],
      resources: [catalogKeys.models, catalogKeys.current, ...REFRESH_ONLY_KEYS].map((k) => configBucket.arnForObjects(k)) }))
    refreshRole.addToPolicy(new iam.PolicyStatement({ sid: 'ConfigRead', actions: ['s3:GetObject'],
      resources: [CONFIG_KEYS.document, BAKED_KEY].map((k) => configBucket.arnForObjects(k)) }))
    refreshRole.addToPolicy(new iam.PolicyStatement({ sid: 'ConfigList', actions: ['s3:ListBucket'], resources: [configBucket.bucketArn] }))
    refreshRole.addToPolicy(new iam.PolicyStatement({ sid: 'InvokeGrant', actions: ['lambda:InvokeFunction'], resources: [grantFn.functionArn] }))
    // A change of the baked document or the base universe re-runs the deploy-time refresh (the Trigger runs when the
    // function's version changes), so a policy change is checked against the Region's offer at deploy.
    const deployInputs = createHash('sha256').update(JSON.stringify([this.baked.version, models.routerModels])).digest('hex').slice(0, 16)
    const refreshFn = new lambda.DockerImageFunction(this, 'CatalogRefresh', {
      functionName: n('catalog-refresh'), code: (props.lambdaCode ?? catalogLambdaCode)(this, CATALOG_LAMBDA_CMD.refresh), architecture: lambda.Architecture.ARM_64,
      role: refreshRole, logGroup: refreshLogs, memorySize: 512, timeout: Duration.minutes(5),
      environment: { CONFIG_BUCKET: configBucket.bucketName, REGION: cfg.region, GRANT_FUNCTION: grantFn.functionName, DEPLOY_INPUTS: deployInputs,
        BASE_UNIVERSE: models.routerModels.join(',') },
    })
    new events.Rule(this, 'CatalogRefreshSchedule', { ruleName: n('catalog-refresh'), schedule: events.Schedule.cron(REFRESH_SCHEDULE),
      targets: [new eventsTargets.LambdaFunction(refreshFn, { retryAttempts: 2, event: events.RuleTargetInput.fromObject({ mode: 'scheduled' }) })] })
    new triggers.Trigger(this, 'CatalogDeployRefresh', {
      handler: refreshFn, invocationType: triggers.InvocationType.REQUEST_RESPONSE, timeout: Duration.minutes(10),
      executeAfter: [configBucket, packs, refreshRole], executeBefore: [service],
    })
    // The Trigger's provider is a CDK custom-resource provider (raw CfnResources the Tags aspect skips): tag it.
    const trp = this.node.tryFindChild('AWSCDK.TriggerCustomResourceProviderCustomResourceProvider')
    for (const id of ['Role', 'Handler']) {
      (trp?.node.tryFindChild(id) as CfnResource | undefined)?.addPropertyOverride('Tags', Object.entries(cfg.tags).map(([Key, Value]) => ({ Key, Value })))
    }
    // ---------------------------------------------------------------- provider-dns-sync (nat-dns only, ADR 0003)
    // Outside the VPC. Replaces the DNS Firewall provider list with the exact hosts of the configuration the router runs
    // (inside the boundary's ceiling): synchronously from console-api at activation (with the document, before
    // config/active.json is written) and from a deploy-time Trigger (reads config/active.json and config/baked.json).
    if (natDns) {
      const dnsLogs = new logs.LogGroup(this, 'ProviderDnsSyncLogs', { logGroupName: `/aws/lambda/${n('provider-dns-sync')}`,
        retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
      const dnsRole = new iam.Role(this, 'ProviderDnsSyncRole', { roleName: n('provider-dns-sync-role'), assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } } }) })
      dnsRole.addToPolicy(new iam.PolicyStatement({ sid: 'OwnLogs', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${dnsLogs.logGroupArn}:*`] }))
      dnsRole.addToPolicy(new iam.PolicyStatement({ sid: 'ConfigRead', actions: ['s3:GetObject'],
        resources: [CONFIG_KEYS.document, BAKED_KEY].map((k) => configBucket.arnForObjects(k)) }))
      // ListBucket turns a missing config/active.json (no console activation yet) into 404 instead of 403.
      dnsRole.addToPolicy(new iam.PolicyStatement({ sid: 'ConfigList', actions: ['s3:ListBucket'], resources: [configBucket.bucketArn] }))
      dnsRole.addToPolicy(new iam.PolicyStatement({ sid: 'ProviderDomainList', actions: ['route53resolver:UpdateFirewallDomains', 'route53resolver:GetFirewallDomainList'],
        resources: [natDns.providerList.attrArn] }))
      const dnsInputs = createHash('sha256').update(JSON.stringify([this.baked.version, models.boundary])).digest('hex').slice(0, 16)
      const dnsSyncFn = new lambda.DockerImageFunction(this, 'ProviderDnsSync', {
        functionName: n('provider-dns-sync'), code: (props.lambdaCode ?? catalogLambdaCode)(this, CATALOG_LAMBDA_CMD.providerDns), architecture: lambda.Architecture.ARM_64,
        role: dnsRole, logGroup: dnsLogs, memorySize: 256, timeout: Duration.seconds(60),
        environment: { CONFIG_BUCKET: configBucket.bucketName, REGION: cfg.region, DOMAIN_LIST_ID: natDns.providerList.attrId,
          PROVIDER_BOUNDARY: JSON.stringify(models.boundary), DEPLOY_INPUTS: dnsInputs },
      })
      // Runs when the function's version changes: a new image, a new baked document or a new boundary. After the bucket
      // and the baked document, before the router service, so the router starts with its providers resolvable.
      new triggers.Trigger(this, 'ProviderDnsDeploySync', {
        handler: dnsSyncFn, invocationType: triggers.InvocationType.REQUEST_RESPONSE, timeout: Duration.minutes(2),
        executeAfter: [configBucket, packs, dnsRole, natDns], executeBefore: [service],
      })
      ack(dnsRole, `AwsSolutions-IAM5[Resource::<${this.getLogicalId(dnsLogs.node.defaultChild as CfnElement)}.Arn>:*]`, 'Log streams of the function\'s own log group.')
    }

    // Bucket policy (allowlists): the immutable versions, change logs, snapshots, notices and deploy inputs are written
    // and deleted by catalog-refresh only; the granted universe by catalog-grant only; the draining marker by the cleanup
    // function only; models.json and current.json by refresh, grant and console-api only (console-api's role name is
    // fixed by the console stack). The auto-delete-objects provider (stack teardown) may delete everything.
    const autoDelete = this.node.tryFindChild('Custom::S3AutoDeleteObjectsCustomResourceProvider')?.node.tryFindChild('Role') as CfnResource | undefined
    if (!autoDelete) throw new Error('config bucket: no auto-delete-objects provider role')
    const teardown = autoDelete.getAtt('Arn').toString()
    const consoleApiRoleArn = `arn:aws:iam::${Aws.ACCOUNT_ID}:role/${n('console-api-role')}`
    for (const [sid, keys, writers] of [
      ['CatalogRefreshObjectsRefreshOnly', REFRESH_ONLY_KEYS, [refreshRole.roleArn]],
      ['CatalogUniverseGrantOnly', GRANT_ONLY_KEYS, [grantRole.roleArn]],
      ['CatalogDrainingCleanupOnly', CLEANUP_ONLY_KEYS, [cleanupRole.roleArn]],
      ['CatalogSharedObjectsWriters', SHARED_CATALOG_KEYS, [refreshRole.roleArn, grantRole.roleArn, consoleApiRoleArn]],
    ] as const) {
      configBucket.addToResourcePolicy(new iam.PolicyStatement({ sid, effect: iam.Effect.DENY, principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject', ...DELETE_ACTIONS], resources: keys.map((k) => configBucket.arnForObjects(k)),
        conditions: { ArnNotEquals: { 'aws:PrincipalArn': [...writers, teardown] } } }))
    }

    const handler = this.node.children.find((c) => c.node.id.startsWith('Custom::CDKBucketDeployment'))
    if (handler) {
      const why = 'CDK BucketDeployment framework function: copies the staged packs archive and baked config document from the CDK asset bucket into the config bucket.'
      for (const f of ['AwsSolutions-L1', 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
        ...['s3:Abort*', 's3:DeleteObject*', 's3:GetBucket*', 's3:GetObject*', 's3:List*'].map((a) => `AwsSolutions-IAM5[Action::${a}]`),
        'AwsSolutions-IAM5[Resource::*]', `AwsSolutions-IAM5[Resource::<${this.getLogicalId(configBucket.node.defaultChild as CfnElement)}.Arn>/*]`,
        `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-${cfg.account}-${cfg.region}/*]`]) ack(handler, f, why)
    }
    ack(configBucket, 'AwsSolutions-S1', 'Small control-plane objects; every write is an audited console action (audit log) or a logged Lambda run. Enable CloudTrail S3 data events for object-level audit.')
    ack(jwksRole, `AwsSolutions-IAM5[Resource::<${this.getLogicalId(jwksLogs.node.defaultChild as CfnElement)}.Arn>:*]`, 'Log streams of the function\'s own log group.')
    ack(taskRole, `AwsSolutions-IAM5[Resource::<${this.getLogicalId(configBucket.node.defaultChild as CfnElement)}.Arn>/identity/*]`,
      'Read-only: the identity objects (jwks, blocks, budget blocks, principals) under one prefix of the config bucket.')
    const boundaryBucket = `<${this.getLogicalId(configBucket.node.defaultChild as CfnElement)}.Arn>`
    for (const r of [`Resource::arn:aws:bedrock:${cfg.region}:<AWS::AccountId>:inference-profile/*`, 'Resource::arn:aws:bedrock:*::foundation-model/*',
      'Resource::arn:aws:bedrock:::foundation-model/*', `Resource::arn:aws:bedrock:${cfg.region}:<AWS::AccountId>:project/*`, `Resource::${boundaryBucket}/identity/*`]) {
      ack(boundary, `AwsSolutions-IAM5[${r}]`, 'Permissions boundary (a ceiling, grants nothing): the resource shapes of the router\'s Bedrock and config-read grants. '
        + 'The exact-ARN grants are the role\'s own policies and the catalog-grant Lambda\'s dynamic policies.')
    }
    ack(grantRole, `AwsSolutions-IAM5[Resource::<${this.getLogicalId(grantLogs.node.defaultChild as CfnElement)}.Arn>:*]`, 'Log streams of the function\'s own log group.')
    ack(grantProvider, 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      'CDK Provider framework function (CloudFormation custom-resource plumbing for the dynamic-grant cleanup on stack delete).')
    ack(cleanupRole, `AwsSolutions-IAM5[Resource::<${this.getLogicalId(cleanupLogs.node.defaultChild as CfnElement)}.Arn>:*]`, 'Log streams of the function\'s own log group.')
    ack(grantProvider, `AwsSolutions-IAM5[Resource::<${this.getLogicalId(cleanupFn.node.defaultChild as CfnElement)}.Arn>:*]`,
      'The Provider framework invokes the catalog-grant-cleanup function (and its versions) only.')
    const bucketLid = `<${this.getLogicalId(configBucket.node.defaultChild as CfnElement)}.Arn>`
    const versionsReason = 'Read-only: the immutable catalog versions (catalog/versions/<YYYY-MM-DD.N>.json); the version is not known at synth.'
    ack(boundary, `AwsSolutions-IAM5[Resource::${bucketLid}/catalog/versions/*]`, versionsReason)
    ack(taskCatalogRead, `AwsSolutions-IAM5[Resource::${bucketLid}/catalog/versions/*]`, versionsReason)
    ack(grantRole, `AwsSolutions-IAM5[Resource::${bucketLid}/catalog/versions/*]`, versionsReason)
    ack(refreshRole, `AwsSolutions-IAM5[Resource::<${this.getLogicalId(refreshLogs.node.defaultChild as CfnElement)}.Arn>:*]`, 'Log streams of the function\'s own log group.')
    ack(refreshRole, 'AwsSolutions-IAM5[Resource::*]', 'pricing:GetProducts, bedrock:ListInferenceProfiles and bedrock:ListFoundationModels have no resource-level permissions (read-only listings).')
    for (const p of ['versions', 'changes', 'snapshots']) {
      ack(refreshRole, `AwsSolutions-IAM5[Resource::${bucketLid}/catalog/${p}/*]`, 'The refresh writes new immutable catalog objects (If-None-Match) under this prefix; their keys are not known at synth.')
    }
    if (stateStore) {
      ack(stateStore.table, 'AwsSolutions-DDB3', 'Ephemeral routing state (lineage model, cache-warmth records) that expires by TTL and is rebuilt by the next requests; PITR would back up a cache.')
    }
    ack(task, 'AwsSolutions-ECS2', 'Environment holds non-secret configuration only (bind, region, ARNs, the validated policy, hint flags).')
    const geoFindings = (ids: readonly string[]) => ids.filter((id) => models.meta.models.find((m) => m.modelId === id)?.endpointScope === 'geo')
      .map((id) => `Resource::arn:aws:bedrock:*::foundation-model/${baseModelId(id)}`)
    for (const f of new Set(geoFindings(models.routerModels))) ack(taskRole, `AwsSolutions-IAM5[${f}]`, GEO_REASON)
    const projectReason = 'Responses on bedrock-runtime authorizes InvokeModel on the default project (Bedrock User Guide, Responses API > '
      + 'Permissions); the project id is not known at synth, and bedrock:ModelArn limits the grant to this deployment\'s Responses models.'
    ack(taskRole, `AwsSolutions-IAM5[Resource::arn:aws:bedrock:${cfg.region}:<AWS::AccountId>:project/*]`, projectReason)
    if (cfg.providerEgressMode) {
      // ADR 0002: the console writes provider keys under <prefix>/providers/; the router reads them, through its endpoint only.
      const keys = `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:secretsmanager:${cfg.region}:<AWS::AccountId>:secret:${cfg.prefix}/providers/*]`
      const keysReason = 'Console-managed provider API keys (ADR 0002): GetSecretValue on this deployment\'s provider prefix only, with aws:SourceVpce = the secretsmanager endpoint.'
      ack(taskRole, keys, keysReason)
      ack(boundary, keys, keysReason)
      if (taskProviderSecrets) ack(taskProviderSecrets, keys, keysReason)
    }
    ack(gatewayRole, `AwsSolutions-IAM5[Resource::arn:aws:execute-api:<AWS::Region>:<AWS::AccountId>:<RouterApi>/${STAGE}/*/*]`,
      'Invoke on every method and path of the one router API stage, nothing else.')
    ack(task, 'AwsSolutions-IAM5[Resource::*]', 'Execution role: ecr:GetAuthorizationToken has no resource-level permissions (CDK-generated).')
    ack(cluster, 'AwsSolutions-ECS4', 'Container Insights is off on purpose: the router emits EMF metrics for requests, cost, errors and latency.')
    ack(nlb, 'AwsSolutions-ELB2', 'Internal NLB reachable only through the VPC link; the router logs every request, and the private API is the audited front.')
    ack(method, 'AwsSolutions-COG4', 'The hop is service-to-service: AWS_IAM (SigV4 by the gateway role) is the authorizer. Cognito JWTs are validated at the AgentCore Gateway.')
    for (const c of [api, stage]) {
      ack(c, 'AwsSolutions-APIG1', 'Access logging needs the account-level API Gateway CloudWatch role; enable it per deployment. The router logs every request.')
      ack(c, 'AwsSolutions-APIG2', 'HTTP_PROXY pass-through by design: the router validates bodies (byte-exact forwarding).')
      ack(c, 'AwsSolutions-APIG3', 'Private API: reachable only through one VPC endpoint by one IAM role (resource policy); WAF adds nothing here.')
      ack(c, 'AwsSolutions-APIG6', 'Execution logging needs the account-level API Gateway CloudWatch role; enable it per deployment.')
    }
  }
}
