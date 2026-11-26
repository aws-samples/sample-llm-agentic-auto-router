# Template memory and a learned fast head (brief D)

Dev split only (the v2.3 session split; the test split is untouched). `results/` is gitignored: it holds the user's
own text (exports), per-turn rows, the D4 runs and any data-fitted weights. Scripts print aggregates only.

**card/v3 tried 2026-11-17, rejected: no served change on dev, kiro cost ×3.4.** card/v3 removed the learned
template from the card text (branch `feat/card-v3`, pack v2.4-candidate, live dev run of 1,620 calls for $1.26, rows in
`results/runs/v24c-*.jsonl`). What ships instead: the card stays card/v2; the router's template memory measures the
template length (`templateChars`, logged) and a pack's optional `mapping.learned` head can read it.

| Script | What |
|---|---|
| `cards.ts` | The production card/v2 for each session turn, and the template length the router would compute (`templateViews`: cardUserTexts + the template memory, fed in transcript time order) |
| `measure.ts` | D2: how much of the card/v2 latestUser window is template, and what a stripped card would have shown |
| `features.ts` | Per recorded run row: the v2.3 hand opinion and every learned feature, computed by `map.ts` |
| `compare.py` | Two runs under the v2.3 hand mapping, served as core serves them (held opinions) |
| `fit.py` | D3: L2 logistic fast head, 5-fold session-grouped CV against the hand mapping; `--freeze` |
| `parity.ts` | The frozen head as pack data (validatePack + mapTier) vs fit.py, row by row; `--write-pack` to `results/packs/` |

The learned head is an opt-in pack for deployments with many templated clients, not a default:

- It mostly re-learns "this is the templated kiro family", which the console's template-family fast rule covers with
  admin approval.
- It was fitted on one user's sessions, where one client family dominates the templated traffic, and selected among
  several variants on the same dev CV; it has not been checked on held-out data. Its weights stay in `results/`.
- Train/serve skew: the router's memory is process-local (per task, empty after a restart), while `cards.ts` feeds one
  memory every dev turn of a set in order, as warm as a single long-lived process could be. A fresh router task reports
  no template until it has seen a template from two other lineages.
- Its labels are hindsight LLM judgements (two judges, agreed). On 33 turns the user judged with the real outputs in
  front of them, they accepted fast on 76%, far above the hindsight labels' fast rate, so a head fitted on hindsight
  labels is conservative by the user's own standard.

Reproduce (from this directory, `ASSESSOR_V23_RESULTS=<main checkout>/experiments/assessor-v23/results`):

```bash
python3 ../assessor-v23/sessions.py --match kiro-crew --max-chars 200000 --max-first-chars 200000 --out results/sessions/kiro-turns-full.jsonl
node measure.ts
node features.ts --set main --run $ASSESSOR_V23_RESULTS/runs/d-dev.jsonl --label v23-main
node features.ts --set kiro-full --run $ASSESSOR_V23_RESULTS/runs/v23-kiro.jsonl --label v23-kiro
python3 fit.py --features v23-main,v23-kiro --low-confidence --union --freeze results/learned-v23.json
node parity.ts --learned results/learned-v23.json --runs main:$ASSESSOR_V23_RESULTS/runs/d-dev.jsonl,kiro-full:$ASSESSOR_V23_RESULTS/runs/v23-kiro.jsonl --write-pack v2.3-learned
# the rejected card/v3 runs, under the hand mapping:
node features.ts --set main --run results/runs/v24c-main-dev.jsonl --label v3-main
node features.ts --set kiro-full --run results/runs/v24c-kiro-full-dev.jsonl --label v3-kiro
python3 compare.py --base v23-main --cand v3-main && python3 compare.py --base v23-kiro --cand v3-kiro
```

`fit.py --labels <file.jsonl>` takes any `{"id", "tier"}` label file (e.g. counterfactual labels) instead of the
agreed hindsight labels.
