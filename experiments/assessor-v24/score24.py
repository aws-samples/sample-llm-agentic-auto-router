#!/usr/bin/env python3
"""Pack selection metric of eval v2.4: cost-weighted utility (PREREG.md §Metric), on top of assessor-v23/score.py.

score.py is imported, not edited: the served tier comes from its serve() (so any serve variant added there, e.g. a
held-asymmetric rule, applies here through the same flags), metrics() and boot() are reused.

  python3 score24.py --runs <base>[,<cand>...] [--split dev] [--gold cf-opus|cf-astra|human|agree|opus|astra|lower|higher]
                     [--weights wf=7,us=1,c=1] [--grid] [--by kind] [--json out.json] [score.py serve flags ...]

Per turn u = -w_c*price(served) - w_us*[served below label] - w_wf*[served fast and label not fast]; price = score.PRICE
(fast 0.05, standard 1, frontier 2). A wrongly fast turn pays both error terms. utility = mean u. Higher is better.
Decision rule (pre-registered): a candidate replaces the base iff the paired session-bootstrap 95% CI of
utility(cand) - utility(base) lies above 0 AND the CI of wrongFast(cand) - wrongFast(base) does not lie above 0.
"""
from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import os
import sys
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
V23_CODE = os.environ.get('V23_DIR', os.path.join(HERE, '..', 'assessor-v23'))
V23_DATA = os.environ.get('V23_RESULTS', os.path.join(HERE, '..', 'assessor-v23', 'results'))

_spec = importlib.util.spec_from_file_location('score_v23', os.path.join(V23_CODE, 'score.py'))
S = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(S)  # type: ignore[union-attr]
S.HERE = os.path.dirname(V23_DATA)  # score.py reads <HERE>/results/...: point it at the data

WEIGHTS = {'wf': 7.0, 'us': 1.0, 'c': 1.0}
GRID = [{'wf': wf, 'us': us, 'c': 1.0} for wf in (3.0, 7.0, 20.0) for us in (0.5, 1.0, 2.0)]


def turn_u(served: str, label: str, w: dict[str, float]) -> float:
    R = S.RANK
    return -(w['wf'] * (served == 'fast' and label != 'fast') + w['us'] * (R[served] < R[label])) - w['c'] * S.PRICE[served]


def utility(ids: list[str], sv: dict[str, dict[str, Any]], gold: dict[str, dict[str, Any]], w: dict[str, float] = WEIGHTS) -> float:
    """score.py-compatible: same (ids, served, gold) arguments as metrics(), usable inside boot()."""
    return sum(turn_u(sv[i]['served'], gold[i]['tier'], w) for i in ids) / len(ids) if ids else float('nan')


def load_gold24(mode: str) -> dict[str, dict[str, Any]]:
    """id -> {tier, fastSafeAny, ...}. cf-*: counterfactual labels (results/labels/cf-<judge>.jsonl); human: the
    calibration labels (results/human/labels.jsonl, pass 1); anything else: score.py's hindsight modes."""
    def rows(path: str) -> list[dict[str, Any]]:
        return S.jl(path) if os.path.exists(path) else []
    if mode.startswith('cf-'):
        out = {}
        for r in rows(os.path.join(HERE, 'results', 'labels', f'{mode}.jsonl')):
            if r.get('tier') in S.RANK:
                out[r['id']] = {'tier': r['tier'], 'fastSafe': r['tier'] == 'fast', 'fastSafeAny': r['tier'] == 'fast', 'agree': True, 'basis': r.get('basis')}
        return out
    if mode == 'human':
        out = {}
        for r in rows(os.path.join(HERE, 'results', 'human', 'labels.jsonl')):
            if r.get('pass') == 1 and r.get('tier') in S.RANK:
                out[r['id']] = {'tier': r['tier'], 'fastSafe': r['tier'] == 'fast', 'fastSafeAny': r['tier'] == 'fast', 'agree': True}
        return out
    return S.load_gold(mode)


class Flags(argparse.Namespace):
    """score.py serve flags; an attribute a newer score.py reads that this parser does not know is False."""
    def __getattr__(self, name: str) -> Any:
        if name.startswith('_'):
            raise AttributeError(name)
        return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--runs', required=True)
    ap.add_argument('--split', default='dev')
    ap.add_argument('--gold', default='cf-opus')
    ap.add_argument('--weights', default='')
    ap.add_argument('--grid', action='store_true')
    ap.add_argument('--reps', type=int, default=2000)
    ap.add_argument('--turns', default=os.path.join(V23_DATA, 'sessions', 'turns.jsonl'))
    ap.add_argument('--by', default='')
    ap.add_argument('--json', default='')
    # score.py serve flags (same names and meaning)
    ap.add_argument('--unmatched-standard', action='store_true')
    ap.add_argument('--skip-kinds', default='')
    ap.add_argument('--no-held', action='store_true')
    ap.add_argument('--fast-min-conf', type=float, default=0.0)
    ap.add_argument('--fast-lookup-only', action='store_true')
    ap.add_argument('--lowconf-standard', action='store_true')
    ap.add_argument('--no-fast-kinds', default='')
    parsed, extra = ap.parse_known_args()
    a = Flags(**vars(parsed))  # unknown attributes read as False only after argparse has set every default
    for x in extra:  # pass-through: --flag or --flag=value for serve variants added to score.py later
        k, _, v = x.lstrip('-').partition('=')
        setattr(a, k.replace('-', '_'), v if v else True)
    a.skip = set(filter(None, a.skip_kinds.split(',')))
    a.no_fast = set(filter(None, a.no_fast_kinds.split(',')))
    S.REPS = a.reps
    w = dict(WEIGHTS)
    for kv in filter(None, a.weights.split(',')):
        k, _, v = kv.partition('=')
        w[k] = float(v)
    turns = [t for t in S.jl(a.turns) if a.split == 'all' or S.split_of(t['session']) == a.split]
    gold = load_gold24(a.gold)
    sess = {t['id']: t['session'] for t in turns}
    labels = a.runs.split(',')
    served = {lab: S.serve(turns, {r['id']: r for r in S.jl(os.path.join(V23_DATA, 'runs', f'{lab}.jsonl'))}, a) for lab in labels}
    ids = [t['id'] for t in turns if t['id'] in gold and all(served[l][t['id']]['has'] for l in labels)]
    print(f'split={a.split} gold={a.gold} items={len(ids)} sessions={len({sess[i] for i in ids})} weights={w}; gold mix {dict(collections.Counter(gold[i]["tier"] for i in ids))}')
    out: dict[str, Any] = {'weights': w, 'gold': a.gold, 'split': a.split, 'n': len(ids)}
    groups: dict[str, list[str]] = {'all': ids}
    if a.by == 'kind':
        kd = {t['id']: ('subagent' if t['lineage'] == 'subagent' else t['kind']) for t in turns}
        for i in ids:
            groups.setdefault(kd[i], []).append(i)
    for gname, gids in groups.items():
        for lab in labels:
            m = S.metrics(gids, served[lab], gold)
            u = utility(gids, served[lab], gold, w)
            ci = S.boot(gids, sess, lambda s, lab=lab: utility(s, served[lab], gold, w)) if gname == 'all' else None
            out[f'{gname}/{lab}'] = {'utility': u, 'utilityCI': ci, **{k: m[k] for k in ('n', 'exact', 'under', 'over', 'wrongFast', 'cost', 'costOracle', 'fastN', 'fastPrec')}}
            print(f"{gname:13s} {lab:22s} n={m['n']:4d} utility={u:+.3f}" + (f" [{ci[0]:+.3f},{ci[1]:+.3f}]" if ci else '')
                  + f" exact={m['exact']:.3f} under={m['under']:.3f} wrongFast={m['wrongFast']:.3f} cost={m['cost']:.3f} fast n={m['fastN']} prec={m['fastPrec']:.2f}")
    if len(labels) >= 2:
        base = labels[0]
        for lab in labels[1:]:
            d = {}
            for key, fn in (('utility', lambda s, l: utility(s, served[l], gold, w)), ('wrongFast', lambda s, l: S.metrics(s, served[l], gold)['wrongFast']),
                            ('exact', lambda s, l: S.metrics(s, served[l], gold)['exact']), ('cost', lambda s, l: S.metrics(s, served[l], gold)['cost'])):
                pt = fn(ids, lab) - fn(ids, base)
                ci = S.boot(ids, sess, lambda s, fn=fn, lab=lab: fn(s, lab) - fn(s, base))
                d[key] = {'diff': pt, 'ci': ci}
                print(f'diff {lab} - {base}: {key} {pt:+.3f} [{ci[0]:+.3f},{ci[1]:+.3f}]')
            d['replaces'] = d['utility']['ci'][0] > 0 and not d['wrongFast']['ci'][0] > 0
            print(f'decision {lab} vs {base}: {"REPLACES" if d["replaces"] else "does not replace"} (utility CI above 0 and wrongFast CI not above 0)')
            if a.grid:
                for g in GRID:
                    pt = utility(ids, served[lab], gold, g) - utility(ids, served[base], gold, g)
                    ci = S.boot(ids, sess, lambda s, g=g, lab=lab: utility(s, served[lab], gold, g) - utility(s, served[base], gold, g), reps=min(a.reps, 1000))
                    d.setdefault('grid', []).append({'w': g, 'diff': pt, 'ci': ci})
                    print(f"  grid wf={g['wf']:<4} us={g['us']:<3}: {pt:+.3f} [{ci[0]:+.3f},{ci[1]:+.3f}]")
            out[f'diff/{lab}-{base}'] = d
    if a.json:
        with open(a.json, 'w') as fh:
            json.dump(out, fh, indent=1)


if __name__ == '__main__':
    main()
