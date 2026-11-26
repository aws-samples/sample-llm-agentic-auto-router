// Temp dirs of the infra tests. A CDK outdir holds Docker asset contexts (a copy of the workspace), and /tmp is often
// a RAM-backed tmpfs: every dir made here is removed after its test file (test-setup.ts, vitest setupFiles).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const made: string[] = []

/** A fresh dir under the OS temp dir (`llmar-<label>-XXXXXX`), removed after the current test file. */
export function testTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `llmar-${label}-`))
  made.push(dir)
  return dir
}

/** Removes every dir testTempDir made so far (idempotent). */
export function removeTestTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
}
