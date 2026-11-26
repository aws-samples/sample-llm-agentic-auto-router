// The v2.3 session turns as the router sees them (brief D): the production buildCard (card/v2) and the template
// length the router would log, from the production template memory fed in transcript time order. Scope = one
// principal per turn set, the family proxy of family_rules.py (tool names + system head + lineage + agent type; the
// router uses core's templateFamilyOf), and the turn's session as the lineage. Everything under results/ is local-only
// (it holds the user's own text).
//
// Skew to keep in mind: the router's memory is process-local (per task, empty after a restart); here one memory sees
// every dev turn of a set in order, so it is as warm as a single long-lived process could be.
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { RequestSummary } from '../../packages/core/src/index.ts'
import { buildCard, cardUserTexts, createTemplateMemory, taskCardIssue, type CardVersion, type TaskCard, type TemplateLimits } from '../../packages/assessor/src/index.ts'
import { loadTurns, splitOf, type Turn } from '../assessor-v23/common.ts'
import { turnBody } from '../assessor-v23/run.ts'

export const HERE = new URL('./', import.meta.url)
const V23 = new URL('../assessor-v23/', import.meta.url)
/** The v2.3 results (gitignored) live in the main checkout; from a worktree point at them with ASSESSOR_V23_RESULTS. */
export const V23_RESULTS: URL = process.env.ASSESSOR_V23_RESULTS ? pathToFileURL(`${process.env.ASSESSOR_V23_RESULTS.replace(/\/$/, '')}/`) : new URL('results/', V23)

export const SETS = {
  main: { turns: new URL('sessions/turns.jsonl', V23_RESULTS), labelSuffix: '' },
  kiro: { turns: new URL('sessions/kiro-turns.jsonl', V23_RESULTS), labelSuffix: '-kiro' },
  // the same kiro turns exported without the 12,000-char cap (sessions.py --max-chars)
  'kiro-full': { turns: new URL('results/sessions/kiro-turns-full.jsonl', HERE), labelSuffix: '-kiro' },
} as const
export type SetName = keyof typeof SETS

const CURRENT = 'global.anthropic.claude-sonnet-5-5'

/** family_rules.py family(): sha256(sorted tools \0-joined + \1 + systemHead + \2 + lineage + agentType)[:12]. */
export function familyOf(t: Turn): string {
  return createHash('sha256').update(`${[...t.tools].sort().join('\0')}\u0001${t.systemHead}\u0002${t.lineage}${t.agentType ?? ''}`).digest('hex').slice(0, 12)
}

/** Dev turns of a set in transcript time order (ties by id): the order the memory sees them. Never the test split. */
export function devTurns(set: SetName): Turn[] {
  return loadTurns(SETS[set].turns).filter((t) => splitOf(t.session) === 'dev')
    .sort((a, b) => ((a as { ts?: string }).ts ?? '').localeCompare((b as { ts?: string }).ts ?? '') || a.id.localeCompare(b.id))
}

function summaryOf(t: Turn, messageCount: number): RequestSummary {
  return {
    dialect: 'anthropic-messages', requestedModel: 'auto', session: { root: t.session, lineage: t.session, source: 'header' },
    lastTurn: 'user-text', nonPortableState: [],
    prefix: { toolsHash: 'eval-tools', systemHash: 'eval-system', blockHashes: [], estPromptTokens: t.estPromptTokens, messageCount },
    hints: t.lineage === 'subagent' ? { boundary: 'subagent-start', parentSession: 'eval-parent' } : {}, receivedAt: 0,
  }
}

/** The card the router would build for this turn (as assessor-v23/run.ts turnCard). */
export function cardFor(t: Turn, version: CardVersion = 'card/v2'): TaskCard {
  const { body, messages } = turnBody(t)
  const card = buildCard(summaryOf(t, messages.length), body, {
    lineageKind: t.lineage, compactions: t.compactions,
    ...(t.lineage === 'subagent' ? { parentTier: 'standard' as const } : {}),
    ...(t.turnIndex > 0 || t.lineage === 'subagent' ? { currentModel: CURRENT, currentTier: 'standard' as const } : {}),
  }, version)
  const issue = taskCardIssue(card)
  if (issue) throw new Error(`${t.id}: invalid card: ${issue}`)
  return card
}

export interface TemplateView { templateChars: number; perText: Array<{ text: string; chars: number }> }

/**
 * What the router's card() computes per turn, in order: the template length of each user text the card reads (looked
 * up before the turn's texts are recorded) and their maximum (`templateChars`, the logged number).
 */
export function templateViews(turns: Turn[], principal: string, limits: Partial<TemplateLimits> = {}): Map<string, TemplateView> {
  const memory = createTemplateMemory(limits)
  const out = new Map<string, TemplateView>()
  for (const t of turns) {
    const { body, messages } = turnBody(t)
    const texts = cardUserTexts(summaryOf(t, messages.length), body)
    const scope = memory.scope(principal, familyOf(t), t.session)
    const perText = texts.map((text) => ({ text, chars: scope.lengthOf(text) }))
    for (const x of texts) scope.observe(x)
    out.set(t.id, { templateChars: Math.max(0, ...perText.map((p) => p.chars)), perText })
  }
  return out
}
