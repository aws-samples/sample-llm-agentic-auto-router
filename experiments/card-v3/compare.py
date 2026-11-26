#!/usr/bin/env python3
"""Two recorded runs on the same dev turns, both mapped by the v2.3 hand mapping (features.ts `op`), served as core
serves them (score.py serve(), held opinions) and scored against the agreed hindsight labels. Aggregates only.

  python3 compare.py --base v23-main --cand v3-main [--labels agree|...|<file.jsonl>] [--reps 2000] [--json out]
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fit as F  # noqa: E402
S = F.S


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True)
    ap.add_argument('--cand', required=True)
    ap.add_argument('--labels', default='agree')
    ap.add_argument('--reps', type=int, default=2000)
    ap.add_argument('--json', default='')
    a = ap.parse_args()
    S.REPS = a.reps
    base, gold, turns = F.load([a.base], a.labels)
    cand, _, _ = F.load([a.cand], a.labels)
    (s, ts), = turns.items()
    ops = {name: {r['id']: r['op'] for r in rows} for name, rows in (('base', base), ('cand', cand))}
    kind = {t['id']: ('subagent' if t['lineage'] == 'subagent' else t['kind']) for t in ts}
    out: dict = {'set': s, 'base': a.base, 'cand': a.cand, 'labels': a.labels, 'mix': {}, 'metrics': {}}

    print(f'{s}: opinion mix per kind (fast/standard/frontier/none), {a.base} -> {a.cand}')
    for k in sorted({*kind.values()}):
        row = {}
        for name in ('base', 'cand'):
            c = collections.Counter(ops[name].get(t['id']) or 'none' for t in ts if kind[t['id']] == k)
            row[name] = {x: c.get(x, 0) for x in ('fast', 'standard', 'frontier', 'none')}
        out['mix'][k] = row
        fmt = lambda d: '/'.join(str(d[x]) for x in ('fast', 'standard', 'frontier', 'none'))  # noqa: E731
        print(f'  {k:13s} {fmt(row["base"]):>16s} -> {fmt(row["cand"])}')

    sv = {name: F.served(ts, ops[name]) for name in ops}
    groups = {'all': [t['id'] for t in ts if t['id'] in gold]}
    for t in ts:
        if t['id'] in gold:
            groups.setdefault(kind[t['id']], []).append(t['id'])
    sess = {t['id']: t['session'] for t in ts}
    for g, ids in groups.items():
        for name in ('base', 'cand'):
            m = S.metrics(ids, sv[name], gold)
            out['metrics'][f'{g}/{name}'] = {k: v for k, v in m.items() if k != 'fastPrecCI'}
            print(f"  {g:13s} {name:4s} n={m['n']:4d} exact={m['exact']:.3f} wrongFast={m['wrongFast']:.3f} under={m['under']:.3f} "
                  f"fast n={m['fastN']} prec={m['fastPrec']:.3f} rec={m['fastRecall']:.3f} frontier n={m['frontN']} cost={m['cost']:.3f} (oracle {m['costOracle']:.3f})")
        if g == 'all':
            for key in ('exact', 'wrongFast', 'under', 'fastRecall', 'cost'):
                d = S.boot(ids, sess, lambda x, key=key: S.metrics(x, sv['cand'], gold)[key] - S.metrics(x, sv['base'], gold)[key])
                pt = out['metrics']['all/cand'][key] - out['metrics']['all/base'][key]
                out['metrics'][f'diff/{key}'] = {'diff': pt, 'ci': d}
                print(f'    cand − base {key}: {pt:+.3f} [{d[0]:+.3f},{d[1]:+.3f}]')
    if a.json:
        with open(a.json, 'w') as fh:
            json.dump(out, fh, indent=1)


if __name__ == '__main__':
    main()
