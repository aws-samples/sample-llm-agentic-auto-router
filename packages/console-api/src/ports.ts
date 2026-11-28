// Injected storage and AWS ports (no SDK imports here). The AWS adapters implement them; memory.ts implements them
// with in-memory maps for tests and local development. Handlers see only these interfaces. Item layouts follow
// a3 §3 and 17's usage-ingest (records.ts): handlers read the stored fields, never table keys.
import type { CatalogPointer, EgressBoundary, PriceCatalog, ProviderRegistry } from '@auto-router/pricing'
import type { AuditEntry, Budget, Cap, DeploymentSettings, GatewayInfo, HealthRange, HealthReport, Page, Role, SwapEffect } from '@auto-router/console-contract'
import type { PriceCatalog as Catalog } from '@auto-router/pricing'
import type { ConfigDocument, Delivery, StoredVersion } from './local-types.ts'
import type { RulesTranslator } from './rules-translate.ts'

/** The `ACTIVE` pointer item of the console table. */
export interface ActivePointer { n: number; version: string; delivered: boolean }

export type PrincipalGroup = Role | 'service'

/**
 * Per-principal settings: `MEMBER#<kind:id>` items, flat (17's BudgetSource reads monthlyUsd / hardStop from them;
 * the default budget is `MEMBER#default`).
 */
export interface MemberSettings {
  key: string
  group: PrincipalGroup
  budget?: Budget
  cap?: Cap
  /** Service clients: display name and description (members' names live in Cognito). */
  name?: string
  description?: string
  disabled?: boolean
  createdAt: string
  updatedAt: string
}

export interface Draft { document: ConfigDocument; author: string; updatedAt: string; baseVersion: string }

export interface AuditQuery { from: string; to: string; actor?: string; actions?: string[]; target?: string; limit: number; cursor?: string }

export interface ConsoleStore {
  getActive(): Promise<ActivePointer | undefined>
  getVersion(n: number): Promise<StoredVersion | undefined>
  /** Newest first by n (never by string); `before` = only versions with n < before. Metadata only. */
  listVersionMetas(limit: number, before?: number): Promise<StoredVersion['meta'][]>
  /** Highest version number stored (0 when none). */
  latestVersion(): Promise<number>
  /**
   * One transaction: put version `v` (must not exist) and move ACTIVE to it, conditional on ACTIVE.version ===
   * expectVersion (undefined: no ACTIVE item may exist yet). 'conflict' when either condition fails.
   */
  activate(v: StoredVersion, expectVersion: string | undefined): Promise<'ok' | 'conflict'>
  /** CONFIG / v#0#<sha8>: the baked document, put if absent (idempotent, immutable; 0d §4.2). */
  seedBakedVersion(sha8: string, v: StoredVersion): Promise<void>
  getBakedVersion(sha8: string): Promise<StoredVersion | undefined>
  /** Sets ACTIVE.delivered for version n (no-op when ACTIVE moved on). */
  markDelivered(n: number, delivered: boolean): Promise<void>
  getDraft(): Promise<Draft | undefined>
  putDraft(d: Draft): Promise<void>
  deleteDraft(): Promise<void>
  appendAudit(e: AuditEntry): Promise<void>
  /** Newest first within [from, to) (ISO times). */
  listAudit(q: AuditQuery): Promise<Page<AuditEntry>>
  getMember(key: string): Promise<MemberSettings | undefined>
  putMember(m: MemberSettings): Promise<void>
  deleteMember(key: string): Promise<void>
  listMembers(): Promise<MemberSettings[]>
  getDefaultBudget(): Promise<Budget | undefined>
  putDefaultBudget(b: Budget | undefined): Promise<void>
  /** Delivery state of identity/principals.json + blocks.json (design §2.3a). */
  getIdentityDelivery(): Promise<Delivery | undefined>
  putIdentityDelivery(d: Delivery): Promise<void>
  getSettings(): Promise<Pick<DeploymentSettings, 'defaultBaseline'> | undefined>
  putSettings(s: Pick<DeploymentSettings, 'defaultBaseline'>): Promise<void>
}

/** A stored request record (17 records.ts `recordFields`), table keys removed. */
export type StoredRecord = Record<string, unknown> & { ts: string; reqId: string; principal: string; session?: string }

export interface RecordScan {
  /** ISO, inclusive / exclusive. */
  from: string
  to: string
  limit: number
  cursor?: string
  /** Applied while scanning (DynamoDB: a FilterExpression or a post-filter); pages may be short. */
  filter?: (r: StoredRecord) => boolean
}

/** One rollup item (17: U#/A# items). `baseTier` is the static baseline's tier ('-' when not routable). */
export interface RollupItem {
  day: string; principal: string; dialect: string; servedModel: string; baseTier: string; counters: Record<string, number>
  /**
   * The served model's tier under the policy its lines ran with (17 stores it on the cell). Absent on cells written
   * before 17 stored one: readers fall back to the catalog tier.
   */
  servedTier?: string
}

/**
 * One template-family day (usage-ingest family.ts: F#<month> / <dd>#<family>). Counter and sample names are
 * console-contract family-proxy.ts's; `samples` maps a fact bucket to `<ts>#<reqId>#<principal>`.
 */
export interface FamilyRollupItem { day: string; family: string; counters: Record<string, number>; samples: Record<string, string>; dialect?: string }

/**
 * One admin assessor rule day (usage-ingest rules.ts: R#<month> / <dd>#<ruleId>#<ruleHash>). Counter and sample names
 * are console-contract custom-rules.ts's; `samples` maps the sample attribute (`s_m`, `s_d`) to `<ts>#<reqId>#<principal>`.
 */
export interface CustomRuleRollupItem { day: string; id: string; hash: string; counters: Record<string, number>; samples: Record<string, string> }

/** One router `kind: "config"` report (17: C#config items). */
export interface ConfigReport {
  ts: string
  task: string
  /** The router's `source` of the line (config | principals | blocks | jwks | boot …, design §2.3a). */
  source?: string
  /** applied | rejected | ignored | … (17 stores the router's `outcome`). */
  outcome?: string
  configVersion?: string
  principalsVersion?: string
  /** Legacy alias of outcome. */
  status?: string
  /** What the task really runs (0d §3): { identityMode, assessorMode, policyVersion, mode }. */
  effective?: Record<string, unknown>
  /** Per section 'document' | 'baked'. */
  sources?: Record<string, unknown>
  issues?: string[]
  packs?: Array<{ name: string; packVersion: string }>
  drift?: unknown
  /** Dynamic catalog C3: the task's catalog version, where it came from (bucket | bundled | file), universe.json etag. */
  catalogVersion?: string
  catalogSource?: string
  universeVersion?: string
}

/** A router `source: "state"` line (periodic, every 5 min and on every change). */
export interface StateReport extends ConfigReport {
  identityKeys?: { configured?: boolean; loaded?: boolean; kids?: number; versions?: Record<string, unknown> }
}

export interface UsageStore {
  /**
   * One principal's records, newest first. The cursor is opaque; implementations must reject a cursor that does
   * not belong to this principal's partition (no cross-principal paging).
   */
  principalRecords(key: string, q: RecordScan): Promise<Page<StoredRecord>>
  /** All records (admin, by day index), newest first. */
  allRecords(q: RecordScan): Promise<Page<StoredRecord>>
  /**
   * A record by reqId; with `key`, only when it belongs to that principal. With `key` and `ts` (the record's own
   * timestamp, from a list row) this is one GetItem; otherwise a bounded filtered scan.
   */
  record(reqId: string, key?: string, ts?: string): Promise<StoredRecord | undefined>
  /** One session of one principal, oldest first (bounded). */
  session(key: string, label: string, limit: number): Promise<StoredRecord[]>
  /** Rollup items for days in [from, to] (inclusive); `key` absent = all principals (A# items). */
  rollups(from: string, to: string, key?: string): Promise<RollupItem[]>
  /** Template-family days in [from, to] (inclusive; F# items). */
  familyRollups(from: string, to: string): Promise<FamilyRollupItem[]>
  /** Admin assessor rule days in [from, to] (inclusive; R# items). */
  customRuleRollups(from: string, to: string): Promise<CustomRuleRollupItem[]>
  /** Month spend (nano-USD: spend + assessor) per principal (B# items). */
  monthSpend(keys: readonly string[], month: string): Promise<Map<string, number>>
  /** The router's latest config reports, newest first (bounded). */
  configReports(limit: number): Promise<ConfigReport[]>
  /** The latest state line of every task (17: C#state items, sk = task; 0d-effective-config §7). */
  stateReports(): Promise<StateReport[]>
}

/** The config/identity bucket and the packs archive (keys as in design §1; values JSON text). */
export interface ObjectStore {
  get(key: string): Promise<string | undefined>
  /** With ETag; `ifNoneMatch` equal to the current ETag → 'not-modified'. Undefined when the object is absent. */
  getObject(key: string, ifNoneMatch?: string): Promise<{ body: string; etag: string } | 'not-modified' | undefined>
  put(key: string, body: string): Promise<void>
  /**
   * Conditional put (dynamic catalog: catalog/models.json and catalog/current.json have two writers): `ifMatch` = the
   * ETag read, or `ifNoneMatch: '*'` = only when absent. 'precondition-failed' when the condition does not hold.
   */
  putIf(key: string, body: string, cond: { ifMatch: string } | { ifNoneMatch: '*' }): Promise<{ etag: string } | 'precondition-failed'>
  /** Every key under `prefix`, ascending (catalog/snapshots/ is ordered by capture time). */
  listKeys(prefix: string): Promise<string[]>
}

/** Asynchronous Lambda invoke (InvocationType Event) of the catalog refresh and grant functions. */
export interface FunctionInvoker {
  invokeAsync(functionName: string, payload: Record<string, unknown>): Promise<void>
  /** RequestResponse invoke: the function's result; rejects when the invoke or the function failed (FunctionError). */
  invokeSync(functionName: string, payload: Record<string, unknown>): Promise<unknown>
}

export interface DirectoryUser {
  username: string
  sub: string
  email: string
  name?: string
  enabled: boolean
  /** Cognito UserStatus (FORCE_CHANGE_PASSWORD = invited). */
  status: string
  groups: Role[]
  /** TOTP enrolled. The user pool has MFA off (user decision 2026-11-08): always false; kept for the contract's display field. */
  mfa: boolean
  createdAt: string
}

export interface Directory {
  listUsers(): Promise<DirectoryUser[]>
  getUser(username: string): Promise<DirectoryUser | undefined>
  userBySub(sub: string): Promise<DirectoryUser | undefined>
  /** 'exists' when the e-mail is taken. */
  createUser(u: { email: string; name: string; role: Role }): Promise<DirectoryUser | 'exists'>
  resendInvite(username: string): Promise<void>
  setRole(username: string, role: Role): Promise<void>
  disable(username: string): Promise<void>
  enable(username: string): Promise<void>
  signOut(username: string): Promise<void>
  deleteUser(username: string): Promise<void>
}

/** Cognito app clients created by the console (client credentials, invoke scope). */
export interface ClientDirectory {
  createClient(name: string): Promise<{ clientId: string; secret: string }>
  /** New secret; the old one stops working (rotation semantics per adapter). */
  rotateSecret(clientId: string): Promise<{ secret: string }>
  deleteClient(clientId: string): Promise<void>
}

export interface GatewayReader { describe(): Promise<GatewayInfo> }
export interface MetricsReader { health(range: HealthRange): Promise<HealthReport> }
/** The router service's running task count (ECS DescribeServices runningCount); undefined when unreadable. */
export interface RouterTasks { runningCount(): Promise<number | undefined> }

/** Deployment values (Lambda environment, set by the ConsoleStack from RouterStack SSM parameters). */
export interface DeploymentEnv {
  prefix: string
  consoleScope: string
  region: string
  gatewayUrl?: string
  inferenceUrl?: string
  cognitoDomain?: string
  authorizeEndpoint?: string
  tokenEndpoint?: string
  revokeEndpoint?: string
  cliClientId?: string
  invokeScope?: string
  callbackPorts?: number[]
  codexOauthPort?: number
  /** `x-api-key` by default; null when the identity spike forces none (17 §3). */
  identityHeader?: string | null
  /** cli refresh-token lifetime (CDK). */
  refreshDays: number
  /** Models the task role may invoke (deploy parameter allowedModelUniverse). */
  modelUniverse: readonly string[]
  /** Record retention in days (deploy parameter recordRetentionDays; read-only in the console). Default 90. */
  retentionDays?: number
  /** Dynamic catalog (C2b): the refresh and grant function names; the admin.models/catalog routes answer 503 without them. */
  catalogRefreshFunction?: string
  catalogGrantFunction?: string
  /**
   * ADR 0002: the deployment's egress boundary (PROVIDER_BOUNDARY). Absent = `{ mode: 'none' }`: no provider other than
   * Bedrock may be added in the console.
   */
  providerBoundary?: EgressBoundary
  /** The provider secret prefix (PROVIDER_SECRET_PREFIX): managed keys are `<prefix>/providers/<id>`. Absent: keys cannot be stored. */
  providerSecretPrefix?: string
  /**
   * nat-dns (ADR 0003): the provider-dns-sync function (PROVIDER_DNS_SYNC_FUNCTION; 'none' = absent). Invoked
   * synchronously with the document before config/active.json is written; its failure fails the activation.
   */
  providerDnsSyncFunction?: string
}

/** What the request's catalog came from (dynamic catalog C3; set per request by createHandler). */
export interface CatalogInfo {
  source: 'bucket' | 'bundled'
  pointer?: CatalogPointer
  /** The deploy's CloudFormation grant (MODEL_UNIVERSE): env.modelUniverse before granted models were added. */
  base: readonly string[]
  /** catalog/universe.json ids that are in the catalog. */
  granted: readonly string[]
  /** Etag of catalog/universe.json, 'none' when absent. */
  universeVersion: string
}

/**
 * Console-managed provider keys in Secrets Manager (ADR 0002). Write-only: no method returns a secret value, and
 * adapters never log one.
 */
export interface ProviderKeyStore {
  /** DescribeSecret: undefined when the secret is absent or scheduled for deletion. */
  status(name: string): Promise<{ updatedAt?: string } | undefined>
  /** PutSecretValue, or CreateSecret with `tags` when absent (a secret scheduled for deletion is restored first). */
  put(name: string, value: string, tags: Readonly<Record<string, string>>): Promise<void>
  /** DeleteSecret with a recovery window; a no-op when absent or already scheduled. */
  delete(name: string, recoveryDays: number): Promise<void>
}

/** Overrides core policySwapEffects (tests); absent = core's. */
export type SwapEffects = (prev: ConfigDocument | undefined, next: ConfigDocument, catalog: Catalog) => SwapEffect[]

export interface Deps {
  console: ConsoleStore
  usage: UsageStore
  objects: ObjectStore
  directory: Directory
  clients: ClientDirectory
  gateway: GatewayReader
  metrics: MetricsReader
  tasks: RouterTasks
  /**
   * The catalog in force for this request: the config bucket's current version, else the bundled one (createHandler
   * resolves it per request; reading it answers 503 catalog-unavailable when neither exists).
   */
  catalog: PriceCatalog
  /** Set by createHandler with `catalog`; absent on hand-built deps (tests): bundled, no granted models. */
  catalogInfo?: CatalogInfo
  /**
   * External providers (set by createHandler with `catalog`): the catalog routing sees (`catalog` plus the registry
   * models, as the router merges it) and the registry it came from. Absent: no providers (providers.ts routingCatalog).
   */
  routing?: RoutingCatalog
  /** Invokes the catalog refresh and grant functions and provider-dns-sync; absent: those routes answer 503. */
  invoker?: FunctionInvoker
  /** Provider keys (ADR 0002); absent (no PROVIDER_SECRET_PREFIX): the key routes answer 503 provider-keys-unavailable. */
  providerKeys?: ProviderKeyStore
  /**
   * Universe in `env.modelUniverse` is effective per request: the deploy's grant plus granted models (catalogInfo.base
   * is the deploy's alone).
   */
  env: DeploymentEnv
  swapEffects?: SwapEffects
  /** admin.config.translateRules; absent when the deployment turned translation off (rulesModel=none). */
  rules?: RulesTranslator
  now(): number
  uuid(): string
  /** Structured log sink (ids and codes only). */
  log(entry: Record<string, unknown>): void
}

/**
 * Deps as the Lambda builds them: `catalog` is the Region's bundled catalog, absent in a Region without one (the
 * bucket's current catalog is then the only one).
 */
export type BaseDeps = Omit<Deps, 'catalog' | 'catalogInfo' | 'routing'> & { catalog?: PriceCatalog }

export interface RoutingCatalog {
  catalog: PriceCatalog
  /** The registry in force (ADR 0002: the active document's providers section, else the deploy-time registry); undefined = none. */
  registry?: ProviderRegistry
  /** Router ids of the registry models merged into `catalog` (empty when the merge failed). */
  registryModels: readonly string[]
  /** Where `registry` comes from: the active document's section, or the deploy (absent = 'baked'). */
  source?: 'document' | 'baked'
  /**
   * The deploy-time registry (config/baked.json's providers, else the legacy providers/active.json): what a document
   * without a providers section runs, and whose secret ARNs a document may keep. Undefined = none.
   */
  baked?: ProviderRegistry
}
