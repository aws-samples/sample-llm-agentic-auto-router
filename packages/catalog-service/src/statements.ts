// Bedrock invoke statements: the single source for the CloudFormation grants (infra RouterStack, ConsoleStack, runner)
// and the dynamic grants the catalog-grant Lambda writes (grant-policies.ts). Pure; no AWS SDK.
import type { ModelPrice } from '@auto-router/pricing'

/** Actions of the per-model invoke statements. */
export const INVOKE_ACTIONS = ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'] as const
/** Actions of the Responses default-project statement. */
export const PROJECT_ACTIONS = ['bedrock:InvokeModel'] as const

/** What the statements need from a catalog entry: a `PriceCatalog` satisfies `ScopeCatalog`. */
export type ScopeEntry = Pick<ModelPrice, 'modelId' | 'endpointScope'>
export interface ScopeCatalog { readonly models: readonly ScopeEntry[] }

/** `global.anthropic.claude-haiku-5-5` -> `anthropic.claude-haiku-5-5` (the foundation model behind a profile). */
export const baseModelId = (id: string): string => id.replace(/^(global|[a-z]{2,4})\.(?=[a-z]+\.)/, '')

export interface InvokeStatement { sid: string; resources: string[]; conditions?: Record<string, Record<string, string | string[]>> }

/**
 * bedrock:InvokeModel* statements following the documented cross-Region inference IAM patterns:
 * - global profiles: the profile in the deploy Region, the foundation model in that Region, and the global
 *   foundation model `arn:aws:bedrock:::foundation-model/<id>` with aws:RequestedRegion = "unspecified", each
 *   model statement tied to the profile ARNs with bedrock:InferenceProfileArn;
 * - geographic profiles: the profile, and the foundation model in any destination Region of that profile;
 * - in-Region models: the foundation model in the deploy Region.
 */
export function invokeStatements(ids: readonly string[], catalog: ScopeCatalog, region: string, account: string): InvokeStatement[] {
  const scope = (id: string) => catalog.models.find((m) => m.modelId === id)?.endpointScope
  const profileArn = (id: string) => `arn:aws:bedrock:${region}:${account}:inference-profile/${id}`
  const global = ids.filter((id) => scope(id) === 'global')
  const geo = ids.filter((id) => scope(id) === 'geo')
  const local = ids.filter((id) => scope(id) === 'in-region')
  const profiles = [...global, ...geo]
  const out: InvokeStatement[] = []
  if (profiles.length) {
    out.push({ sid: 'InferenceProfiles', resources: profiles.map(profileArn), conditions: { StringEquals: { 'aws:RequestedRegion': region } } })
    out.push({ sid: 'ProfileModelsInRegion', resources: [...new Set(profiles.map((id) => `arn:aws:bedrock:${region}::foundation-model/${baseModelId(id)}`))],
      conditions: { StringEquals: { 'aws:RequestedRegion': region, 'bedrock:InferenceProfileArn': profiles.map(profileArn) } } })
  }
  if (global.length) {
    out.push({ sid: 'GlobalProfileModels', resources: global.map((id) => `arn:aws:bedrock:::foundation-model/${baseModelId(id)}`),
      conditions: { StringEquals: { 'aws:RequestedRegion': 'unspecified', 'bedrock:InferenceProfileArn': global.map(profileArn) } } })
  }
  if (geo.length) {
    out.push({ sid: 'GeoProfileModels', resources: [...new Set(geo.map((id) => `arn:aws:bedrock:*::foundation-model/${baseModelId(id)}`))],
      conditions: { StringEquals: { 'bedrock:InferenceProfileArn': geo.map(profileArn) } } })
  }
  if (local.length) out.push({ sid: 'InRegionModels', resources: local.map((id) => `arn:aws:bedrock:${region}::foundation-model/${id}`) })
  return out
}

/**
 * The Responses API on bedrock-runtime also authorizes bedrock:InvokeModel on the account's default project
 * (Bedrock User Guide, "Using the Responses API on the bedrock-runtime endpoint" > Permissions). The project
 * authorization carries bedrock:ModelArn (the inference profile the request named), which limits the grant to these
 * models. Stored-response management (GetInvoke/CancelInvoke/DeleteInvoke) is not granted: GET/DELETE are out of scope.
 */
export function responsesProjectStatement(ids: readonly string[], region: string, account: string): InvokeStatement | undefined {
  if (!ids.length) return undefined
  return {
    sid: 'ResponsesDefaultProject',
    resources: [`arn:aws:bedrock:${region}:${account}:project/*`],
    conditions: { StringEquals: { 'bedrock:ModelArn': ids.map((id) => `arn:aws:bedrock:${region}:${account}:inference-profile/${id}`) } },
  }
}

/**
 * The Bedrock part of the router task role's permissions boundary: every resource shape invokeStatements and
 * responsesProjectStatement can produce, and nothing else. No conditions: the identity policies carry them.
 * The foundation-model ARN without a Region is listed on its own (not left to `*` matching an empty segment).
 */
export interface BoundaryStatement { sid: string; actions: readonly string[]; resources: string[] }
export function boundaryBedrockStatements(region: string, account: string): BoundaryStatement[] {
  return [
    { sid: 'BedrockInvoke', actions: INVOKE_ACTIONS, resources: [`arn:aws:bedrock:${region}:${account}:inference-profile/*`,
      'arn:aws:bedrock:*::foundation-model/*', 'arn:aws:bedrock:::foundation-model/*'] },
    { sid: 'BedrockResponsesProject', actions: PROJECT_ACTIONS, resources: [`arn:aws:bedrock:${region}:${account}:project/*`] },
  ]
}
