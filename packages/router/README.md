# @auto-router/router

This is the data plane behind AgentCore Gateway: design `docs/tasks/11-04-router-dataplane-mvp/design.md` §2. It is a `node:http` service. For each request it:
- verifies the gateway → router hop;
- runs `@auto-router/core`;
- splices only the top-level `model` value;
- SigV4-signs the request to `bedrock-runtime`;
- relays the response bytes as they arrive;
- accounts usage with `@auto-router/pricing`.

```
pnpm -C packages/router typecheck && pnpm -C packages/router test     # unit + integration (fake Bedrock on 127.0.0.1)
node packages/router/scripts/smoke.ts                                 # real entrypoint + real signer (dummy creds) vs fake Bedrock
docker build -f packages/router/Dockerfile -t llmar-router .          # from the repo root; ARM64
```

## Configuration (environment)

| Variable | Default | Notes |
|---|---|---|
| `ROUTER_REGION` | **required** (else `AWS_REGION` / `AWS_DEFAULT_REGION`) | There is no built-in Region. It selects the bundled price catalog for that Region, and boot fails if there is none. |
| `ROUTER_CATALOG_FILE` / `ROUTER_CATALOG_JSON` | bundled catalog | A catalog you captured for another Region (see the pricing README). It is validated, and its `region` must equal `ROUTER_REGION`. |
| `ROUTER_BIND` / `ROUTER_PORT` | `127.0.0.1` / `8080` | The task definition sets `0.0.0.0`. The container uses awsvpc with no published host port; its SG admits only the hop's load balancer. |
| `ROUTER_HOP_AUTH` | unset = **reject all** | `apigw-iam` also needs `ROUTER_GATEWAY_ROLE_ARN`, `ROUTER_GATEWAY_ARN` and `ROUTER_API_VPCE_ID`. It trusts only `x-router-caller-arn` and `x-router-source-vpce`, which the private REST API maps from `context.identity`, plus `x-amz-source-arn`. Repeated values are rejected. |
| `ROUTER_INBOUND_TEST_BYPASS=1` | off | Refused at boot unless the bind is loopback. |
| `ROUTER_POLICY_FILE` / `ROUTER_POLICY_JSON` | required | Validated against the Region's catalog at boot: every pool, failover and observe-default model must exist there. The image ships `config/policy.default.json`, which uses global profiles only, runs in observe mode, and serves alias requests with Sonnet 5.5 or GPT-6.1 Sol. `config/policy.example.ap-northeast-1.json` adds Tokyo's `jp.` failover profiles. |
| `ROUTER_HINTS` | all off | JSON, e.g. `{"chatIncludeUsage":"inject-strip","claudeAutoCache":false}`. |
| `ROUTER_MAX_BODY_BYTES` | 10 MiB | Matches the API Gateway REST payload cap on the hop: larger requests get 413 at the API, and never reach the router. Duplicate top-level keys get 400. |
| `ROUTER_STREAM_HEADER_TIMEOUT_MS` / `ROUTER_NONSTREAM_HEADER_TIMEOUT_MS` | 60000 / 600000 | One deadline per request, until response headers arrive, covering the first attempt **and** any failover retry. That keeps it below the gateway's 610 s first-byte timeout. A failed attempt before the deadline can fail over; once the deadline passes, the router answers 502 `upstream-timeout`. |
| `ROUTER_STREAM_IDLE_TIMEOUT_MS` | 240000 | The longest silence allowed between upstream body chunks, set below API Gateway's 300 s private idle timeout. Exceeding it after the first byte is recorded as `mid-stream`. |
| `ROUTER_SSE_HEARTBEAT_MS` | 60000 | During upstream silence on an SSE response, write `: keepalive` comment frames at this interval, only between complete frames (`0` = off). They bridge the hop's 5-minute idle timeout; SDKs ignore SSE comments. |
| `ROUTER_STREAM_CAP_MS` | 900000 | The hop's maximum stream duration (API Gateway: 15 min). A client close near it is logged as `stream-duration-cap` (499), distinct from `client-abort`, with partial usage priced. |
| `ROUTER_STATE_TABLE` | unset = in memory | The DynamoDB table (in `ROUTER_REGION`) that holds the routing state; see "Routing state" below. Unset, the state lives in the process: run one task, and expect a restart to reset every conversation. |
| `ROUTER_SHUTDOWN_GRACE_MS` | 20000 | After SIGTERM, how long requests in flight may finish before the router ends them itself; see "Stopping" below. The default fits ECS's default 30 s stop timeout; the stack sets both. At most `ROUTER_STREAM_CAP_MS`. |
| `ROUTER_UPSTREAM_URL` | `https://bedrock-runtime.<region>.amazonaws.com` | `http` is accepted only on loopback (tests). |
| `ROUTER_FAULT_INJECT` | `none` | E2E only: `router-503`, `upstream-503-once[:<n>]` (503 instead of the process's n-th upstream attempt, default 1, once), or `pause-after-first-frame:<ms>` (stop relaying after the first frame, heartbeats continuing). Requires `ROUTER_FAULT_INJECT_ALLOW=1`, logs a startup warning, and stamps `fault` on every log line. |

## Behaviour notes

- **Routes.** `POST /v1/messages`, `/v1/chat/completions` and `/v1/responses` go to Bedrock `/anthropic/...` and `/openai/...`. `GET /healthz` needs no auth. `GET /v1/models` (the gateway's model discovery) is behind hop auth and lists the router aliases, in a shape both the OpenAI and the Anthropic SDK parse. Everything else, including Responses GET/DELETE, gets 404 (out of the MVP).
- **Decision headers.** `x-router-decision: <action>;<point>;<mode>`, `x-router-model` (the model actually served, which differs after a failover) and `x-router-reason` (the reason code).
- **Errors returned to the client (the gateway has no model fallback):**
  - core finds no eligible model: 503;
  - the upstream network fails: 502;
  - an upstream 5xx after one failover: passed through;
  - router bug: 500.
- **`chatIncludeUsage: inject-strip`.** The client stream matches a request without `include_usage`. The usage-only chunk is dropped, and the top-level `"usage":null` that Bedrock adds to every other chunk is removed.
- **Tier assessor.** Off by default. `ROUTER_ASSESSOR_MODE=observe|auto` turns it on; `ROUTER_ASSESSOR_MODEL` (default `global.openai.gpt-6-luna`, must be a policy model), `ROUTER_ASSESSOR_THRESHOLD` (0.8), `ROUTER_ASSESSOR_PACK` (`v2.5`), `ROUTER_ASSESSOR_TIMEOUT_MS` (5000; core's hard bound adds `ASSESSOR_GRACE_MS`, 100 ms) and `ROUTER_ASSESSOR_AUTO_RULES` (`pack`, or `all` for experiments) tune it. `ROUTER_ASSESSOR_HOLD_TIERS` (default `standard,frontier`; `none`, or `fast,standard,frontier` for the behaviour before 2026-11-17) sets which held opinions may stand in for a turn without one (core `assessorHoldTiers`); it is deploy-time only and every `log.assessor` carries `holdTiers`. `main.ts` builds it with `createRouterAssessor` on the data-plane signer and upstream; the router passes the card to `engine.decide` and logs each consultation as `log.assessor` (codes and numbers only). A config document may add up to 5 admin assessor rules (`assessor.customRules`), judged in the same call; with them the log also carries `rulesVersion`, `custom` (id → rule hash), `customMissing`, `shadowTier`, `lineageKind` and `prev` (design §4.5). Design: [docs/architecture/assessor-design.zh-CN.md](../../docs/architecture/assessor-design.zh-CN.md).
- **Assessor seam.** `RouterDeps.card = (summary, body, ctx) => buildCard(summary, body, ctx)` (from `@auto-router/assessor`) still works for a custom builder. The router calls `engine.decide(summary, { card: (ctx) => card(summary, body, ctx) })`, so core's CardContext (current model/tier, parent tier, compactions, lineage kind) reaches the card.
- **Concrete model ids are pins.** The gateway sends every model id to the router. A concrete Bedrock id in the body is served only if the policy and caller's tier limit permit it; otherwise the router rejects it. `x-router-hint: pin=<id>` also pins a policy model.
- **Models.** Concrete ids, whether a body `model` or an `x-router-hint` pin, must be in catalog ∩ (pool models ∪ failover profiles ∪ observe defaults). Anything else gets 400 `pin-not-allowed` before any upstream call, in observe mode too. To pin a model, add it to the policy. The infra task role grants exactly this set. Logs show `requested` as a known id or alias, else `other` plus `requestedLength`.
- **anthropic-beta.** The table is a deny list: a model is vetoed only for a beta it is known to reject, and unknown betas are allowed because Bedrock validates them. Observe mode never changes the served model; it only annotates `wouldChoose`. Auto mode moves a vetoed switch/initialize only to a same-or-higher tier model (the current model first), and keeps the decision when there is none.
- **Failover.** One retry on another profile of the same model, when the policy lists failover profiles (geographic profiles in Regions that have them) and the status is in `failover.profileRotateOn` (default `[429]`; a network error counts as 502). Global and geo profiles have separate quotas, so a throttle may clear on the other one; a 5xx on `global.`, which already routes across Regions, is very likely shared, so it is not retried there. A 5xx (or any failure with global-only profiles) is returned to the client, and core fails the session over to a same-tier sibling on the next call when the policy provides one. Each failed attempt is recorded to core first. There is no rotation inside a `previous_response_id` chain.
- **Auth edges.** A 403 sends `connection: close` and the socket is dropped after 250 ms. `Expect: 100-continue` is authenticated before `100 Continue` is sent.
- **Partial calls.** A mid-stream upstream failure is logged and recorded to core as 502 (`reason: mid-stream`), so failover sees it. A client abort is logged as 499 (`reason: client-abort`) and recorded with the upstream status. Both log, price and record the usage seen so far. Limits:
  - The output tokens of a stream cut before `message_delta` (Anthropic), or before the final usage chunk (OpenAI), are unknown and counted as 0, so the price is a lower bound.
  - After a mid-stream 502, core does no cache bookkeeping for that call, so its warmth estimate is pessimistic: cache written by the partial call is not credited.
- **Routing state.** Core keeps one small record per conversation lineage: the model it is on, cache-warmth records per model, counters, and the last assessor opinion. It holds model ids, prefix hashes, token counts, timestamps and the lineage and root ids (which contain the client's session id), never prompt text, a card or model output. With `ROUTER_STATE_TABLE` the record lives in DynamoDB (`state-store.ts`: signed JSON calls through the VPC gateway endpoint, no SDK), so every task sees it and it survives a restart or a deploy. Without the table, a request in the middle of a tool loop that reaches a fresh task reads as a new session: it gets the default tier and starts that model with a cold cache.
  - Items are keyed by a SHA-256 of the lineage or root id (the ids themselves are in the item's values). Lineage items expire 7 days after their last write and root items 30 days after their last new lineage (TTL attribute `exp`).
  - Each request costs about three reads and one write. Every call has a timeout (reads 500 ms, writes 1 s) and falls back to the task's own in-memory copy, so a DynamoDB outage degrades the router to single-task behaviour instead of failing requests. Fallbacks are logged as `kind: "state-store"` lines (codes only): the first one, then at most one per minute with the count.
  - Writes are last-writer-wins. The requests of one lineage are sequential (an agent loop), and a task orders its own writes per lineage. Each write carries a revision, so a task reading the table knows whether the item or its own copy is newer; only two tasks writing the same lineage within their clock difference can tie.
- **Stopping.** On SIGTERM the router stops accepting connections and lets requests in flight finish for `ROUTER_SHUTDOWN_GRACE_MS`; every answer whose headers are written from then on carries `connection: close`, so the hop does not reuse the connection. It then ends the rest itself, so each still writes its log line: a stream that was being relayed is logged as 503 `shutdown` with the usage seen so far priced and recorded (as for a client abort, so core does not treat it as a model failure), and a request that had no answer yet (its body still arriving, or the upstream still silent) gets 503 `router shutting down`, as does any request that arrives after that point. A `kind: "shutdown"` line reports how many requests were in flight and how many were cut, and the process exits once stdout has taken it (at most 9 s after the grace). Without this, the SIGKILL at the end of the task's stop timeout would end those requests with no log line and no usage.
- **Hop session token.** API Gateway would pass the gateway role's session token through as `x-amz-security-token`, so the hop's integration mapping overwrites it with `'redacted'`. Each log line records `hopToken`: `absent`, `redacted` or `other`, never the value. `other` (the mapping is missing) also emits the EMF metric `Alerts` with `AlertReason=hop-token-unexpected`.
- **Logs.** One JSON line per request plus one EMF document (namespace `LlmAutoRouter`). Dimension sets: `{Dialect, ServedModel}` (ServedModel is a policy model id or `other`; the raw id is the truncated property `ServedModelId`), `{Mode}`, `{StatusClass}`, `{StatusClass, Reason}` (reason code only, else `other`), and `{MissReason}` on misses. The raw status is a property. Handler crashes still write a request log and EMF (status 500, Reason `internal`). Sessions appear only as 16-hex labels, sha256 truncated: `lineage` (the core lineage) and `session` (its root: `x-router-parent-session`, else the session id, else the fingerprint id). The session id is Codex's own `session_id` from its turn metadata, else the session header. A client can join its own runs by computing sha256 of the `x-router-session` value it sent: that is `session`, or `clientSession` when the session id came from elsewhere (a Codex request with ids). Neither label is an EMF dimension. Bodies, raw session ids and header values are never logged, except `anthropic-version`, `anthropic-beta`, `openai-beta` and `content-type`. A non-2xx upstream answer adds `upstreamError`, its error code only (never the message): from `x-amzn-errortype` without its namespace, else the JSON body's `error.code` or `error.type`, `other` when the value is not a code, absent for an SSE or non-JSON body. After a failover it is the relayed attempt's (`failover.status` keeps the first). It is an EMF property, not a dimension, and usage-ingest keeps it on the request record. Two request markers come from Codex's turn metadata (the JSON string in the body's `client_metadata["x-codex-turn-metadata"]`, of which core reads `agent_name`, `request_kind`, `thread_source`, `session_id` and `thread_id` only; a `thread_id` other than the `session_id` is a spawned sub-agent, on lineage `<session id>/th:<thread id>`): `compactionRequest: true` for Codex's own compaction call (`request_kind: compaction`), and `sideCall: "thread-title"` for the TUI's one-off thread-title request (`thread_source: thread_title`), which core serves on the fast tier without consulting the assessor (decision point `session-start`, reason code `thread-title`). Core gives that request a session of its own, so its `session` and `lineage` labels are not the main session's: `session` is sha256 of `<session id>/side:thread-title`, where the session id is the title request's own Codex `session_id` (or what stands in for it). The metadata itself is never logged.

## Adding same-tier siblings (optional)

The shipped `config/policy.default.json` has one model per tier, so a model failure is returned to the client when no profile retry applies. There is no gateway model fallback. That keeps quality, cache warmth and the IAM allowlist predictable. You can give core a cross-model failover target by adding a second model to a tier. core then moves a failing session to that sibling on its next call (`point: failover`), instead of retaining with `failover: exhausted`:

```jsonc
// pools.anthropic-messages.models
{ "model": "global.anthropic.claude-sonnet-5-5" },
{ "model": "global.anthropic.claude-sonnet-5", "tier": "standard" }   // sibling: same tier, different model
```

- **Quality and cache.** The sibling is a different model, and its first call starts with a cold prompt cache.
- **IAM.** The infra task role grants exactly the policy's models, so a sibling adds its inference profile and foundation-model ARNs to the role at the next deploy. The router refuses (`pin-not-allowed`) any model outside the policy.
- **Region.** The sibling must exist in the Region's catalog. Synth and router boot both check this.

## Limits on the deployed path

| Limit | Value | Behaviour |
|---|---|---|
| Request size | 10 MiB | API Gateway returns 413. The router also rejects above 10 MiB. |
| Stream duration | 15 min per response | API Gateway closes the stream cleanly, with no error or final event. The router logs `stream-duration-cap`. Long agent turns should stream, which they normally do, and stay under 15 min. |
| Idle stream | 5 min (API Gateway) | Bridged by the router's SSE heartbeat (60 s). An upstream that stays silent 240 s is treated as dead (`idle-timeout`, logged `mid-stream`). |
| Gateway failure handling | Fail closed; no direct model target | Router errors, connection failures and timeouts fail the request. The router's own profile retry handles statuses in `failover.profileRotateOn` (default 429 only) where the policy lists failover profiles. |
