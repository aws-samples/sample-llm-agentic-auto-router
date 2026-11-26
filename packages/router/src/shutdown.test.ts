// Graceful stop (design review 2026-11-17): requests in flight finish within the grace; the router ends the rest
// itself so each still writes its log line and the usage billed so far.
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { Engine, RecordOutcome } from '@auto-router/core'
import { SHUTDOWN_LOG_MS } from './server.ts'
import { chop, fixture, HAIKU, hopHeaders, startFakeBedrock, startRouter, waitForLogs, type Reply, type Script } from './test-helpers.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await (cleanups.pop() as () => Promise<void>)() })

function capturing(outcomes: RecordOutcome[]) {
  return (e: Engine): Engine => ({ ...e, record: (s, d, o) => { outcomes.push(o); return e.record(s, d, o) } })
}
async function setup(script: Script, opts: Parameters<typeof startRouter>[1] = {}) {
  const fake = await startFakeBedrock(script)
  const router = await startRouter(fake.url, opts)
  cleanups.push(fake.close, router.close)
  return { fake, router }
}
const BODY = `{"max_tokens":16,"model":"${HAIKU}","messages":[{"role":"user","content":"hi"}],"stream":true}`
const post = (url: string, body = BODY) => fetch(url + '/v1/messages', { method: 'POST', body, headers: { 'content-type': 'application/json', ...hopHeaders() } })
const SSE = fixture('anthropic-messages/stream-read.sse.txt')
/** message_start (with usage) at once, then a tail that takes `ms` in total. */
function slowStream(ms: number): Reply {
  const cut = SSE.indexOf('event: content_block_delta')
  const n = Math.ceil(ms / 20)
  return { contentType: 'text/event-stream', chunks: [SSE.slice(0, cut), ...Array.from({ length: n }, () => ': keep-alive\n\n')], delayMs: 20 }
}
async function readUntil(res: Response, marker: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  let seen = ''
  while (!seen.includes(marker)) seen += new TextDecoder().decode((await reader.read()).value)
  return reader
}

describe('router shutdown', () => {
  it('nothing in flight: resolves at once', async () => {
    const { router } = await setup(() => ({ chunks: ['{}'] }))
    const t = Date.now()
    expect(await router.shutdown(5000)).toEqual({ inFlight: 0, cut: 0 })
    expect(Date.now() - t).toBeLessThan(500)
  })

  it('a request that ends within the grace is not cut, and shutdown does not wait out the grace', async () => {
    const { router } = await setup(() => ({ contentType: 'text/event-stream', chunks: chop(SSE), delayMs: 2 }))
    const res = await post(router.url)
    const t = Date.now()
    const [done, text] = await Promise.all([router.shutdown(10_000), res.text()])
    expect(done).toEqual({ inFlight: 1, cut: 0 })
    expect(Date.now() - t).toBeLessThan(5000)
    expect(text).toBe(SSE)
    expect(router.logs[0]).toMatchObject({ status: 200 })
    expect(router.logs[0]).not.toHaveProperty('reason')
  })

  it('a stream still running after the grace is ended by the router: 503 shutdown with the usage so far, recorded as served (no failover armed)', async () => {
    const outcomes: RecordOutcome[] = []
    const { router, fake } = await setup(() => slowStream(5000), { wrapEngine: capturing(outcomes) })
    const res = await post(router.url)
    const reader = await readUntil(res, 'message_start')
    const t = Date.now()
    expect(await router.shutdown(50)).toEqual({ inFlight: 1, cut: 1 })
    expect(Date.now() - t).toBeLessThan(50 + SHUTDOWN_LOG_MS)
    // The client's stream is cut (it already had 200 and the first frames).
    await expect((async () => { for (;;) { const r = await reader.read(); if (r.done) break } })()).rejects.toThrow()
    expect(fake.requests[0]?.closedEarly).toBe(true)
    const log = router.logs[0] as Record<string, any>
    expect(log).toMatchObject({ status: 503, reason: 'shutdown', servedModel: HAIKU, error: 'aborted' })
    expect(log.clientAborted).toBeUndefined()
    expect(log.usage?.promptTokens).toBeGreaterThan(0)
    expect(log.costUsd?.total).toBeGreaterThan(0)
    // Core sees the call as served with its partial usage: the model did not fail.
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ servedModel: HAIKU, status: 200 })
    expect(outcomes[0]?.usage?.promptTokens).toBe(log.usage.promptTokens)
    // Not an upstream error in the metrics.
    const emf = router.lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((o) => '_aws' in o) as Record<string, unknown>
    expect(emf.UpstreamErrors).toBeUndefined()
    expect(emf.Reason).toBe('shutdown')
  })

  it('a request cut before the upstream answered gets 503 and records nothing', async () => {
    const outcomes: RecordOutcome[] = []
    const { router } = await setup(() => ({ chunks: ['{}'], headerDelayMs: 5000 }), { wrapEngine: capturing(outcomes) })
    const pending = post(router.url)
    await new Promise((ok) => setTimeout(ok, 100)) // the forward is under way
    expect(await router.shutdown(20)).toEqual({ inFlight: 1, cut: 1 })
    const res = await pending
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'router shutting down' })
    await waitForLogs(router, 1)
    expect(router.logs[0]).toMatchObject({ status: 503, reason: 'shutdown' })
    expect(router.logs[0]).not.toHaveProperty('clientAborted')
    expect(outcomes).toHaveLength(0)
  })

  it('while stopping, every answer asks the hop to close the connection; after the cut, new requests get 503 and a log line', async () => {
    const plain = BODY.replace(',"stream":true', '')
    const { router } = await setup((r) => (r.json.stream === true ? { chunks: [SSE], contentType: 'text/event-stream', headerDelayMs: 150 }
      : { chunks: ['{"id":"m","type":"message","usage":{"input_tokens":1,"output_tokens":1}}'] }))
    expect((await post(router.url, plain)).headers.get('connection')).not.toBe('close')
    // In flight before the stop, answered after it.
    const early = post(router.url)
    await new Promise((ok) => setTimeout(ok, 30))
    const stopped = router.shutdown(3000)
    // Arrives during the grace: still served.
    const during = await post(router.url, plain)
    expect(during.status).toBe(200)
    expect(during.headers.get('connection')).toBe('close')
    const first = await early
    expect(first.status).toBe(200)
    expect(first.headers.get('connection')).toBe('close')
    expect(await first.text()).toBe(SSE)
    expect(await stopped).toEqual({ inFlight: 1, cut: 0 })
    // After the cut nobody would be left to end a request: refused, and logged.
    const n = router.logs.length
    const late = await post(router.url, plain)
    expect(late.status).toBe(503)
    expect(late.headers.get('connection')).toBe('close')
    expect(await late.json()).toEqual({ error: 'router shutting down' })
    expect(router.logs.slice(n)).toMatchObject([{ status: 503, reason: 'shutdown', kind: 'rejected' }])
  })

  it('a request whose body is still arriving at the cut is answered 503 and logged', async () => {
    const { router, fake } = await setup(() => ({ chunks: ['{}'] }))
    const { port, hostname } = new URL(router.url)
    const answer = new Promise<{ status: number; body: string }>((ok, fail) => {
      const req = httpRequest({ host: hostname, port, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '1000', ...hopHeaders() } }, (res) => {
        let body = ''
        res.on('data', (c: Buffer) => { body += c.toString() })
        res.on('end', () => ok({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', fail)
      req.write('{"model":') // the rest never comes
    })
    await new Promise((ok) => setTimeout(ok, 50))
    expect(await router.shutdown(20)).toEqual({ inFlight: 1, cut: 1 })
    expect(await answer).toEqual({ status: 503, body: '{"error":"router shutting down"}' })
    expect(router.logs).toMatchObject([{ status: 503, reason: 'shutdown' }])
    expect(fake.requests).toHaveLength(0)
  })

  it('a stream held up by a client that stopped reading is cut and logged too', async () => {
    const big = `: ${'x'.repeat(64 * 1024)}\n\n`
    const cut = SSE.indexOf('event: content_block_delta')
    const { router } = await setup(() => ({ contentType: 'text/event-stream', chunks: [SSE.slice(0, cut), ...Array.from({ length: 200 }, () => big)] }))
    const res = await post(router.url) // headers only: the body is never read, so the router's writes back up
    await new Promise((ok) => setTimeout(ok, 300))
    expect(await router.shutdown(20)).toEqual({ inFlight: 1, cut: 1 })
    expect(router.logs).toMatchObject([{ status: 503, reason: 'shutdown' }])
    expect((router.logs[0] as Record<string, any>).usage?.promptTokens).toBeGreaterThan(0)
    await res.body?.cancel().catch(() => undefined)
  })
})
