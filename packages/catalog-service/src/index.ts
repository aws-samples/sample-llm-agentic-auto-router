// @auto-router/catalog-service: the router stack's catalog Lambdas (catalog-grant now; catalog-refresh in C2b) and
// the Bedrock statement builders that infra's CloudFormation grants share with them.
export {
  baseModelId, boundaryBedrockStatements, INVOKE_ACTIONS, invokeStatements, PROJECT_ACTIONS, responsesProjectStatement,
  type BoundaryStatement, type InvokeStatement, type ScopeCatalog, type ScopeEntry,
} from './statements.ts'
export { assertGrantModel, GrantInputError, grantModelIssues, MODEL_ID, parseGrantInput, type GrantModel } from './grant-input.ts'
export { desiredModels, GRANT_DRAINING_KEY, syncFromStore, UNCONFIRM_DELAY_MS, withGrantStatus, type GrantSyncDeps, type GrantSyncResult } from './grant-sync.ts'
export { ALL_PROVIDERS, DEPLOY_INPUTS_KEY, deployFailureMessage, parseRefreshInput, runRefresh, type RefreshDeps, type RefreshInput, type RefreshResult } from './refresh.ts'
export { PreconditionFailed, type ObjectStore, type PutCondition, type StoredObject } from './object-store.ts'
export { guardedModels, policyModelIds } from './config-models.ts'
export {
  assignSlots, documentModelIds, documentText, DYN_POLICY_SLOTS, dynPolicyArn, dynPolicyName, dynPolicySlots, MAX_POLICY_CHARS, policyDocument,
  TooManyModelsError, type PolicyDocumentJson, type PolicyStatementJson,
} from './grant-policies.ts'
export { cleanupGrants, syncGrants, type GrantDeps, type GrantTarget, type IamApi, type PolicyVersionInfo, type SyncReport } from './grant.ts'
