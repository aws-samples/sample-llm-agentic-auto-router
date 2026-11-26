#!/usr/bin/env python3
"""Scores assessor runs over the session turns against the hindsight labels (aggregates only, no text).

  python3 score.py --runs <label>[,<label>...] --split dev|test|all [--gold agree|opus|astra|lower|higher]
                   [--unmatched-standard] [--skip-kinds notification,compaction] [--no-held] [--by kind] [--json out.json]

Per turn the assessor gives an opinion (a tier) or none. The served tier follows core: an opinion is used; without
one the conversation's last opinion stands in (held, task 11-16 D2), else the pool default (standard).
Metrics: exact = served tier equals the label; under = served below the label (quality risk); over = served above
it (cost); fast precision = share of fast opinions whose label is fast. CIs: session-cluster bootstrap; Wilson for
precision. `cost` is the mean tier price (fast 0.05, standard 1, frontier 2: Haiku/Sonnet/Opus 5.5 list ratio)
relative to always-standard.
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import os
import random
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
RANK = {'fast': 0, 'standard': 1, 'frontier': 2}
PRICE = {'fast': 0.05, 'standard': 1.0, 'frontier': 2.0}
DEFAULT = 'standard'


def split_of(session: str) -> str:
    x = 2166136261
    for ch in session:
        x = ((x ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return 'dev' if x % 100 < 50 else 'test'


def jl(path: str) -> list[dict[str, Any]]:
    with open(path) as fh:
        return [json.loads(l) for l in fh if l.strip()]


LABEL_SUFFIX = ''


def load_gold(mode: str) -> dict[str, dict[str, Any]]:
    a = {r['id']: r for r in jl(f'{HERE}/results/labels/judge-opus{LABEL_SUFFIX}.jsonl') if r.get('ok')}
    b = {r['id']: r for r in jl(f'{HERE}/results/labels/judge-astra{LABEL_SUFFIX}.jsonl') if r.get('ok')}
    out: dict[str, dict[str, Any]] = {}
    for i in a.keys() & b.keys():
        ta, tb = a[i]['tier'], b[i]['tier']
        if mode == 'agree':
            if ta != tb:
                continue
            t = ta
        elif mode == 'opus':
            t = ta
        elif mode == 'astra':
            t = tb
        elif mode == 'lower':
            t = min(ta, tb, key=RANK.get)
        else:
            t = max(ta, tb, key=RANK.get)
        out[i] = {'tier': t, 'fastSafe': a[i]['fastSafe'] and b[i]['fastSafe'], 'fastSafeAny': a[i]['fastSafe'] or b[i]['fastSafe'], 'agree': ta == tb}
    return out


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (float('nan'), float('nan'))
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    w = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - w) / d, (c + w) / d)


def opinion(r: dict[str, Any] | None, a: argparse.Namespace, kind: str) -> str | None:
    if r is None or r.get('status') != 'ok' or r.get('skipped'):
        return None
    if kind in a.skip:
        return None
    t = r.get('proposedTier')
    if t is None and a.lowconf_standard and r.get('outcome') == 'low-confidence':
        return 'standard'
    if t is None and a.unmatched_standard and r.get('outcome') in ('no-rule', 'fast-unsettled'):
        return 'standard'
    # Offline what-ifs for a fast opinion: a higher confidence bar, lookup depth only (else standard, as unmatched).
    if t == 'fast' and ((r.get('confidence') or 0) < a.fast_min_conf or (a.fast_lookup_only and (r.get('facts') or {}).get('reasoning_depth') != 'lookup')):
        return 'standard'
    if t == 'fast' and kind in a.no_fast:
        return 'standard'
    return t


def serve(turns: list[dict[str, Any]], run: dict[str, dict[str, Any]], a: argparse.Namespace) -> dict[str, dict[str, Any]]:
    """id -> {op, served} with core's held-opinion rule, per conversation in transcript order."""
    held: dict[str, str] = {}
    out: dict[str, dict[str, Any]] = {}
    for t in turns:
        conv = t['session'] if t['lineage'] == 'root' else t['id']
        op = opinion(run.get(t['id']), a, t['kind'])
        if op is not None:
            held[conv] = op
            served = op
        elif not a.no_held and conv in held:
            served = held[conv]
        else:
            served = DEFAULT
        out[t['id']] = {'op': op, 'served': served, 'has': t['id'] in run}
    return out


def metrics(ids: list[str], sv: dict[str, dict[str, Any]], gold: dict[str, dict[str, Any]]) -> dict[str, Any]:
    n = len(ids)
    if n == 0:
        return {'n': 0}
    g = [gold[i]['tier'] for i in ids]
    s = [sv[i]['served'] for i in ids]
    o = [sv[i]['op'] for i in ids]
    fast = [i for i, x in zip(ids, o) if x == 'fast']
    fast_ok = sum(1 for i in fast if gold[i]['tier'] == 'fast')
    front = [i for i, x in zip(ids, o) if x == 'frontier']
    return {
        'n': n,
        'coverage': sum(1 for x in o if x) / n,
        'exact': sum(1 for x, y in zip(s, g) if x == y) / n,
        'under': sum(1 for x, y in zip(s, g) if RANK[x] < RANK[y]) / n,
        'over': sum(1 for x, y in zip(s, g) if RANK[x] > RANK[y]) / n,
        'wrongFast': sum(1 for x, y in zip(s, g) if x == 'fast' and y != 'fast') / n,
        'missedFast': sum(1 for x, y in zip(s, g) if x != 'fast' and y == 'fast') / n,
        'opExact': sum(1 for x, y in zip(o, g) if x == y) / max(1, sum(1 for x in o if x)),
        'fastN': len(fast), 'fastPrec': fast_ok / len(fast) if fast else float('nan'), 'fastPrecCI': wilson(fast_ok, len(fast)),
        'fastSafeAny': sum(1 for i in fast if gold[i]['fastSafeAny']) / len(fast) if fast else float('nan'),
        'fastRecall': fast_ok / max(1, sum(1 for y in g if y == 'fast')),
        'frontN': len(front), 'frontPrec': sum(1 for i in front if gold[i]['tier'] == 'frontier') / len(front) if front else float('nan'),
        'frontRecall': sum(1 for i in front if gold[i]['tier'] == 'frontier') / max(1, sum(1 for y in g if y == 'frontier')),
        'cost': sum(PRICE[x] for x in s) / n, 'costOracle': sum(PRICE[y] for y in g) / n,
    }


REPS = 2000


def boot(ids: list[str], sess: dict[str, str], fn: Any, reps: int | None = None, seed: int = 20261117) -> tuple[float, float]:
    by: dict[str, list[str]] = collections.defaultdict(list)
    for i in ids:
        by[sess[i]].append(i)
    reps = reps or REPS
    keys = sorted(by)
    rnd = random.Random(seed)
    vals = []
    for _ in range(reps):
        sample = [i for k in rnd.choices(keys, k=len(keys)) for i in by[k]]
        vals.append(fn(sample))
    vals.sort()
    return (vals[int(0.025 * reps)], vals[int(0.975 * reps) - 1])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--runs', required=True)
    ap.add_argument('--split', default='dev')
    ap.add_argument('--gold', default='agree')
    ap.add_argument('--unmatched-standard', action='store_true')
    ap.add_argument('--skip-kinds', default='')
    ap.add_argument('--no-held', action='store_true')
    ap.add_argument('--reps', type=int, default=2000)
    ap.add_argument('--turns', default='results/sessions/turns.jsonl')
    ap.add_argument('--label-suffix', default='')
    ap.add_argument('--fast-min-conf', type=float, default=0.0)
    ap.add_argument('--fast-lookup-only', action='store_true')
    ap.add_argument('--lowconf-standard', action='store_true')
    ap.add_argument('--no-fast-kinds', default='')
    ap.add_argument('--by', default='')
    ap.add_argument('--kinds', default='')
    ap.add_argument('--json', default='')
    a = ap.parse_args()
    global REPS, LABEL_SUFFIX
    REPS = a.reps
    LABEL_SUFFIX = a.label_suffix
    a.skip = set(filter(None, a.skip_kinds.split(',')))
    a.no_fast = set(filter(None, a.no_fast_kinds.split(',')))
    turns = [t for t in jl(f'{HERE}/{a.turns}') if a.split == 'all' or split_of(t['session']) == a.split]
    gold = load_gold(a.gold)
    sess = {t['id']: t['session'] for t in turns}
    kinds = set(filter(None, a.kinds.split(',')))
    labels = a.runs.split(',')
    served = {}
    for lab in labels:
        run = {r['id']: r for r in jl(f'{HERE}/results/runs/{lab}.jsonl')}
        served[lab] = serve(turns, run, a)
    ids = [t['id'] for t in turns if t['id'] in gold and all(served[l][t['id']]['has'] for l in labels) and (not kinds or f"{t['lineage']}/{t['kind']}" in kinds or t['kind'] in kinds)]
    print(f'split={a.split} gold={a.gold} items={len(ids)} of {len(turns)} turns; gold mix {dict(collections.Counter(gold[i]["tier"] for i in ids))}')
    out: dict[str, Any] = {}
    groups: dict[str, list[str]] = {'all': ids}
    if a.by == 'kind':
        kd = {t['id']: ('subagent' if t['lineage'] == 'subagent' else t['kind']) for t in turns}
        for i in ids:
            groups.setdefault(kd[i], []).append(i)
    for gname, gids in groups.items():
        for lab in labels:
            m = metrics(gids, served[lab], gold)
            if m['n'] == 0:
                continue
            ci = boot(gids, sess, lambda s, lab=lab: metrics(s, served[lab], gold)['exact']) if gname == 'all' else None
            cu = boot(gids, sess, lambda s, lab=lab: metrics(s, served[lab], gold)['under']) if gname == 'all' else None
            out[f'{gname}/{lab}'] = {**m, 'exactCI': ci, 'underCI': cu}
            print(f"{gname:13s} {lab:22s} n={m['n']:4d} cov={m['coverage']:.2f} exact={m['exact']:.3f}" + (f" [{ci[0]:.3f},{ci[1]:.3f}]" if ci else '')
                  + f" under={m['under']:.3f}" + (f" [{cu[0]:.3f},{cu[1]:.3f}]" if cu else '') + f" over={m['over']:.3f} wrongFast={m['wrongFast']:.3f} missedFast={m['missedFast']:.3f} fast: n={m['fastN']} prec={m['fastPrec']:.3f} [{m['fastPrecCI'][0]:.2f},{m['fastPrecCI'][1]:.2f}] safeAny={m['fastSafeAny']:.2f} rec={m['fastRecall']:.2f}"
                  + f" frontier: n={m['frontN']} prec={m['frontPrec']:.2f} rec={m['frontRecall']:.2f} cost={m['cost']:.3f} (oracle {m['costOracle']:.3f})")
    if len(labels) >= 2:
        base = labels[0]
        for lab in labels[1:]:
            for key in ('exact', 'wrongFast', 'under', 'cost'):
                d = boot(ids, sess, lambda s, lab=lab, key=key: metrics(s, served[lab], gold)[key] - metrics(s, served[base], gold)[key])
                pt = metrics(ids, served[lab], gold)[key] - metrics(ids, served[base], gold)[key]
                out[f'diff/{lab}-{base}/{key}'] = {'diff': pt, 'ci': d}
                print(f'diff {lab} - {base}: {key} {pt:+.3f} [{d[0]:+.3f},{d[1]:+.3f}]')
    if a.json:
        with open(a.json, 'w') as fh:
            json.dump(out, fh, indent=1)


if __name__ == '__main__':
    main()
