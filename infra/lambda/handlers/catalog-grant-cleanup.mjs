// catalog-grant-cleanup (RouterStack): Custom::CatalogGrantCleanup onEvent (CDK Provider framework); deletes the
// dynamic model-grant policies before the task role on stack delete.
export { handler } from '../packages/catalog-service/src/cleanup-handler.ts'
