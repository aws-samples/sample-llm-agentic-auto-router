#!/usr/bin/env python3
"""Counterfactual tier labels from the pairwise judge rows (eval v2.4, C1; rule pre-registered in PREREG.md §Labels).

  python3 label.py --judge opus [--judge astra]   -> results/labels/cf-<judge>.jsonl + aggregate stats on stderr

Per turn (both orders of each question must have a valid verdict, else the turn has no label):
  Q1 fast vs standard. fast := in BOTH orders the fast step is "equal or better" AND sufficient.
  Otherwise, Q2 standard vs the original first step (a frontier-tier model in the session), when the original is
  frontier-tier:
    frontier := the original is better in BOTH orders;
    standard := otherwise (equal or standard better in both orders: cf-standard; split verdicts: cf-tie-frontier).
  Not fast and the original is not frontier-tier: standard (cf-standard-noq2).
  --rule sufficient (sensitivity, written to cf-<judge>-suff.jsonl): Q1 fast := the fast step is sufficient in both
  orders, whatever the comparison says. Every primary fast turn is fast here too (the primary rule also requires
  sufficiency); the extra fast turns are ones where the judge preferred standard but found fast acceptable.
  basis cf-tie-fast: exactly one Q1 order established fast (the label is then decided by Q2 like any non-fast turn).
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, 'results')
CF_VERSION = 'cf/v1'
FRONTIER_ORIGINALS = {'claude-opus-5-5', 'claude-fable-5-2', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5'}


def jl(path: str) -> list[dict[str, Any]]:
    if not os.path.exists(path):
        return []
    with open(path) as fh:
        return [json.loads(l) for l in fh if l.strip()]


RULE = 'equal-or-better'  # PREREG primary; 'sufficient' = sensitivity variant (fast step sufficient, whatever `better` says)


def fast_ok(row: dict[str, Any]) -> bool:
    """The fast step establishes fast in this order: equal or better AND sufficient (primary), or sufficient only."""
    v = row['v']
    suff = v['aSufficient'] if row['A'] == 'fast' else v['bSufficient']
    if RULE == 'sufficient':
        return suff
    return suff and v['better'] != ('B' if row['A'] == 'fast' else 'A')


def fast_view(row: dict[str, Any]) -> str:
    """The verdict from the fast step's side: fast / standard / equal."""
    b = row['v']['better']
    if b == 'equal':
        return 'equal'
    return row['A'] if b == 'A' else row['B']


def q2_view(row: dict[str, Any]) -> str:
    """original / standard / equal."""
    b = row['v']['better']
    if b == 'equal':
        return 'equal'
    return row['A'] if b == 'A' else row['B']


def label_turn(rows: list[dict[str, Any]], original_model: str) -> dict[str, Any]:
    by = {(r['q'], r['order']): r for r in rows if r.get('ok')}
    q1 = [by.get(('q1', 'ab')), by.get(('q1', 'ba'))]
    if None in q1:
        return {'tier': None, 'basis': 'judge-missing'}
    oks = [fast_ok(r) for r in q1]  # type: ignore[arg-type]
    out: dict[str, Any] = {'q1': {'ab': fast_view(q1[0]), 'ba': fast_view(q1[1])}, 'q1FastOk': oks}  # type: ignore[index]
    if all(oks):
        return {**out, 'tier': 'fast', 'basis': 'cf-fast'}
    tie_fast = any(oks)
    if original_model not in FRONTIER_ORIGINALS:
        return {**out, 'tier': 'standard', 'basis': 'cf-tie-fast' if tie_fast else 'cf-standard-noq2', 'q2': None}
    q2 = [by.get(('q2', 'ab')), by.get(('q2', 'ba'))]
    if None in q2:
        return {**out, 'tier': None, 'basis': 'judge-missing'}
    views = [q2_view(r) for r in q2]  # type: ignore[arg-type]
    out['q2'] = {'ab': views[0], 'ba': views[1]}
    if views == ['original', 'original']:
        return {**out, 'tier': 'frontier', 'basis': 'cf-frontier'}
    if 'original' in views and views != ['original', 'original']:
        return {**out, 'tier': 'standard', 'basis': 'cf-tie-frontier'}
    return {**out, 'tier': 'standard', 'basis': 'cf-tie-fast' if tie_fast else 'cf-standard'}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--judge', action='append', required=True)
    ap.add_argument('--rule', default='equal-or-better', choices=['equal-or-better', 'sufficient'])
    a = ap.parse_args()
    global RULE
    RULE = a.rule
    suffix = '' if a.rule == 'equal-or-better' else '-suff'
    index = {r['id']: r for r in jl(os.path.join(RES, 'requests', 'index.jsonl'))}
    gen = collections.defaultdict(dict)
    for r in jl(os.path.join(RES, 'cf', 'gen.jsonl')):
        if r.get('ok'):
            gen[r['id']][r['tier']] = r
    os.makedirs(os.path.join(RES, 'labels'), exist_ok=True)
    for judge in a.judge:
        rows = collections.defaultdict(list)
        cost = collections.Counter()
        for r in jl(os.path.join(RES, 'cf', f'judge-{judge}.jsonl')):
            rows[r['id']].append(r)
            cost[r['id']] += r.get('costUsd') or 0
        out = []
        for tid, rs in rows.items():
            ix = index.get(tid, {})
            g = gen.get(tid, {})
            lab = label_turn(rs, ix.get('originalModel') or '')
            out.append({'id': tid, 'session': ix.get('session'), 'split': ix.get('split'), 'kind': ix.get('kind'), 'lineage': ix.get('lineage'),
                        'carrier': ix.get('carrier'), **lab, 'originalModel': ix.get('originalModel'),
                        'fastModel': g.get('fast', {}).get('model'), 'standardModel': g.get('standard', {}).get('model'),
                        'fastTruncated': g.get('fast', {}).get('stopReason') == 'max_tokens', 'standardTruncated': g.get('standard', {}).get('stopReason') == 'max_tokens',
                        'judge': judge, 'cfVersion': CF_VERSION,
                        'costUsd': round(cost[tid] + sum((x.get('costUsd') or 0) for x in g.values()), 6)})
        with open(os.path.join(RES, 'labels', f'cf-{judge}{suffix}.jsonl'), 'w') as fh:
            for r in out:
                fh.write(json.dumps(r) + '\n')
        n = len(out)
        q1 = [r for r in out if r.get('q1')]
        cons = sum(1 for r in q1 if r['q1']['ab'] == r['q1']['ba'])
        q2 = [r for r in out if r.get('q2')]
        cons2 = sum(1 for r in q2 if r['q2']['ab'] == r['q2']['ba'])
        print(json.dumps({'judge': judge, 'rule': a.rule, 'turns': n, 'tiers': dict(collections.Counter(r['tier'] for r in out)), 'basis': dict(collections.Counter(r['basis'] for r in out)),
                          'q1OrderConsistency': round(cons / len(q1), 3) if q1 else None, 'q2OrderConsistency': round(cons2 / len(q2), 3) if q2 else None,
                          'q2Turns': len(q2), 'costUsd': round(sum(r['costUsd'] for r in out), 2)}), file=sys.stderr)


if __name__ == '__main__':
    main()
