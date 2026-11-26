// Template memory (brief D). Automated clients start a user message with a long fixed prompt (an agent's instructions)
// and put the actual task after it. The memory learns, per scope (a verified principal × the request's template
// family), which line-boundary prefixes of user texts several lineages have sent with different continuations, so a
// mapping can read "this turn is templated, with a template this long" (map.ts CardFeatures.templateChars).
//
// What is kept: truncated sha256 hashes of prefixes, of what follows them and of lineage ids. No text is stored,
// persisted or logged. Bounds: TEMPLATE_LIMITS (LRU over scopes; per scope, LRU over once-seen and over shared prefixes,
// kept apart; a global entry cap). Deterministic for a given sequence of lookups and observations; a lookup does not
// change the memory. Process-local: each router process learns on its own and forgets on restart.
import { createHash } from 'node:crypto'

export const TEMPLATE_LIMITS = {
  /** Only boundaries within the first this-many chars of a text are hashed (automated prompts run to ~40k of template). */
  scanChars: 64_000,
  /** At most this many boundaries per text. */
  maxBoundaries: 512,
  /** A template shorter than this is not reported. */
  minChars: 200,
  /** A prefix is template once at least this many OTHER lineages of the scope sent it (and continuations differ). */
  minLineages: 2,
  /** Scopes kept (least recently observed dropped first). More active principal × family pairs than this thrash. */
  maxScopes: 64,
  /** Per scope: prefixes one lineage sent so far (least recently observed dropped first). */
  maxOnce: 4_096,
  /** Per scope: prefixes two or more lineages sent (kept apart, so variable text cannot push templates out). */
  maxShared: 2_048,
  /** All scopes together: entries kept (whole least recently observed scopes dropped first). About 150 bytes each. */
  maxEntries: 131_072,
} as const
export type TemplateLimits = { -readonly [K in keyof typeof TEMPLATE_LIMITS]: number }

/** One scope (principal + family) seen from one lineage. */
export interface TemplateScope {
  /** Length of the learned template at the start of `text` (0 = none). Always a boundary just after a '\n'. */
  lengthOf(text: string): number
  /** Records `text` as sent by this lineage. */
  observe(text: string): void
}

export interface TemplateMemory {
  /** `principal` and `family` select the scope; `lineage` is the sender (only distinct other lineages count). */
  scope(principal: string, family: string, lineage: string): TemplateScope
  /** Scopes and entries currently held (tests, metrics). */
  size(): { scopes: number; entries: number }
}

const h16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

/**
 * The line-boundary prefixes of `text`: for each '\n' at index i (i + 1 < text.length, i + 1 ≤ scanChars), the hash of
 * text.slice(0, i + 1) and of what follows it (the next boundary's prefix, or the whole text after the last one). The
 * whole text is never a candidate, so the last line always stays outside a template.
 */
export function boundaryHashes(text: string, limits: Pick<TemplateLimits, 'scanChars' | 'maxBoundaries'> = TEMPLATE_LIMITS): Array<{ end: number; hash: string; next: string }> {
  const ends: number[] = []
  const stop = Math.min(text.length - 1, limits.scanChars)
  for (let i = text.indexOf('\n'); i >= 0 && i + 1 <= stop && ends.length < limits.maxBoundaries; i = text.indexOf('\n', i + 1)) ends.push(i + 1)
  const h = createHash('sha256')
  const hashes: string[] = []
  let last = 0
  for (const e of ends) { h.update(text.slice(last, e)); last = e; hashes.push(h.copy().digest('hex').slice(0, 16)) }
  const whole = ends.length > 0 ? h.update(text.slice(last)).digest('hex').slice(0, 16) : ''
  return ends.map((end, k) => ({ end, hash: hashes[k] as string, next: hashes[k + 1] ?? whole }))
}

interface Shared { lineages: string[]; nexts: string[] }
interface Scope {
  /** Prefixes sent by one lineage so far: hash -> [lineage, next]. Most entries come from the variable part of a text. */
  once: Map<string, [string, string]>
  /** Prefixes sent by two or more lineages: lineages (at most minLineages + 1) and distinct continuations (at most 2). */
  shared: Map<string, Shared>
}

// Map insertion order = recency (delete + set refreshes); the oldest entry is dropped first.
const touch = <V>(m: Map<string, V>, k: string, v: V): void => { m.delete(k); m.set(k, v) }
const trim = (m: Map<string, unknown>, max: number): void => { while (m.size > max) m.delete(m.keys().next().value as string) }
const addCapped = (xs: string[], x: string, max: number): void => { if (!xs.includes(x)) { xs.push(x); if (xs.length > max) xs.shift() } }

export function createTemplateMemory(overrides: Partial<TemplateLimits> = {}): TemplateMemory {
  const L: TemplateLimits = { ...TEMPLATE_LIMITS, ...overrides }
  const scopes = new Map<string, Scope>()
  let entries = 0
  const count = (sc: Scope) => sc.once.size + sc.shared.size

  return {
    scope(principal, family, lineage) {
      const key = h16(JSON.stringify([principal, family]))
      const me = h16(lineage)
      return {
        lengthOf(text) {
          const sc = scopes.get(key)
          if (!sc) return 0
          // The longest boundary that enough other lineages sent and after which the texts went different ways
          // (identical re-sends of one whole message are not a template). A shared longer prefix implies its shorter
          // ones were shared, so a dropped shorter entry does not matter.
          let len = 0
          for (const b of boundaryHashes(text, L)) {
            const s = sc.shared.get(b.hash)
            if (s && s.nexts.length >= 2 && s.lineages.filter((x) => x !== me).length >= L.minLineages) len = b.end
          }
          return len >= L.minChars ? len : 0
        },
        observe(text) {
          const bs = boundaryHashes(text, L)
          if (bs.length === 0) return
          const known = scopes.get(key)
          const sc = known ?? { once: new Map<string, [string, string]>(), shared: new Map<string, Shared>() }
          if (known) entries -= count(sc)
          touch(scopes, key, sc)
          for (const b of bs) {
            const shared = sc.shared.get(b.hash)
            if (shared) {
              addCapped(shared.lineages, me, L.minLineages + 1)
              addCapped(shared.nexts, b.next, 2)
              touch(sc.shared, b.hash, shared)
              continue
            }
            const first = sc.once.get(b.hash)
            if (first === undefined || first[0] === me) touch(sc.once, b.hash, [me, b.next])
            else {
              // A second lineage: the prefix moves to the shared tier, where once-seen churn cannot push it out.
              sc.once.delete(b.hash)
              touch(sc.shared, b.hash, { lineages: [first[0], me], nexts: first[1] === b.next ? [b.next] : [first[1], b.next] })
            }
          }
          trim(sc.once, L.maxOnce)
          trim(sc.shared, L.maxShared)
          entries += count(sc)
          // Scope count and global entry cap: drop whole least recently observed scopes (never the one just observed).
          while (scopes.size > 1 && (scopes.size > L.maxScopes || entries > L.maxEntries)) {
            const oldest = scopes.keys().next().value as string
            entries -= count(scopes.get(oldest) as Scope)
            scopes.delete(oldest)
          }
        },
      }
    },
    size() {
      return { scopes: scopes.size, entries }
    },
  }
}

/** The router's memory: one per process, independent of assessor settings (a config change keeps what was learned). */
let processMemory: TemplateMemory | undefined
export function processTemplateMemory(): TemplateMemory {
  processMemory ??= createTemplateMemory()
  return processMemory
}
