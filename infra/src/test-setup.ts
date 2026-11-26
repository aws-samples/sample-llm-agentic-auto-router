// vitest setupFiles: runs in every test file; removes the file's temp dirs (test-outdir.ts) when it ends.
import { afterAll } from 'vitest'
import { removeTestTempDirs } from './test-outdir.ts'

afterAll(removeTestTempDirs)
