# Admin console guide

[简体中文](README.zh-CN.md)

The admin console is a web app for one router deployment. Members use it to connect their tools and to see their
own usage. Admins also manage members, service clients, the routing policy and the assessor. It is an optional
stack: deploy it after the router stack ([infra/README.md](../../infra/README.md#admin-console-console-stack)).
What an admin should do and when (setup, weekly checks, rules, reviews) is in the
[admin operations guide](admin-guide.zh-CN.md) (Chinese).

The console works in English and Simplified Chinese. Switch with the language menu at the top; the choice is kept in
this browser.

## Signing in

- There is no self sign-up. An admin invites you, and Cognito sends an e-mail with a temporary password.
- The first admin is created when the console stack is deployed, with `-c adminEmail=<e-mail>`
  ([infra/README.md](../../infra/README.md#console-inputs)). If no admin is left, deploy again with it.
- At first sign-in you replace the temporary password with your own.
- MFA is off by default. For production, whoever deploys the stack should require it (see [Production hardening](#production-hardening)).
- The console signs you out after 8 hours. "Sign out everywhere" (Settings) signs you out of every browser and
  revokes the `llmar` CLI's sign-in. The CLI notices at its next refresh, within the 60-minute token lifetime, and
  the gateway accepts tokens already issued until they expire.

## What everyone sees

Members see only their own requests. Admins see everyone's, and can filter by caller.

![Decisions page, admin view (callers masked)](img/decisions.en.png)

*The Decisions page after the end-to-end test, admin view. Callers are masked; sessions show their short label.*

| Page | What it shows |
|---|---|
| Overview | This month's list-price cost, requests, tokens and cache hit rate; your budget, if you have one; recent sessions. |
| Usage & cost | Token usage per model by class (uncached input, cache read, cache write per TTL, output) and its list price, per UTC day. Group by model, tier or API; export CSV. |
| Savings | What routing changed in list-price cost against a baseline (see below). |
| Decisions | Each routing decision: requested model, action, decision point, served model, tokens, cost, cache hit rate, assessor opinion and its basis. Open a session to see its timeline. |
| Get started | Setup for `llmar`, Claude Code, Codex, the SDKs and curl, filled in with this deployment's values, for macOS / Linux / WSL or Windows (PowerShell), and a "Check my setup" button. |
| Settings | Language, time display (local or UTC), password, sign out everywhere. |

### Reading the numbers

- **List price, not your invoice.** Costs use the Region's versioned price catalog (its version is in the page
  footer). Discounts, credits and taxes are not included.
- **What is counted.** Every request that reached the router. Requests rejected before reaching it are not counted.
  If the router is unavailable, the gateway fails the request rather than invoking models directly.
- **Unmetered calls.** If a stream ended before usage arrived, the call has no measured cost. The console shows the
  count and an approximate upper bound apart from the metered cost, and leaves these calls out of savings. The
  bound uses a prompt estimate of 4 characters per token, so it can be too low for Chinese, Japanese or Korean
  text. "Partial (input only)" means some calls set no output cap.
- **Days are UTC.** Request records are kept 90 days by default (deploy setting `recordRetentionDays`; a change
  applies to new records). Daily totals are kept 400 days.
- **No content.** Prompt and output text are never stored. Records hold ids, codes, token counts and costs.

### Savings

The page compares actual cost `A` with a baseline `B`: the same requests priced on one fixed model that never
switches. The default baseline is always `frontier`: what the same token counts would cost on the pool's frontier
model. An admin can change the default on Settings → Deployment, and anyone can pick another baseline on the page:
the tier each request asked for (`auto` → the pool's default tier), always `standard`, or the observe default.

The frontier figure is a price comparison, not a quality-equal one: on our coding-agent benchmarks frontier solved no
more tasks than standard (Claude Code: Opus 5.5 about 2.5 times Sonnet 5.5's cost; Codex: GPT-6 Astra about 5–6 times
Sol). If an API's pool has no frontier model, the page says so and names the model that baseline falls back to;
requests a baseline cannot price are counted and left out.

- Net saving `N = B − A − X` = routing effect `R` − switch penalty `S` − assessor overhead `X`. It can be negative.
- `R = B − A*` is the price difference with cold-cache effects removed (`A*` is the warm-equivalent cost). `S = A −
  A*` is the extra cache writing when routing moved a warm session to another model.
- Requests served at a lower tier because of a tier limit are shown on their own row; a forced downgrade is not a
  routing saving.
- In observe mode, "Projected if auto" estimates what auto mode would have cost. It is indicative, not measured.
- Prompt-cache saving is a separate figure. It comes from caching, not from routing.

Three limits apply to every savings figure. It uses list prices. It assumes the same token usage on the baseline
model, while a different model may use more or fewer tokens and turns. It does not measure quality: a cheaper model
may solve fewer tasks. On our coding-agent benchmarks the fast tier solved 14–17 points fewer tasks than standard,
and auto with the assessor cost 2.6–4.1 times fixed standard with no quality gain detected
([summary, Chinese](../experiments/harbor-summary.zh-CN.md)).

## Admin pages

### Members

- **Invite** with e-mail, name, role (member or admin), and an optional monthly budget and tier limit. Invites use
  Cognito's default e-mail sender, which has a low daily quota. For larger teams, ask whoever deploys the stack to
  configure Amazon SES on the user pool.
- **Promote to admin:** the person must sign in again before the admin rights apply.
- **Disable:** the router stops serving the member within about 35 seconds in `require` mode. In `observe` mode,
  only requests that carry the member's identity are blocked; requests without it keep working until the access
  token expires (at most 60 minutes). Disabling also revokes the member's sign-in, so after Enable they run
  `llmar login` again.
- **Sign out everywhere** revokes refresh tokens. Access tokens already issued still pass the gateway until they
  expire, unless you also disable the member.
- **Delete** is possible only for disabled members. Their records stay, shown as "Deleted member".
- Changes reach the router through a published caller list and block list. The row shows "Applying…" until the
  router reports the new version, and "Not delivered" with a Republish button if publishing failed.

### Service clients

Machine callers for CI and agents, on the client-credentials flow. The secret is shown once when you create or
rotate it; store it in Secrets Manager. Budgets and tier limits work as for members. See the README section
[Service clients](../../README.md#service-clients-ci-and-agents).

### Budgets and tier limits

- A **budget** is a monthly list-price amount per caller, with an alert threshold and an optional hard stop. Spend
  is actual cost plus assessor cost for the current UTC month. With the hard stop on, the router answers 429
  `budget-exceeded` within a few minutes after the budget is used up (usage is counted from the router logs, which
  arrive in batches). Requests in that window still go through, so spend can pass the budget a little. A raised
  budget or a new month lifts the block within minutes of the caller's next request.
- A **tier limit** caps the highest tier a group (admin, member) or one caller may use, with an optional list of
  allowed pins. A request above the limit is served at the highest allowed tier; a pin above it gets 400
  `access-cap`; a context too long for every allowed model gets 400 `access-cap-context`.
- **Which calls they bind.** In `observe` mode, budgets and tier limits apply to every call that carries a valid
  `x-api-key`; a call without one is served unattributed and escapes them. They bind everyone only in `require`.

### Routing policy

Which model serves a request, when, and at what price. The form, top to bottom:

- **Routing mode.** *Observe only*: models never change; every request uses the observe model (normally the Normal
  row's) and the rest of the page only records what auto would do. *Auto*: the difficulty rows and the rules pick the
  model. **Let an AI judge each task's difficulty** (Auto only): a small model reads each session's task and moves it
  to Easy or Hard; it adds 1–3 s at session start and costs about $0.0007 a session. One activation sets the three
  underlying settings (policy mode, assessor mode, assessor auto rules). Other combinations show as *Custom* with one
  sentence saying what they do; the raw switches, including turning the assessor off, are under Advanced.
- **What happens now.** Sentences the console writes from the draft (not an AI): the model each client type starts
  on, each rule, the assessor's effect, names with a fixed difficulty (`auto:fast`, …), and when a session's model can
  change (session or sub-agent start, after compaction, after a long pause; at a new user message only when *New user
  turn* is cost-gated). In observe it says which model every request uses.
- **Models by task difficulty.** For each client type (Claude Code etc. on Anthropic Messages, Codex etc. on OpenAI
  Responses, OpenAI Chat Completions): one model each for Hard, Normal and Easy (tier codes frontier, standard, fast),
  with list prices, a *Default* marker, and *Not used* for Hard or Easy. Changing the default row also moves the
  observe model, unless Advanced sets a different one. *Other entry points of the same model* is for inference profiles
  of that model in other regions; another model there is refused. A pool written by hand with two models in one
  difficulty shows as "a layout the form cannot show" and is edited in the JSON tab.
- **Rules.** Each rule is a sentence, e.g. "Sub-agents → Easy (Claude: Sonnet 5.5 · OpenAI: GPT-6 Luna)". The first
  match wins; reorder, edit (session type, prompt size, requested model name, agent id, the client-declared
  permission mode (`plan`, `auto`) and reasoning effort (`low` … `max`); template fingerprint under *Show advanced
  conditions*) or delete. Rules apply to requests for `auto`, not to `auto:fast` or a named model.
  *Describe a rule in one sentence* sends the sentence to the deployment's rules model (deploy parameter
  `rulesModel`, default `global.openai.gpt-6.1-sol`; `none` turns it off) and shows the rules it produced, written by
  the console, plus the parts it could not express and why, the model and the cost. A part that depends on what the
  task is (for example "animation or visual design work") becomes a proposed admin assessor rule (see Assessor),
  added in the recording-only state. *Add to draft* puts them in the draft; nothing runs at request time and nothing
  is active until you activate.
- **Suggested fast rules (from traffic).** Template families (requests with the same tools and system prompt) whose
  assessor facts look simple on many turns (Wilson lower bound ≥ 0.95 by default) are listed as candidates, with
  samples and health. *Add rule* puts a `templateFamily → fast` rule in the editor; it takes effect only after save,
  validate and activate. The admin guide (Chinese) describes the review steps:
  [admin-guide.zh-CN.md](admin-guide.zh-CN.md#33-建议的-fast-规则来自流量).
- **Tier limits** and **Advanced** (mode switches, observe model per API, aliases, rules as JSON, the numeric
  settings).

Then:

- **Validate** runs the router's own checks against the price catalog and the allowed model list.
- **Activate** needs a comment. It shows *What happens* before → after as sentences, the effect on running sessions,
  and the diff; sessions keep their model until their next cache break point. The router picks the new version up
  within about a minute, and the header shows when it is active (or why the router rejected it; it then keeps the
  previous version).
- **Versions** lists every change with author, time and comment. Roll back creates a new version with the old
  content.
- Adding a model outside the allowed model list needs a CDK deploy.

### Assessor

Pack, model, threshold and timeout; whether the assessor is on is set on the Routing policy page (this page shows the
state). The page lists each pack's rules, so a decision's basis can be read. Saving creates a new config version.
Keep it recording only until the offline evaluation passes: on our benchmarks the assessor did not pick the tasks that
need frontier, and never chose fast.

**Admin rules.** Up to 5 natural-language rules of your own (`x-` id, tier, one English line saying when it matches,
state *Observe (record only)* or *On*), judged in the same assessor call as the pack's rules, e.g. "animation, video or
visual UI design → frontier". A new rule records only: the evidence table shows how often it was judged and matched
(with a 95% interval), what turning it on would change, the tiers served on matches, health and sample decisions.
*Turn on* when the evidence looks right, then validate and activate. Act rules change tiers only while the assessor and
the routing mode are automatic; they never raise a sub-agent's tier. A matched frontier or standard rule that is on
holds even when the assessor's confidence is below the threshold (pack rules do not count there); a fast match against
it is still a conflict. Editing a rule's text or tier restarts its
evidence. Each rule adds about 100–150 cacheable prompt tokens and 30–50 output tokens per consultation. See the
[admin guide §4.3](admin-guide.zh-CN.md#43-管理员规则按任务内容判断).

One rule is preset: `x-visual-creative` (animation, video or visually designed UI work → frontier), in observe state.
A new deployment's built-in config carries it when the assessor is on, and turning the assessor on in the console adds
it unless the off settings already had their own rule list. An existing document gets it only when you add it (*Add
preset rules*) or activate a version that has it; a document without `customRules` has no admin rules.

### Gateway

A read-only view of the gateway: URL, authorizer, targets, routing rules, fallback chain and forwarded headers. The
current stack has only a router target and no fallback chain; legacy chains are displayed as read. All of it changes
only with a CDK deploy.

### Health

Router tasks, request rate, 4xx and 5xx rates, failovers, router overhead, upstream first byte, cache hit rate,
assessor latency, active config version and record delay. "Router availability signals" shows router 5xx, unhealthy
router targets, and fewer running tasks than desired. Router unavailability fails requests; it does not trigger direct
model calls.

### Audit log

Every admin action (members, service clients, config, settings) and every config rejection by the router, with
actor, time, before and after. It cannot be edited.

### Settings: deployment

- **Identity mode.** Roll out in this order: `observe` while members set up their tools, check that the
  "unattributed" share on the Overview is near zero (if it is not, filter Decisions to the unattributed caller: the
  usual cause is a Claude Code session with `ANTHROPIC_API_KEY` set next to `apiKeyHelper`), then `require`. The console refuses `require` until the router
  reports that its signing keys are loaded, because without them every call would get 401.
- Default budget and alert threshold, hard stop, default savings baseline.
- Read-only: record retention, price catalog and Region, allowed models, `llmar` sign-in lifetime (30 days). These change with a
  CDK deploy.

## Production hardening

The user pool ships with MFA off. For production, require TOTP MFA (an authenticator app) on the user pool. It is a
stack setting, not a console setting: see [infra/README.md](../../infra/README.md#production-hardening-mfa). After
the change, everyone sets up an authenticator app at their next sign-in, in the console and in `llmar login`.

## Removing the console

Destroying the console stack deletes its data: config versions, the audit log, member profiles (budgets, tier
limits), request records and daily totals. If you need any of it, export the tables first, for example with a
DynamoDB export to S3 or a scan ([infra/README.md](../../infra/README.md#console-teardown)). The router keeps
running on its last config.

## Troubleshooting

| Symptom | Cause |
|---|---|
| 401 | No token or an expired one. In `require` mode also a missing (`identity-missing`) or invalid `x-api-key`. |
| 403 `identity-blocked` | The account is disabled or blocked. A 403 without that code means the wrong scope. |
| 429 `budget-exceeded` | The monthly budget is used up and the hard stop is on. |
| 400 `access-cap` / `access-cap-context` | Above the tier limit, or no allowed model fits the context. |
| 400 `pin-not-allowed` | The pinned or named model is not in the routing policy. |
| `llmar-token` says "run llmar login" (exit 2) | The sign-in expired or was revoked, the settings changed since sign-in, or the account is disabled. |
| Codex: "auth command exited with status 2" | Run `llmar-token` in a terminal to see why. |
| "Check my setup" finds nothing | The tool does not send `x-api-key`. See Get started, step 4. |
