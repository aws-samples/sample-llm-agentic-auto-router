# Eval v2.4: counterfactual labels, human calibration and a utility metric (plan, written 2026-11-17)

Written before the pilot judge run. Everything under `results/` is local only (gitignored): it holds the transcript
owner's text and model answers derived from it. No document quotes it.

## 0. Final status (2026-11-17, closed)

- **Closed after the pilot.** The rest-of-dev stage is cancelled: §11 look 1 gave branch U, and pass 2 (§11.2) showed
  that the judge does not predict which turns the user accepts (κ 0.14). Look 2 and further pass-2 generation were not
  approved (user decision).
- **Spend** (ledgers in `results/`): smoke $3.12 (including the $0.80 deviation, §12), pilot $74.52; **total $77.64**
  of the $280 ceiling. All label data come from ap-northeast-1 / the v2.3 judging account.
- **Gold for D: hindsight (agreed v2.3 labels)**, with two caveats: (1) the user's pass-1 labels are a prior
  preference, not sufficiency (fast 2%); (2) shown the outputs, the user accepts the fast next step on 76% [59, 87] of
  turns, far more often than hindsight (~30%) or the cf judge (55%), so a model fitted on hindsight under-routes fast
  relative to what the user accepts. The cf labels (`cf-opus`, 255 pilot turns) are a sensitivity label only.
- **Next labelling investment**: human pass-2-style judgements of actual outputs (fast vs standard, shown side by
  side; ≈ $1.1 per turn for the two generations when uncached, ≈ $0.16 when whole sessions run cached as in the
  pilot), not more
  LLM-judged one-step labels. They measure what the user applies when shown outputs, and they are what a judge would
  have to be calibrated (and held-out tested) against.
- Turn-level caveat for all of it: the counterfactual and pass-2 judgements are about the next step, not the turn.

## 0a. What this round can and cannot claim

- Labels are made for the **dev split only** (assessor-v23 `splitOf`, 801 turns). They support fitting and
  session-grouped cross-validation (peer D's tier mapping) and the comparison of label sources. They do **not**
  support a confirmatory claim about any pack: dev was used for every v2.3 choice.
- Confirmation needs a **fresh held-out set**: sessions started after 2026-11-17, exported and labelled the same way
  later, under a budget the user approves then. The v2.3 test split stays untouched this round (it was used once,
  under hindsight labels; with new labels it could at most give a caveated second look).

## 1. Data

- **Turns**: the assessor-v23 export (`sessions.py`, `results/sessions/turns.jsonl` in the main tree), dev split.
- **Requests** (`rebuild.py`): Claude Code (2.1.3xx) records each model request in the transcript deduplicated:
  `api-request-shape` (system blocks, full tool schemas), `api-request` (params; entries = previous request's
  `entries[:keep]` + `tail`, tail items are sha256 of sort-keyed compact message JSON), `api-request-blob` (messages
  that are not transcript records). A hash resolves to a blob, a transcript record (string content as one text block),
  an assistant message merged over its records, or a run of consecutive user records merged into one message.
  The main chain is every `repl_main_thread*` / `sdk` source (root) or `agent:*` source (sub-agent).
- **A turn's request** = the first main-chain request, after the previous turn's, and before the record of the turn
  after next, whose entries after the last assistant entry contain the turn's text (whole request for a new chain,
  `keep` 0). Claude Code can write that record before the user record; a message typed while the agent works arrives
  inside a tool-result entry (flag `carrier: tool-result`, 29 dev turns: in the router these are inside a tool loop),
  a notification inside a `system`-role entry.
- **Entries map 1:1 to API messages**, a `system`-role entry (Claude Code attachments) sent as a user-role message
  with its content unchanged (Claude Code's last cache breakpoint is always on the last entry; Bedrock accepted the
  consecutive user messages in the smoke).
- **Coverage (dev)**: 768 / 801 turns rebuilt exactly (every hash resolves, the turn text matches). Excluded: 24 with
  no matching request record, 9 with an unresolvable entry (all root turns; the 33 compaction turns are included).
  All 104 sub-agent turns rebuild.
- **Original first step**: the first assistant message after the turn's request (verified for 616 turns as the next
  request's following entry). Its model: Opus 5.5 563, Fable 5.2 82, Sonnet 5.5 15, Opus 5 2, synthetic 1.

## 2. Counterfactual next steps (`cf.ts`)

- Pool of the router's policy (`packages/router/config/policy.default.json`, anthropic-messages; the live us-west-2
  configs 1 and 2 differ from it only in the assessor pack): fast = `global.anthropic.claude-haiku-5-5`, standard =
  `global.anthropic.claude-sonnet-5-5`, frontier = `global.anthropic.claude-opus-5-5`.
- The exact rebuilt request, model swapped as the router would: `anthropic-beta` = the request's betas minus the
  router's Bedrock strip list (`bedrock-compat.ts`); thinking and `output_config` (effort) as the client sent them;
  `max_tokens` = min(client, 32,000). After a 400 naming one of them, one edit at a time (drop that beta, drop
  `output_config`, strip earlier thinking blocks, drop thinking), recorded in `paramEdits`. Smoke: no edit needed.
- **One step** (one response), no tool execution. Cache breakpoints: last system block, the previous turn's last
  entry (read), the request's last entry (write); sessions in parallel, turns in transcript order.
- Region **ap-northeast-1**, the account of the v2.3 judging (`LLMAR_SPIKE_ACCOUNT` of the main tree's
  `scripts/local.env`, checked against the caller before any call; an environment value that differs is refused).

## 3. Judge (`judge-cf.ts`)

- Input: the end of the conversation before the request (≤ 24,000 characters: text clipped at 2,500, tool calls at
  500, tool results at 700, harness context shown as its size only), then v2.3's `judgeUser` (first message, end of the
  previous reply, the request, and the hindsight digest of what the original agent did over the whole turn), as the
  system prompt (cached across the calls of a turn); the two candidates in the user message: reply text (≤ 6,000) and
  proposed tool calls (input ≤ 1,500 each); thinking is dropped for every candidate.
- Output: reason, better (A / B / equal), a_sufficient, b_sufficient, confidence.
- **Q1** fast vs standard, both orders. **Q2** standard vs the original step, both orders, only for turns that Q1 does
  not establish as fast and whose original model is frontier-tier.
- Judges: **Opus 5.5 primary** on every turn; **GPT Astra** (effort low) on a deterministic 20% of the pilot turns
  (FNV-1a of the turn id mod 100 < 20), the self-preference audit: the candidates and the original are Claude models
  and the original is Opus itself. The rest-of-dev stage has no Astra calls.

## 4. Labels (`label.py`)

Primary rule (`cf-opus`):

1. **fast** iff in BOTH Q1 orders the fast step is equal or better AND sufficient (`cf-fast`).
2. Else, original not frontier-tier → **standard** (`cf-standard-noq2`).
3. Else **frontier** iff the original is better in BOTH Q2 orders (`cf-frontier`).
4. Else **standard**: equal or standard better in both orders (`cf-standard`), or split Q2 verdicts
   (`cf-tie-frontier`; frontier needs consistent evidence, as in v2.3's narrow frontier rule).
5. `cf-tie-fast`: exactly one Q1 order established fast; the label is decided by Q2 like any non-fast turn.
6. A missing verdict in a needed order → no label (`judge-missing`).

Sensitivity: `cf-opus-suff` (Q1 fast iff the fast step is sufficient in both orders, whatever `better` says), the
Astra labels, the v2.3 hindsight labels (agree / each judge / lower / higher), the human labels.

### Label file schema (stable; peer D reads it)

`results/labels/cf-<judge>[-suff].jsonl`, one line per judged turn:

| field | type | meaning |
|---|---|---|
| `id` | string | turn id of `turns.jsonl` |
| `session`, `split`, `kind`, `lineage`, `carrier` | string | as in `results/requests/index.jsonl` |
| `tier` | `fast` \| `standard` \| `frontier` \| null | the label (null: `judge-missing`) |
| `basis` | string | `cf-fast`, `cf-standard`, `cf-standard-noq2`, `cf-tie-fast`, `cf-tie-frontier`, `cf-frontier`, `judge-missing` |
| `q1` | {ab, ba} | each order's verdict from the fast side: `fast` / `standard` / `equal` |
| `q1FastOk` | [bool, bool] | whether each order established fast |
| `q2` | {ab, ba} \| null | `standard` / `original` / `equal`; null when not judged |
| `originalModel`, `fastModel`, `standardModel` | string | models of the three steps |
| `fastTruncated`, `standardTruncated` | bool | the step hit `max_tokens` |
| `judge`, `cfVersion` | string | `opus` / `astra`; `cf/v1` |
| `costUsd` | number | generation + judge cost of the turn |

`results/human/labels.jsonl`: `{id, pass: 1, tier, confidence 1–3, note?, ts}` (pass 1; a later line for the same id
replaces an earlier one; `tier: "skip"` withdraws it), `{id, pass: 2, aIsFast, verdict: A|B|equal, worseAcceptable, ts}`.

## 5. Human calibration (`human.py`, terminal only, no sockets)

- 100 dev turns among the rebuilt ones, drawn **before** any counterfactual label existed (seed 20261117): strata =
  turn kind (human / notification / sub-agent / other) × v2.3 hindsight label (fast / standard / frontier / split),
  a floor of 3 per stratum, the rest proportional; `weight` = stratum size / sampled count.
- Pass 1: the user sees the conversation tail, the request and what the agent did (what the hindsight judges saw) and
  gives the tier the work needed, with a confidence. Pass 2 (optional): fast and standard steps in a shuffled A/B order.
- `agree.py`: exact agreement (Wilson), Cohen's κ and linear-weighted κ (session-cluster bootstrap 2,000), confusion
  matrices: human vs each hindsight judge, agreed hindsight, cf-opus, cf-astra; cf-opus vs hindsight and vs Astra;
  by kind. Weighted (by `weight`) and unweighted agreement are both reported for the human pairs.

## 6. Metric for pack selection (`score24.py`; primary from now on)

Per turn, served tier from v2.3 `score.py` `serve()` (unchanged; its flags pass through):

    u = −w_c·price(served) − w_us·[served below label] − w_wf·[served fast ∧ label ≠ fast]

price = score.py PRICE (fast 0.05, standard 1, frontier 2: Haiku/Sonnet/Opus 5.5 list ratio). A wrongly fast turn pays
both error terms. **utility** = mean u over turns.

**Weights**: w_c = 1, w_us = 1, w_wf = 7. Rationale:

1. Harbor (`docs/experiments/harbor-summary.zh-CN.md`): fixed Luna (fast) lost 14–17 pp resolve rate for 0.10–0.18×
   the cost and was rejected; the hindsight per-task oracle (−2.4 to −6.1 pp at 0.47–0.55×) was judged worth having.
   That brackets one failure at roughly 6–22 standard-run units.
2. A wrong fast turn costs 8 in total, so serving fast pays off at fast precision ≥ 8 / 8.95 = 0.89, the 0.9 bar
   v2.3 chose for `fastMinConfidence`.
3. Under-serving standard → frontier costs one redo (w_us = 1): Harbor detected no frontier gain (C − A −0.2 / +2.8 pp).

**Decision rule**: a candidate replaces the base iff the paired session-cluster bootstrap 95% CI (2,000, seed
20261117) of utility(cand) − utility(base) lies above 0 AND the CI of the wrongFast difference does not lie above 0.
Secondary: exact, under, over, cost, fast precision. Sensitivity grid w_wf ∈ {3, 7, 20} × w_us ∈ {0.5, 1, 2} is
reported, never decided on. Primary gold: `cf-opus`. On dev this ranks candidates for D's CV; a release decision
needs the fresh held-out set (§0).

## 7. Power (offline, from the v2.3 test runs)

- v2.2 → v2.3 exact: discordance 21%, session design effect 2.6, test n 524 (33 root sessions). For 80% power at
  α = 0.05, a 3 pp exact change needs n ≈ 1,100 / 2,250 / 4,500 when the packs disagree on 5% / 10% / 20% of turns.
  MDE on dev-sized sets (n ≈ 770): 3.6 / 5.0 / 7.1 pp. A 3 pp exact change is therefore not detectable this round
  except for one-directional, low-discordance changes.
- Utility (these weights) on the same runs: Δ +0.77 [+0.31, +1.21] where exact was +2.9 pp [−4.1, +8.5]; per-turn
  SD 2.4, design effect 4.8. The utility metric is the one with power for the changes packs actually make.

## 8. Budget, stages, gates

Round budget (C + D) $300; C ≤ $280, separate ledgers, `V24_CAP_USD` = the approved stage cap (a run refuses
without it or with `--cap-usd` above it):

| stage | content | cap | ledger |
|---|---|---|---|
| smoke | 9 turns, generation + Opus judge + Astra on 3 | $5 | `ledger-v24-smoke.json` |
| pilot | 23 root sessions (incl. smoke) + 44 sub-agent turns = 255 turns; Astra on 20% | $100 | `ledger-v24-pilot.json` |
| rest | 12 root sessions + 60 sub-agent turns = 513 turns; Opus only | ≤ $175 | `ledger-v24-rest.json` |

Stages are whole sessions in FNV-1a order (`stages.py`). Pilot gate before the rest: rebuild verified (done), Q1/Q2
order consistency ≥ 85%, Opus–Astra agreement and the fast-rate difference (self-preference) reported, cost re-estimated.
If the rest's estimate exceeds its cap, the turn count that fits is reported and the main session decides.

## 9. Limits

- **One step, not a trajectory.** A trivially right first tool call can hide a later failure; the judge sees the
  original agent's whole turn as evidence, the candidates do not. One-step labels likely lean fast on long turns:
  labels are reported by turn length (hindsight tool calls).
- Tool calls are judged as proposed actions, never executed. Each step is sampled once.
- The frontier counterfactual is the recorded original step (sampled under the original model and params), not a
  fresh Opus sample.
- LLM judges: Opus judges its own family's outputs (the Astra audit and the human set measure the bias).
- `system`-role entries are sent with their stored content as user messages; Claude Code's exact rendering of these
  attachments may differ (wrapping), the content is the same.
- One user's sessions, Claude Code only.

## 10. Pilot result (2026-11-17, 255 dev turns; reported as found)

- Mechanics: 510/510 steps, no truncation, 83% of prompt tokens read from cache. Measured output tokens per step:
  fast mean 818, standard 525. Cost: generation $39.5, Opus judge $23.5 (710 calls), Astra $11.5 (44 turns).
- Order consistency: Opus Q1 83.5% (212/254), **below the 85% gate**; Q2 87.0%. Astra Q1 86.4%, Q2 13/13. The
  inconsistencies are "equal" against "one side better" (no order flips fast ↔ standard).
- cf-opus labels: fast 60%, standard 28%, frontier 11%. "Fast sufficient" variant: fast 87%.
- Self-preference (44 turns judged by both): fast rate Opus 0.64 [0.49, 0.76] vs Astra 0.70 [0.56, 0.82], difference
  −0.07 [−0.21, +0.06]; not detected. Opus–Astra agreement 70%, κ 0.40 [0.08, 0.66].
- **The main finding: the counterfactual labels do not agree with the hindsight labels.** cf-opus vs hindsight
  (agreed): agreement 34%, κ −0.04 [−0.14, +0.10] (n 231); the same against each hindsight judge alone, and for the
  Astra cf labels (κ 0.02). The disagreement has a structure in both directions:
  - multi-step turns: one step mostly measures "the same first move" (the first tool of the fast and the standard
    step is the same in 188 of 219 turns, mostly an exploratory Bash or Read); cf calls 73% of the turns with 41+
    original tool calls fast, and 91% of the sub-agent turns, where hindsight says mostly standard or frontier;
  - short turns (the original agent made ≤ 2 tool calls, n 63): hindsight 87% fast, cf 52% fast; here the judge
    compares two real answers, which hindsight never saw.
- Consequence: the rest-of-dev stage is held (no further paid calls) until the human labels decide between the
  constructs by the rule of §11.

## 11. Decision rule for the human comparison (registered in commit 494812e at 2026-11-17T13:52Z, before any human label existed)

Sources: **H** = human pass 1 (`human.py`), **S** = hindsight (agreed v2.3 label; split turns are excluded from the
paired comparison), **C** = cf-opus (primary rule). Statistic: linear-weighted Cohen's κ, wκ(H, S) and wκ(H, C), on the
**same** turns (H ∩ S ∩ C), Δ = wκ(H, S) − wκ(H, C), paired session-cluster bootstrap (2,000, seed 20261117).
Strata: **short** = the original agent made ≤ 2 tool calls in the turn, **long** = more; and turn kind (descriptive).

Looks. At most two: (1) the 38 sample turns that already have cf labels (pilot sessions); (2) if the main session
approves cf for the other 62 sample turns (est. ≈ $55; the sessions are not cached, a separate cap), all of them. A
branch is decided at look 1 only with 99% CIs; otherwise at the final look with 95% CIs. Only one final decision.

Branches (first that applies):

1. **Floor**: if both wκ(H, S) and wκ(H, C) have a CI upper bound below 0.2 → **N** (neither construct tracks the user).
2. **S wins**: Δ CI above 0, and wκ(H, S) CI lower bound > 0.
3. **C wins**: Δ CI below 0, and wκ(H, C) CI lower bound > 0.
4. **Mixed**: no overall separation, but Δ_short CI below 0 (C better on short turns) and Δ_long CI above 0 (S better
   on long turns), both strata with ≥ 15 turns → **M**. The reverse pattern (S short, C long) → **M′**.
5. Otherwise → **U** (undecided: not separable at this n).

Consequences:

| branch | gold for D's fit (dev, session-grouped CV) | rest-of-dev stage | score24 primary gold |
|---|---|---|---|
| S | hindsight (agreed), human as validation | cancelled (≈ $129 saved) | `agree` |
| C | cf-opus, human as validation | run as planned (cap $175, Opus only), after main-session approval | `cf-opus` |
| M | composite: cf-opus on short turns, hindsight on long | cf only for the short turns of the rest sessions (re-estimated first) | composite |
| M′ | composite: hindsight on short, cf on long | as M, for long turns | composite |
| N | human labels only (100), hindsight as a noisy auxiliary in sensitivity | cancelled | `human` (n 100: descriptive) |
| U | hindsight (the existing gold), human as validation; cf as a sensitivity label | cancelled unless look 2 is approved | `agree` |

Supporting analyses (reported, not deciding):

- wκ(H, S) on all 100 sample turns (stratum weights reported alongside); wκ(H, hs-opus), wκ(H, hs-astra); wκ(H, C-suff).
- Sensitivity: human labels with confidence ≥ 2 only.
- Pass 2 (fast vs standard step, the 38 pilot turns): agreement of the human's "fast as good" with the judge's Q1
  "fast established" (κ). If the judge matches the human on pass 2 while C does not match H on pass 1, the gap is
  the one-step construct, not the judge.

`agree.py --human` prints all of this and the branch.

### 11.1 Look 1 result (2026-11-17, 100 human pass-1 labels; pass 2 not done)

- §11 on the 34 common turns, 99% CIs: wκ(H, S) −0.01 [−0.37, +0.20 (0.196)], wκ(H, C) +0.11 [−0.07, +0.31],
  Δ −0.12 [−0.54, +0.18]. Floor not met (C's upper bound 0.31 ≥ 0.2), no separation, short stratum 6 turns (< 15):
  **branch U** (look 1).
- Supporting: wκ(H, hindsight agreed) on 83 sample turns +0.02 [−0.16, +0.13]; H vs hs-opus +0.08, vs hs-astra −0.03
  (n 100); H vs cf-opus-suff +0.02 (n 38).
- **Marginals** (100 turns): human fast 2%, standard 57%, frontier 41%; hs-opus 30 / 40 / 30; hs-astra 28 / 51 / 21;
  on the 34 common turns cf-opus 53 / 32 / 15. The human gives fast on 2 turns; on the 27 turns both hindsight judges
  called fast, the human gave standard 78%, frontier 22%. On short turns (≤ 2 original tool calls, n 21) hindsight
  says 90% fast, the human 0%. Confidence: 3 on 72 turns, 2 on 28, never 1.
- Reading: the disagreement is mostly in the marginals, not in the ordering of the turns. The human label is close to
  binary (standard vs frontier), and on that dimension it agrees only weakly with hindsight (frontier-vs-not κ 0.16).
  Pass 1 asked "a small cheap model would have done it as well" yet produced almost no fast: it measures the tier the
  user wants (or believes necessary without seeing an alternative), which neither LLM label construct measures.
  Pass 2 (the user sees the actual fast and standard next steps) is the test that separates "prefers" from "needs".
- **Construct note (the user, asked afterwards what bar pass 1 used), verbatim:** "the tier I'd prefer, without having
  seen what fast does. If fast's output is as good, I'd accept it." Pass 1 is therefore a prior preference, not a
  sufficiency judgement. Decisions (main session, 2026-11-17): look 2 not approved; D's gold stays hindsight (agreed)
  under branch U, with this caveat; pass 2 on the pilot-session sample turns follows.

### 11.2 Pass 2 result (2026-11-17; supporting analysis, not a §11 branch)

- 33 of the 38 pilot-session sample turns judged (5 skipped by the user). Shown the actual fast (Haiku 5.5) and
  standard (Sonnet 5.5) next steps in a shuffled A/B order, the user judged **fast better on 17, equal on 8, standard
  better on 8**: fast as good or better (the judge's primary bar) on 25/33 = 76% [59, 87]; fast acceptable on 26.
  Fast wins in both positions (fast as A: 7 better / 6 worse; as B: 10 / 2), with some tilt to B (B 16, A 9).
- Against pass 1 on the same turns (2 fast there): of 18 pass-1 standard, 12 became fast as good or better; of 13
  pass-1 frontier, 11 did. Pass 1 (a prior preference) and pass 2 (a judgement of the outputs) measure different things.
- User vs the Opus judge's Q1 (fast established): agreement 58% [41, 73], κ +0.14 [−0.14, +0.40]; the judge is
  stricter (fast 18/33 vs the user's 25/33): judge standard / user fast on 10 turns, the reverse on 4. Short turns
  5/5 agree, sub-agents 8/8 (all fast), notifications 2/9 (κ −0.40), human-kind 4/7, other 5/9. The cf label's fast
  call equals the judge's Q1 on these turns (same numbers).
- Reading: when the user sees the outputs, the one-step sufficiency construct is the one they apply, and they accept
  fast more often than the judge does; the cf labels are conservative relative to the user. But the judge does not
  predict WHICH turns the user accepts (κ 0.14). One step only; the user judged the next step, not the turn.

## 12. Deviations log

- 2026-11-17 smoke: 18 generation calls (9 turns) first ran in another account in us-west-2 (my credentials then;
  the guard was satisfied by an environment value set from the caller). Outputs set aside
  (in a separate excluded results directory, unused), cost $0.80 on the smoke ledger; the guard now reads the
  expected account from `scripts/local.env` only and the Region is pinned. All labels come from ap-northeast-1 / the
  spike account.
- Judge context cut from 40,000 to 24,000 characters after the smoke (budget); the smoke turns are re-judged in the
  pilot with the final settings (smoke judge rows archived, unused).
- Astra audit moved from 10% of all dev to 20% of the pilot only (main session, for an early measurable n).
- Pilot: 2 turns (Fable 5.2 sessions sending `thinking: {type: enabled, budget_tokens: 31999}`) were refused by both
  5.5 models; the edit cascade sent them with thinking dropped and earlier thinking blocks stripped (the recorded
  `output_config-dropped` edit was a no-op: those requests had none). Kept, flagged by `paramEdits`.
