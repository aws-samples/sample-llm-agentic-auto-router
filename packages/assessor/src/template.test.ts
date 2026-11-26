import { describe, expect, it } from 'vitest'
import { summaryOf } from './__fixtures__/fixtures.ts'
import { cardUserTexts } from './card.ts'
import { boundaryHashes, createTemplateMemory, processTemplateMemory, TEMPLATE_LIMITS, type TemplateMemory } from './template.ts'

// A fixed agent prompt of several lines (> minChars), then a task that differs per lineage.
const TEMPLATE = Array.from({ length: 8 }, (_, i) => `Step ${i + 1}: follow the house rules for naming and tagging the given item carefully.`).join('\n') + '\n'
const msg = (task: string): string => `${TEMPLATE}Item: ${task}`
const learn = (m: TemplateMemory, principal = 'p1', family = 'f1', n = 2) => {
  for (let i = 0; i < n; i++) m.scope(principal, family, `lineage-${principal}-${i}`).observe(msg(`task ${i}`))
}

describe('boundaryHashes', () => {
  it('hashes each prefix that ends just after a newline, never the whole text', () => {
    expect(boundaryHashes('ab\ncd\nef').map((b) => b.end)).toEqual([3, 6])
    expect(boundaryHashes('ab\ncd\n').map((b) => b.end)).toEqual([3]) // a text ending with '\n': the last one would be the whole text
    expect(boundaryHashes('no newline')).toEqual([])
  })

  it('gives a prefix the same hash whatever follows it, and its continuation a different one', () => {
    const a = boundaryHashes('one\ntwo\nthree')
    const b = boundaryHashes('one\ntwo\nfour')
    expect(a.map((x) => x.hash)).toEqual(b.map((x) => x.hash))
    expect(a[0]?.next).toBe(b[0]?.next) // after "one\n" comes "two\n" in both
    expect(a[1]?.next).not.toBe(b[1]?.next) // after "one\ntwo\n" they differ
    expect(boundaryHashes('one\ntwX\nthree')[1]?.hash).not.toBe(a[1]?.hash)
  })

  it('stays within scanChars (a boundary exactly at it counts) and maxBoundaries', () => {
    const text = 'x\n'.repeat(1000) + 'end'
    expect(boundaryHashes(text, { scanChars: 100, maxBoundaries: 1000 }).at(-1)?.end).toBe(100)
    expect(boundaryHashes(text, { scanChars: 99, maxBoundaries: 1000 }).at(-1)?.end).toBe(98)
    expect(boundaryHashes(text, { scanChars: 100_000, maxBoundaries: 7 })).toHaveLength(7)
  })
})

describe('createTemplateMemory', () => {
  it('learns a template once enough OTHER lineages sent it with different continuations', () => {
    const m = createTemplateMemory()
    learn(m, 'p1', 'f1', 1)
    expect(m.scope('p1', 'f1', 'new').lengthOf(msg('mine'))).toBe(0) // one other lineage is not enough
    learn(m, 'p1', 'f1', 2)
    expect(m.scope('p1', 'f1', 'new').lengthOf(msg('mine'))).toBe(TEMPLATE.length)
  })

  it('does not take identical re-sends of one whole message for a template', () => {
    const m = createTemplateMemory()
    const same = msg('the same stack trace, pasted again')
    for (const l of ['a', 'b', 'c', 'd']) m.scope('p', 'f', l).observe(same)
    expect(m.scope('p', 'f', 'e').lengthOf(same)).toBe(0)
    // once a sender goes a different way after the shared part, that part is a template
    m.scope('p', 'f', 'x').observe(msg('a different question'))
    expect(m.scope('p', 'f', 'e').lengthOf(same)).toBe(TEMPLATE.length)
  })

  it('does not count the asking lineage, however often it sent the text', () => {
    const m = createTemplateMemory()
    const self = m.scope('p1', 'f1', 'me')
    for (let i = 0; i < 5; i++) self.observe(msg(`task ${i}`))
    m.scope('p1', 'f1', 'other').observe(msg('x'))
    expect(self.lengthOf(msg('again'))).toBe(0)
    expect(m.scope('p1', 'f1', 'third').lengthOf(msg('y'))).toBe(TEMPLATE.length)
  })

  it('honours a minLineages override', () => {
    const m = createTemplateMemory({ minLineages: 3 })
    learn(m, 'p', 'f', 2)
    expect(m.scope('p', 'f', 'new').lengthOf(msg('q'))).toBe(0)
    learn(m, 'p', 'f', 3)
    expect(m.scope('p', 'f', 'new').lengthOf(msg('q'))).toBe(TEMPLATE.length)
  })

  it('keeps principals and families apart', () => {
    const m = createTemplateMemory()
    learn(m, 'p1', 'f1')
    expect(m.scope('p2', 'f1', 'new').lengthOf(msg('mine'))).toBe(0)
    expect(m.scope('p1', 'f2', 'new').lengthOf(msg('mine'))).toBe(0)
    expect(m.scope('p', '1f1', 'new').lengthOf(msg('mine'))).toBe(0) // the key cannot be shifted between the two
  })

  it('ignores a shared prefix shorter than minChars', () => {
    const m = createTemplateMemory()
    const short = (t: string) => `Please help.\n${t}`
    for (const l of ['a', 'b', 'c']) m.scope('p', 'f', l).observe(short(`thing ${l}`))
    expect(m.scope('p', 'f', 'd').lengthOf(short('mine'))).toBe(0)
  })

  it('learns several templates in one family (the longest shared, diverging prefix wins)', () => {
    const m = createTemplateMemory()
    const other = TEMPLATE.replaceAll('naming and tagging', 'archiving')
    for (const l of ['a', 'b']) m.scope('p', 'f', l).observe(msg(l))
    for (const l of ['c', 'd']) m.scope('p', 'f', l).observe(`${other}Item: ${l}`)
    expect(m.scope('p', 'f', 'e').lengthOf(msg('e'))).toBe(TEMPLATE.length)
    expect(m.scope('p', 'f', 'e').lengthOf(`${other}Item: e`)).toBe(other.length)
  })

  it('treats a CRLF template as its own template, not as the LF one', () => {
    const m = createTemplateMemory()
    const crlf = TEMPLATE.replaceAll('\n', '\r\n')
    for (const l of ['a', 'b']) m.scope('p', 'f', l).observe(msg(l))
    expect(m.scope('p', 'f', 'c').lengthOf(`${crlf}Item: c`)).toBe(0)
    for (const l of ['x', 'y']) m.scope('p', 'f', l).observe(`${crlf}Item: ${l}`)
    expect(m.scope('p', 'f', 'c').lengthOf(`${crlf}Item: c`)).toBe(crlf.length)
  })

  it('keeps a template when lineages rotate (the shared list stays capped)', () => {
    const m = createTemplateMemory()
    for (let i = 0; i < 200; i++) m.scope('p', 'f', `rotating-${i}`).observe(msg(`task ${i}`))
    expect(m.scope('p', 'f', 'rotating-199').lengthOf(msg('again'))).toBe(TEMPLATE.length)
    expect(m.size().entries).toBeLessThanOrEqual(TEMPLATE_LIMITS.maxOnce + TEMPLATE_LIMITS.maxShared)
  })

  it('never changes on a lookup and is deterministic', () => {
    const run = () => {
      const m = createTemplateMemory()
      learn(m)
      const before = m.size()
      const n = m.scope('p1', 'f1', 'q').lengthOf(msg('q'))
      expect(m.size()).toEqual(before)
      return [n, before]
    }
    expect(run()).toEqual(run())
  })

  it('bounds scopes, entries per scope and entries overall (least recently observed dropped)', () => {
    const m = createTemplateMemory({ maxScopes: 3, maxOnce: 5, maxShared: 4 })
    for (let s = 0; s < 6; s++) m.scope(`p${s}`, 'f', 'l').observe(msg('x'))
    expect(m.size()).toEqual({ scopes: 3, entries: 15 })
    const g = createTemplateMemory({ maxEntries: 20 })
    for (let s = 0; s < 6; s++) g.scope(`p${s}`, 'f', 'l').observe(msg('x')) // 8 entries each
    expect(g.size()).toEqual({ scopes: 2, entries: 16 })
    expect(TEMPLATE_LIMITS.maxEntries * 150).toBeLessThanOrEqual(25_000_000) // about 20 MB per process
  })

  it('keeps a learned template when once-seen prefixes churn', () => {
    const m = createTemplateMemory({ maxOnce: 16, maxShared: 64 })
    for (const l of ['a', 'b']) m.scope('p', 'f', l).observe(msg(l))
    for (let i = 0; i < 50; i++) m.scope('p', 'f', `noise-${i}`).observe(Array.from({ length: 40 }, (_, j) => `unique ${i} line ${j}`).join('\n'))
    expect(m.scope('p', 'f', 'new').lengthOf(msg('mine'))).toBe(TEMPLATE.length)
  })

  it('has one process memory, whatever asks for it', () => {
    expect(processTemplateMemory()).toBe(processTemplateMemory())
  })
})

describe('cardUserTexts', () => {
  it('gives the latest, first and previous user texts as the card reads them', () => {
    const body = { system: 's', messages: [
      { role: 'user', content: 'first one' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'second one' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: '<system-reminder>ctx</system-reminder>\nthird one' },
    ] }
    expect(cardUserTexts(summaryOf('anthropic-messages'), body)).toEqual(['first one', 'second one', 'third one'])
    expect(cardUserTexts(summaryOf('anthropic-messages'), { messages: [{ role: 'user', content: 'only' }] })).toEqual(['only'])
  })
})
