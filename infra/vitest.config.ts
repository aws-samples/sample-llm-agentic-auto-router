import { defineConfig } from 'vitest/config'

// cdk.out holds Docker asset contexts (a copy of the workspace, including other packages' tests): never collect them.
// test-setup.ts removes each test file's temp dirs (CDK outdirs) when the file ends.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], exclude: ['cdk.out/**', 'node_modules/**'], setupFiles: ['src/test-setup.ts'] } })
