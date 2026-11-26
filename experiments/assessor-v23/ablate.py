#!/usr/bin/env python3
"""Ablations of the frozen v2.3 run (no new model calls): each v2.3 mapping key switched off in turn, recomputed from
the recorded facts, matched rules and confidence of each call, then scored like score.py.

  python3 ablate.py --run v23-test --split test [--gold agree]
"""
import argparse, json, sys, os, copy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score as S

FAST_RULES = {'explore-readonly', 'mechanical-edit'}
def settled_fast(r):
    f = r.get('facts') or {}
    return bool(set(r.get('matched') or []) & FAST_RULES) and f.get('specification') == 'fully-specified' and f.get('reasoning_depth') in ('lookup', 'routine')

def variant(r, name):
    """The row as the pack would have mapped it without one key ('none' = the frozen pack)."""
    r = dict(r)
    b = r.get('basis') or []
    if name == 'no-fast-bar' and b == ['fact:unmatched'] and settled_fast(r) and (r.get('confidence') or 0) >= 0.8 \
            and not (set(r.get('matched') or []) & {'bounded-change', 'deep-investigation'}) and not ((r.get('facts') or {}).get('edits_code') and (r.get('facts') or {}).get('scope') in ('multi-file', 'cross-module') and False):
        r.update(proposedTier='fast', outcome='fast', basis=sorted(set(r['matched']) & FAST_RULES))
    if name == 'no-lowconf' and b == ['fact:low-confidence']:
        r.pop('proposedTier', None); r.update(outcome='low-confidence', basis=['low-confidence'])
    if name == 'no-unmatched' and b == ['fact:unmatched']:
        r.pop('proposedTier', None); r.update(outcome='fast-unsettled' if settled_fast(r) or (set(r.get('matched') or []) & FAST_RULES) else 'no-rule', basis=['no-rule'])
    return r

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--run', required=True); ap.add_argument('--split', default='test'); ap.add_argument('--gold', default='agree')
    ap.add_argument('--reps', type=int, default=2000); a = ap.parse_args()
    S.REPS = a.reps
    opts = argparse.Namespace(unmatched_standard=False, lowconf_standard=False, fast_min_conf=0.0, fast_lookup_only=False, no_fast=set(), skip=set(), no_held=False)
    turns = [t for t in S.jl(f'{S.HERE}/results/sessions/turns.jsonl') if a.split == 'all' or S.split_of(t['session']) == a.split]
    gold = S.load_gold(a.gold); sess = {t['id']: t['session'] for t in turns}
    rows = S.jl(f'{S.HERE}/results/runs/{a.run}.jsonl')
    served = {}
    for name in ('none', 'no-fast-bar', 'no-lowconf', 'no-unmatched'):
        served[name] = S.serve(turns, {r['id']: variant(r, name) for r in rows}, opts)
    ids = [t['id'] for t in turns if t['id'] in gold and served['none'][t['id']]['has']]
    out = {}
    for name, sv in served.items():
        m = S.metrics(ids, sv, gold)
        out[name] = m
        print(f"{name:13s} n={m['n']} exact={m['exact']:.3f} wrongFast={m['wrongFast']:.3f} under={m['under']:.3f} fast n={m['fastN']} prec={m['fastPrec']:.3f} [{m['fastPrecCI'][0]:.2f},{m['fastPrecCI'][1]:.2f}] rec={m['fastRecall']:.2f} cost={m['cost']:.3f}")
        if name != 'none':
            for k in ('exact', 'wrongFast', 'under'):
                d = S.boot(ids, sess, lambda s, k=k, sv=sv: S.metrics(s, served['none'], gold)[k] - S.metrics(s, sv, gold)[k])
                pt = m and S.metrics(ids, served['none'], gold)[k] - m[k]
                out[f'{name}/{k}'] = {'frozenMinusAblated': pt, 'ci': d}
                print(f'    frozen − {name}: {k} {pt:+.3f} [{d[0]:+.3f},{d[1]:+.3f}]')
    # The calls the 0.9 bar turned away from fast, on their own.
    gated = [r for r in rows if (r.get('basis') or []) == ['fact:unmatched'] and settled_fast(r) and 0.8 <= (r.get('confidence') or 0) < 0.9 and r['id'] in gold]
    k = sum(1 for r in gated if gold[r['id']]['tier'] == 'fast')
    print(f'fast matches turned away by the 0.9 bar: n={len(gated)}, label fast {k} ({k/max(1,len(gated)):.2f}) {S.wilson(k, len(gated))}')
    json.dump(out, open(f'{S.HERE}/results/scores/ablate-{a.run}.json', 'w'), indent=1)

if __name__ == '__main__':
    main()
