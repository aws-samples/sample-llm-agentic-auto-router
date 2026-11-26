#!/usr/bin/env python3
"""Agreement between label sources (eval v2.4, C2 + the pilot gate). Aggregates only, no text.

  python3 agree.py [--split dev] [--pairs a:b,...] [--by kind] [--json out.json]

Sources: hs-opus, hs-astra (v2.3 hindsight judges), hs-agree (both agree), cf-opus, cf-astra, cf-opus-suff (C1
counterfactual labels; -suff = the "fast sufficient" Q1 variant), human (pass 1 of human.py).
Per pair: n, exact agreement (Wilson 95%), Cohen's kappa and linear-weighted kappa (session-cluster bootstrap 95%),
the 3x3 confusion matrix (rows = first source). Self-preference check (cf-opus vs cf-astra on the same turns): the
fast-label rate of each judge (Wilson) and the paired difference (session bootstrap).
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
RES = os.path.join(HERE, 'results')
V23 = os.environ.get('V23_RESULTS', os.path.join(HERE, '..', 'assessor-v23', 'results'))
HUMAN_LABELS = os.environ.get('AGREE_HUMAN_LABELS', os.path.join(RES, 'human', 'labels.jsonl'))
TIERS = ['fast', 'standard', 'frontier']
R = {t: i for i, t in enumerate(TIERS)}
DEFAULT_PAIRS = ['cf-opus:hs-agree', 'cf-opus:hs-opus', 'cf-opus:hs-astra', 'cf-opus:cf-astra', 'cf-opus:cf-opus-suff',
                 'human:hs-agree', 'human:hs-opus', 'human:hs-astra', 'human:cf-opus', 'human:cf-astra', 'hs-opus:hs-astra']


def jl(path: str) -> list[dict[str, Any]]:
    if not os.path.exists(path):
        return []
    with open(path) as fh:
        return [json.loads(l) for l in fh if l.strip()]


def split_of(session: str) -> str:
    x = 2166136261
    for ch in session:
        x = ((x ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return 'dev' if x % 100 < 50 else 'test'


def sources() -> dict[str, dict[str, str]]:
    a = {r['id']: r['tier'] for r in jl(os.path.join(V23, 'labels', 'judge-opus.jsonl')) if r.get('ok')}
    b = {r['id']: r['tier'] for r in jl(os.path.join(V23, 'labels', 'judge-astra.jsonl')) if r.get('ok')}
    out = {'hs-opus': a, 'hs-astra': b, 'hs-agree': {i: a[i] for i in a.keys() & b.keys() if a[i] == b[i]}}
    for name in ('cf-opus', 'cf-astra', 'cf-opus-suff', 'cf-astra-suff'):
        out[name] = {r['id']: r['tier'] for r in jl(os.path.join(RES, 'labels', f'{name}.jsonl')) if r.get('tier') in R}
    hum: dict[str, str] = {}
    for r in jl(HUMAN_LABELS):
        if r.get('pass') == 1:
            if r.get('tier') in R:
                hum[r['id']] = r['tier']
            else:
                hum.pop(r['id'], None)
    out['human'] = hum
    return out


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (float('nan'), float('nan'))
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    w = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - w) / d, (c + w) / d)


def kappa(pairs: list[tuple[str, str]], weighted: bool) -> float:
    n = len(pairs)
    if n == 0:
        return float('nan')
    k = len(TIERS)
    w = [[(1 - abs(i - j) / (k - 1)) if weighted else float(i == j) for j in range(k)] for i in range(k)]
    obs = [[0.0] * k for _ in range(k)]
    for x, y in pairs:
        obs[R[x]][R[y]] += 1 / n
    pr = [sum(obs[i]) for i in range(k)]
    pc = [sum(obs[i][j] for i in range(k)) for j in range(k)]
    po = sum(w[i][j] * obs[i][j] for i in range(k) for j in range(k))
    pe = sum(w[i][j] * pr[i] * pc[j] for i in range(k) for j in range(k))
    return (po - pe) / (1 - pe) if pe < 1 else float('nan')


def boot(ids: list[str], sess: dict[str, str], fn: Any, reps: int = 2000, seed: int = 20261117, level: float = 0.95) -> tuple[float, float]:
    by: dict[str, list[str]] = collections.defaultdict(list)
    for i in ids:
        by[sess[i]].append(i)
    keys = sorted(by)
    rnd = random.Random(seed)
    vals = []
    for _ in range(reps):
        v = fn([i for k in rnd.choices(keys, k=len(keys)) for i in by[k]])
        if not math.isnan(v):
            vals.append(v)
    vals.sort()
    if not vals:
        return (float('nan'), float('nan'))
    lo = (1 - level) / 2
    return (vals[int(lo * len(vals))], vals[max(0, int((1 - lo) * len(vals)) - 1)])


WEIGHTS = {r['id']: r['weight'] for r in jl(os.path.join(RES, 'human', 'sample.jsonl'))}


def compare(a: dict[str, str], b: dict[str, str], ids: list[str], sess: dict[str, str], weighted_sample: bool = False) -> dict[str, Any]:
    ids = [i for i in ids if i in a and i in b]
    pr = [(a[i], b[i]) for i in ids]
    agree = sum(1 for x, y in pr if x == y)
    extra: dict[str, Any] = {}
    if weighted_sample and ids:
        w = [WEIGHTS.get(i, 1.0) for i in ids]
        extra['agreeStratumWeighted'] = sum(wi for wi, (x, y) in zip(w, pr) if x == y) / sum(w)
    conf = [[sum(1 for x, y in pr if x == r and y == c) for c in TIERS] for r in TIERS]
    lookup = dict(zip(ids, pr))
    return {
        'n': len(ids), 'sessions': len({sess[i] for i in ids}), 'agree': agree / len(ids) if ids else float('nan'), 'agreeCI': wilson(agree, len(ids)),
        'kappa': kappa(pr, False), 'kappaCI': boot(ids, sess, lambda s: kappa([lookup[i] for i in s], False)) if len(ids) >= 10 else None,
        'wkappa': kappa(pr, True), 'wkappaCI': boot(ids, sess, lambda s: kappa([lookup[i] for i in s], True)) if len(ids) >= 10 else None,
        'confusion': conf, 'firstLower': sum(1 for x, y in pr if R[x] < R[y]) / len(ids) if ids else float('nan'), **extra,
    }


def human_report(src: dict[str, dict[str, str]], turns: dict[str, dict[str, Any]], sess: dict[str, str]) -> dict[str, Any]:
    """PREREG §11: the pre-registered comparison of the human labels with hindsight (S) and cf-opus (C), and the branch."""
    H, S, C = src['human'], src['hs-agree'], src['cf-opus']
    sample = [r['id'] for r in jl(os.path.join(RES, 'human', 'sample.jsonl'))]
    lab = [i for i in sample if i in H]
    final = all(i in C for i in lab)  # look 2 (cf on every labelled sample turn), else look 1
    level = 0.95 if final else 0.99
    short = {i for i in lab if turns[i]['hindsight']['toolCalls'] <= 2}
    out: dict[str, Any] = {'labelled': len(lab), 'look': 2 if final else 1, 'ciLevel': level}
    print(f"\n=== PREREG §11 human comparison: {len(lab)} sample turns labelled; look {out['look']} ({level:.0%} CIs) ===")

    def wk(a: dict[str, str], ids: list[str]) -> float:
        return kappa([(H[i], a[i]) for i in ids], True)

    def block(name: str, ids: list[str]) -> dict[str, Any]:
        if len(ids) < 2:
            print(f'{name:10s} n={len(ids)}: too few')
            return {'n': len(ids)}
        kh, kc = wk(S, ids), wk(C, ids)
        ci_h = boot(ids, sess, lambda x: wk(S, x), level=level)
        ci_c = boot(ids, sess, lambda x: wk(C, x), level=level)
        ci_d = boot(ids, sess, lambda x: wk(S, x) - wk(C, x), level=level)
        print(f"{name:10s} n={len(ids):3d} ({len({sess[i] for i in ids})} sess)  wk(H,S)={kh:+.2f} {fmt_ci(ci_h)}  wk(H,C)={kc:+.2f} {fmt_ci(ci_c)}  "
              f"delta=S-C {kh - kc:+.2f} {fmt_ci(ci_d)}  agree H=S {sum(H[i] == S[i] for i in ids) / len(ids):.2f} H=C {sum(H[i] == C[i] for i in ids) / len(ids):.2f}")
        return {'n': len(ids), 'wkHS': kh, 'wkHSci': ci_h, 'wkHC': kc, 'wkHCci': ci_c, 'delta': kh - kc, 'deltaCI': ci_d}

    common = [i for i in lab if i in S and i in C]
    out['all'] = a = block('all', common)
    out['short'] = sh = block('short', [i for i in common if i in short])
    out['long'] = lg = block('long', [i for i in common if i not in short])
    for k in ('human', 'notification', 'subagent', 'other'):
        ids = [i for i in common if (('subagent' if turns[i]['lineage'] == 'subagent' else turns[i]['kind'] if turns[i]['kind'] in ('human', 'notification') else 'other') == k)]
        out[f'kind/{k}'] = block(f'kind:{k}', ids)
    # Branch (first that applies), exactly as registered.
    branch = 'U'
    if a.get('n', 0) >= 2:
        if a['wkHSci'][1] < 0.2 and a['wkHCci'][1] < 0.2:
            branch = 'N'
        elif a['deltaCI'][0] > 0 and a['wkHSci'][0] > 0:
            branch = 'S'
        elif a['deltaCI'][1] < 0 and a['wkHCci'][0] > 0:
            branch = 'C'
        elif sh.get('n', 0) >= 15 and lg.get('n', 0) >= 15 and sh['deltaCI'][1] < 0 and lg['deltaCI'][0] > 0:
            branch = 'M'
        elif sh.get('n', 0) >= 15 and lg.get('n', 0) >= 15 and sh['deltaCI'][0] > 0 and lg['deltaCI'][1] < 0:
            branch = "M'"
    out['branch'] = branch
    print(f"BRANCH: {branch}" + ('' if final else '  (look 1: provisional unless separated at 99%; U here means "not separable yet")'))
    # Supporting analyses
    for name, other in (('hs-agree (all labelled)', S), ('hs-opus', src['hs-opus']), ('hs-astra', src['hs-astra']), ('cf-opus-suff', src.get('cf-opus-suff', {}))):
        ids = [i for i in lab if i in other]
        if len(ids) >= 2:
            w = [WEIGHTS.get(i, 1.0) for i in ids]
            agw = sum(wi for wi, i in zip(w, ids) if H[i] == other[i]) / sum(w)
            print(f"support: wk(H, {name}) n={len(ids)} {kappa([(H[i], other[i]) for i in ids], True):+.2f} {fmt_ci(boot(ids, sess, lambda x: kappa([(H[i], other[i]) for i in x], True)))}"
                  f"  agree {sum(H[i] == other[i] for i in ids) / len(ids):.2f} (stratum-weighted {agw:.2f})")
    conf = {r['id']: r.get('confidence', 0) for r in jl(HUMAN_LABELS) if r.get('pass') == 1}
    hi = [i for i in common if conf.get(i, 0) >= 2]
    if len(hi) >= 2:
        print(f"support: confidence >= 2 only: n={len(hi)} wk(H,S)={wk(S, hi):+.2f} wk(H,C)={wk(C, hi):+.2f}")
    # Pass 2 vs the judge's Q1
    cfrows = {r['id']: r for r in jl(os.path.join(RES, 'labels', 'cf-opus.jsonl'))}
    p2: dict[str, dict[str, Any]] = {}
    for r in jl(HUMAN_LABELS):
        if r.get('pass') == 2:
            p2[r['id']] = r
    pairs = []
    for i, r in p2.items():
        q = cfrows.get(i, {}).get('q1FastOk')
        if not q:
            continue
        fast_side = 'A' if r['aIsFast'] else 'B'
        human_fast = r['verdict'] == fast_side or (r['verdict'] == 'equal' and r['worseAcceptable'])
        pairs.append((human_fast, all(q)))
    if pairs:
        both = [('fast' if x else 'standard', 'fast' if y else 'standard') for x, y in pairs]
        print(f"support: pass 2 vs judge Q1 (fast established): n={len(pairs)} agree {sum(x == y for x, y in pairs) / len(pairs):.2f} kappa {kappa(both, False):+.2f}; "
              f"human fast {sum(x for x, _ in pairs)}, judge fast {sum(y for _, y in pairs)}")
        out['pass2'] = {'n': len(pairs), 'agree': sum(x == y for x, y in pairs) / len(pairs), 'kappa': kappa(both, False)}
    return out


def pass2_report(turns: dict[str, dict[str, Any]], sess: dict[str, str]) -> dict[str, Any]:
    """Human pass 2 (the actual fast and standard next steps, shuffled A/B) vs the Opus judge's Q1 and the cf label."""
    p2: dict[str, dict[str, Any]] = {}
    for r in jl(HUMAN_LABELS):
        if r.get('pass') == 2:
            p2[r['id']] = r
    cf = {r['id']: r for r in jl(os.path.join(RES, 'labels', 'cf-opus.jsonl'))}
    src = sources()
    rows = []
    for i, r in p2.items():
        c = cf.get(i)
        if not c or not c.get('q1'):
            continue
        fast_side = 'A' if r['aIsFast'] else 'B'
        hv = 'equal' if r['verdict'] == 'equal' else 'fast' if r['verdict'] == fast_side else 'standard'
        h_est = hv == 'fast' or (hv == 'equal' and r['worseAcceptable'])   # same bar as the judge's primary Q1
        h_acc = h_est or (hv == 'standard' and r['worseAcceptable'])       # fast acceptable (the -suff bar)
        jv = c['q1']['ab'] if c['q1']['ab'] == c['q1']['ba'] else f"{c['q1']['ab']}|{c['q1']['ba']}"
        t = turns[i]
        rows.append({'id': i, 'human': hv, 'humanFastEstablished': h_est, 'humanFastAcceptable': h_acc, 'judgeQ1': jv,
                     'judgeFastEstablished': all(c['q1FastOk']), 'cf': c['tier'], 'cfSuff': src.get('cf-opus-suff', {}).get(i),
                     'pass1': src['human'].get(i), 'stratum': 'short' if t['hindsight']['toolCalls'] <= 2 else 'long',
                     'kind': 'subagent' if t['lineage'] == 'subagent' else t['kind'] if t['kind'] in ('human', 'notification') else 'other'})
    out: dict[str, Any] = {'n': len(rows), 'rows': rows}
    print(f"\n=== pass 2: {len(rows)} turns with the user's fast-vs-standard verdict and the judge's Q1 ===")
    if not rows:
        return out
    print('id       stratum kind          user      user-fast-ok judge-Q1 (ab|ba)     judge-fast cf        pass1')
    for r in sorted(rows, key=lambda x: (x['stratum'], x['kind'])):
        print(f"{r['id'][:8]} {r['stratum']:7s} {r['kind']:13s} {r['human']:9s} {str(r['humanFastEstablished']):12s} {r['judgeQ1']:20s} {str(r['judgeFastEstablished']):10s} {str(r['cf']):9s} {r['pass1']}")
    print('user verdicts:', dict(collections.Counter(r['human'] for r in rows)), '; fast acceptable (incl. standard-better-but-fast-ok):', sum(r['humanFastAcceptable'] for r in rows))
    print('judge Q1:', dict(collections.Counter(r['judgeQ1'] for r in rows)))
    by = {r['id']: r for r in rows}

    def agreement(ids: list[str], a: str, b: str) -> str:
        if len(ids) < 2:
            return f'n={len(ids)}'
        pr = [('fast' if by[i][a] else 'standard', 'fast' if by[i][b] else 'standard') for i in ids]
        k = kappa(pr, False)
        ci = boot(ids, sess, lambda x: kappa([('fast' if by[i][a] else 'standard', 'fast' if by[i][b] else 'standard') for i in x], False))
        ag = sum(x == y for x, y in pr) / len(pr)
        return f"n={len(ids):2d} agree {ag:.2f} {fmt_ci(wilson(sum(x == y for x, y in pr), len(pr)))} kappa {k:+.2f} {fmt_ci(ci)}"

    groups = {'all': list(by)}
    for r in rows:
        groups.setdefault(r['stratum'], []).append(r['id'])
        groups.setdefault(f"kind:{r['kind']}", []).append(r['id'])
    for g, ids in groups.items():
        print(f"{g:18s} user vs judge (fast established): {agreement(ids, 'humanFastEstablished', 'judgeFastEstablished')}")
        out[f'judge/{g}'] = agreement(ids, 'humanFastEstablished', 'judgeFastEstablished')
    for g, ids in groups.items():
        cf_fast = {i: by[i]['cf'] == 'fast' for i in ids}
        for i in ids:
            by[i]['cfFast'] = cf_fast[i]
        print(f"{g:18s} user vs cf label fast:            {agreement(ids, 'humanFastEstablished', 'cfFast')}")
    for i in by:
        by[i]['cfSuffFast'] = by[i]['cfSuff'] == 'fast'
    print(f"{'all':18s} user fast-acceptable vs cf-suff:  {agreement(list(by), 'humanFastAcceptable', 'cfSuffFast')}")
    sw = collections.Counter((r['pass1'], r['human']) for r in rows)
    print('pass 1 tier -> pass 2 verdict:', dict(sw))
    return out


def fmt_ci(ci: Any) -> str:
    return f'[{ci[0]:.2f},{ci[1]:.2f}]' if ci else ''


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--split', default='dev')
    ap.add_argument('--pairs', default=','.join(DEFAULT_PAIRS))
    ap.add_argument('--by', default='')
    ap.add_argument('--json', default='')
    ap.add_argument('--human', action='store_true', help='the pre-registered human comparison (PREREG §11) and its branch')
    ap.add_argument('--pass2', action='store_true', help='human pass 2 vs the judge Q1 and the cf labels')
    a = ap.parse_args()
    turns = {t['id']: t for t in jl(os.path.join(V23, 'sessions', 'turns.jsonl'))}
    sess = {i: t['session'] for i, t in turns.items()}
    ids = [i for i, t in turns.items() if a.split == 'all' or split_of(t['session']) == a.split]
    src = sources()
    print('sources: ' + ', '.join(f'{k} {sum(1 for i in ids if i in v)}' for k, v in src.items()))
    out: dict[str, Any] = {}
    if a.pass2:
        out['pass2'] = pass2_report(turns, sess)
        if a.json:
            with open(a.json, 'w') as fh:
                json.dump(out, fh, indent=1)
        return
    if a.human:
        if not src['human']:
            print('no human labels yet (results/human/labels.jsonl)')
            return
        out['human'] = human_report(src, turns, sess)
        if a.json:
            with open(a.json, 'w') as fh:
                json.dump(out, fh, indent=1)
        return
    groups = {'all': ids}
    if a.by == 'kind':
        for i in ids:
            t = turns[i]
            groups.setdefault('subagent' if t['lineage'] == 'subagent' else t['kind'], []).append(i)
    for pair in filter(None, a.pairs.split(',')):
        x, y = pair.split(':')
        if not src.get(x) or not src.get(y):
            continue
        for g, gids in groups.items():
            m = compare(src[x], src[y], gids, sess, weighted_sample='human' in (x, y))
            if m['n'] == 0:
                continue
            out[f'{pair}/{g}'] = m
            print(f"{pair:24s} {g:12s} n={m['n']:4d} ({m['sessions']} sess) agree={m['agree']:.2f} {fmt_ci(m['agreeCI'])} kappa={m['kappa']:.2f} {fmt_ci(m['kappaCI'])} "
                  f"wkappa={m['wkappa']:.2f} {fmt_ci(m['wkappaCI'])}" + (f" agree(stratum-weighted)={m['agreeStratumWeighted']:.2f}" if 'agreeStratumWeighted' in m else '') + f" {x}-lower={m['firstLower']:.2f} confusion(rows {x}: f/s/r)={m['confusion']}")
    # Self-preference: does the Claude judge call fewer fast than the GPT judge on the same turns?
    for x, y in (('cf-opus', 'cf-astra'), ('cf-opus-suff', 'cf-astra-suff')):
        if src.get(x) and src.get(y):
            both = [i for i in ids if i in src[x] and i in src[y]]
            if not both:
                continue
            fx = sum(1 for i in both if src[x][i] == 'fast')
            fy = sum(1 for i in both if src[y][i] == 'fast')
            d = boot(both, sess, lambda s: (sum(src[x][i] == 'fast' for i in s) - sum(src[y][i] == 'fast' for i in s)) / len(s))
            disc = (sum(1 for i in both if src[x][i] == 'fast' and src[y][i] != 'fast'), sum(1 for i in both if src[x][i] != 'fast' and src[y][i] == 'fast'))
            out[f'selfpref/{x}-{y}'] = {'n': len(both), 'fastRate': {x: fx / len(both), y: fy / len(both)}, 'fastRateCI': {x: wilson(fx, len(both)), y: wilson(fy, len(both))},
                                        'diff': (fx - fy) / len(both), 'diffCI': d, 'discordant': {f'{x} fast only': disc[0], f'{y} fast only': disc[1]}}
            print(f"self-preference {x} vs {y}: n={len(both)} fast rate {fx / len(both):.2f} {fmt_ci(wilson(fx, len(both)))} vs {fy / len(both):.2f} {fmt_ci(wilson(fy, len(both)))}; "
                  f"diff {(fx - fy) / len(both):+.2f} {fmt_ci(d)}; discordant {disc[0]} ({x} fast only) / {disc[1]} ({y} fast only)")
    if a.json:
        with open(a.json, 'w') as fh:
            json.dump(out, fh, indent=1)


if __name__ == '__main__':
    main()
