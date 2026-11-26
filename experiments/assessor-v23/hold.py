#!/usr/bin/env python3
"""Held-opinion variants (core's assessorHoldTiers): which held tiers may stand in for a turn without an opinion.

  python3 hold.py --runs <label> --split dev [score.py mapping flags] [--reps 2000] [--root <dir with results/>] [--json out.json]

Reuses score.py (labels, opinion mapping, metrics, bootstrap); only the serving rule differs. Variants:
  symmetric         any held tier (core before assessorHoldTiers; holdTiers fast,standard,frontier)
  asym              a held fast does not stand in: the turn gets the pool default (holdTiers standard,frontier)
  asym-except-skip  as asym, but a held fast still carries across precheck-skipped turns ("ok", "continue")
  no-hold           nothing is held (holdTiers [])
Without an opinion and without a usable held one the turn is served the pool default, which is what core's
cost-gated user turn does (an upgrade from a fast model takes effect at once). Aggregates only, no text.
"""
from __future__ import annotations

import argparse
import json
from typing import Any

import score
from score import DEFAULT, boot, jl, load_gold, metrics, opinion, split_of

VARIANTS = ('symmetric', 'asym', 'asym-except-skip', 'no-hold')


def serve_hold(turns: list[dict[str, Any]], run: dict[str, dict[str, Any]], a: argparse.Namespace, variant: str) -> dict[str, dict[str, Any]]:
    """score.serve() with a hold rule per variant; also marks which turns were served a held tier."""
    held: dict[str, str] = {}
    out: dict[str, dict[str, Any]] = {}
    for t in turns:
        conv = t['session'] if t['lineage'] == 'root' else t['id']
        r = run.get(t['id'])
        op = opinion(r, a, t['kind'])
        kept = held.get(conv)
        use_held = False
        if op is None and kept is not None and variant != 'no-hold':
            skipped = r is not None and r.get('status') == 'ok' and bool(r.get('skipped'))
            use_held = kept != 'fast' or variant == 'symmetric' or (variant == 'asym-except-skip' and skipped)
        if op is not None:
            held[conv] = op
        served = op if op is not None else kept if use_held else DEFAULT
        out[t['id']] = {'op': op, 'served': served, 'has': t['id'] in run, 'held': use_held, 'heldFast': use_held and kept == 'fast',
                        'blocked': op is None and kept == 'fast' and not use_held and variant != 'no-hold'}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--runs', required=True)
    ap.add_argument('--split', default='dev')
    ap.add_argument('--gold', default='agree')
    ap.add_argument('--unmatched-standard', action='store_true')
    ap.add_argument('--lowconf-standard', action='store_true')
    ap.add_argument('--fast-min-conf', type=float, default=0.0)
    ap.add_argument('--reps', type=int, default=2000)
    ap.add_argument('--turns', default='results/sessions/turns.jsonl')
    ap.add_argument('--json', default='')
    ap.add_argument('--root', default=score.HERE, help='directory holding results/ (gitignored; e.g. the main checkout)')
    a = ap.parse_args()
    score.HERE = a.root
    if a.split == 'test':
        raise SystemExit('hold.py: the test split has been used once (PREREG); score held-opinion variants on dev only')
    # The opinion() switches score.py reads that this script does not vary.
    a.skip, a.no_fast, a.fast_lookup_only, a.no_held = set(), set(), False, False
    score.REPS = a.reps
    turns = [t for t in jl(f'{score.HERE}/{a.turns}') if a.split == 'all' or split_of(t['session']) == a.split]
    gold = load_gold(a.gold)
    sess = {t['id']: t['session'] for t in turns}
    run = {r['id']: r for r in jl(f'{score.HERE}/results/runs/{a.runs}.jsonl')}
    sv = {v: serve_hold(turns, run, a, v) for v in VARIANTS}
    ids = [t['id'] for t in turns if t['id'] in gold and t['id'] in run]
    print(f'run={a.runs} split={a.split} gold={a.gold} items={len(ids)}')
    out: dict[str, Any] = {}
    base = 'symmetric'
    for v in VARIANTS:
        m = metrics(ids, sv[v], gold)
        nh = sum(1 for i in ids if sv[v][i]['heldFast'])
        nb = sum(1 for i in ids if sv[v][i]['blocked'])
        out[v] = {**m, 'heldFastN': nh, 'blockedN': nb}
        line = (f"{v:17s} exact={m['exact']:.3f} wrongFast={m['wrongFast']:.3f} under={m['under']:.3f} over={m['over']:.3f} "
                f"cost={m['cost']:.3f} heldFast={nh} blocked={nb}")
        if v != base:
            for key in ('exact', 'wrongFast', 'under', 'cost'):
                d = boot(ids, sess, lambda s, v=v, key=key: metrics(s, sv[v], gold)[key] - metrics(s, sv[base], gold)[key])
                pt = m[key] - metrics(ids, sv[base], gold)[key]
                out[v][f'd_{key}'] = {'diff': pt, 'ci': d}
                line += f" | d{key} {pt:+.3f} [{d[0]:+.3f},{d[1]:+.3f}]"
        print(line)
    if a.json:
        with open(a.json, 'w') as fh:
            json.dump(out, fh, indent=1)


if __name__ == '__main__':
    main()
