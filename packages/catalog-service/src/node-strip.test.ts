// The catalog Lambdas run these sources under Node's strip-only type stripping (infra/lambda/catalog.Dockerfile),
// which vitest does not. scripts/node-strip-check.mjs runs plain `node` on the entry and on every runtime file (the
// guard's own failure cases are tested in packages/usage-ingest).
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = fileURLToPath(new URL('../../../scripts/node-strip-check.mjs', import.meta.url))

function check(args: string[], cwd = PKG): { status: number | null; out: string } {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8', timeout: 90_000 })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('runs under plain Node (strip-only type stripping)', () => {
  it('every Lambda entry imports, and no runtime file uses strip-unsupported syntax', () => {
    const r = check(['--import', 'src/grant-handler.ts', '--import', 'src/cleanup-handler.ts', '--import', 'src/refresh-handler.ts', '--import', 'src/provider-dns-handler.ts', 'src'])
    expect(r.out).toMatch(/PASS/)
    expect(r.status).toBe(0)
  }, 90_000)
})
