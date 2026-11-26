# Assessor v2.3: evaluation plan (written 2026-11-17, before any test-split run)

## Data

- **Session turns**: user-text messages that a model answered, exported from local Claude Code session transcripts
  (`sessions.py`; 1,382 turns, 294 sessions, 10 projects). Kinds: human prompt, client notification
  (`<task-notification>`), compaction summary, slash command, sub-agent brief. Local only (`results/` is gitignored).
- **Split**: by session, `splitOf(session)` in `common.ts` (FNV-1a mod 100 < 50 → dev). Dev 801 turns, test 581.
  Packs, card fields, rules, mapping and every threshold are chosen on dev only. Test runs once, for the shipped
  default (v2.2) and the frozen candidate, on the same items.
- **Labels**: two hindsight judges (Opus 5.5 and GPT Astra) each read the request and what the agent then did (tool
  calls, edits, errors, final answer, the user's next message) and record the tier the work needed (`judge.ts`).
  Primary label = the turns where both agree. Sensitivity: each judge alone, the lower and the higher of the two.
  The judges ran on every turn before any assessor candidate existed.
- **What the labels are not**: measured outcomes. They are informed opinions about the work done. The Harbor
  experiments measured that frontier models did not beat standard ones on benchmark tasks, so the pack keeps
  v2.2's narrow frontier rule whatever the judges call frontier; frontier agreement is reported, not optimised.

## Served tier

Per turn the assessor gives an opinion or none. As in core: an opinion is used; without one, the conversation's
last opinion stands in (held), else the pool default (standard). No cost gates, no downgrade guard: this scores
the assessor, not the router.

## Metrics (test split, agreed labels, v2.3 against v2.2 on the same turns)

Primary:

1. **Exact**: served tier equals the label. Paired session-cluster bootstrap (2,000 resamples, seed 20261117).
   "Better" = the 95% CI of the difference is above 0.
2. **Wrongly fast**: turns served fast (fresh or held) whose label is not fast, as a share of all turns. The
   quality risk. "Not worse" = the CI of the difference does not lie above 0.
3. **Fast precision and recall** of fresh fast opinions (Wilson interval for precision).

Secondary: under- and over-serving, coverage, the same by turn kind, the other label definitions, latency and cost
per consultation.

Regression (no new tuning): the hand-labelled and trajectory sets and the SWE-bench test split of the earlier
evaluation; the Harbor session-start cards (DeepSWE, TB) through the simulated-routing score of the v2.2 report.

## Budget

Live calls: $500 (the user's limit; a 40% overrun is allowed, not planned). Ledgers: `results/ledger-*.json`.

## Addendum (2026-11-17, after the test-split run, before any call on this set)

A second held-out set: the user turns of the automated agent workspace that the main export excluded
(`sessions.py --match kiro-crew`, 1,601 turns, 1,485 sessions, a different client harness, many helper agents).
Nothing was tuned on it. Same two judges, same label rule, same metrics; v2.2 and the frozen v2.3
(`assessor/v2.3+956b16efb7ea`) once each on every turn. Reported as a second, distribution-shifted check, not pooled
with the main test split.
