#!/usr/bin/env python3
"""D3 (brief D): a learned fast head on the DEV split, compared with the v2.3 hand mapping by session-grouped CV.

  python3 fit.py --features v23-main,v23-kiro [--labels agree|opus|astra|lower|higher|<file.jsonl>] [--drop card,template]
                 [--folds 5] [--l2 1.0] [--freeze results/learned.json]

Input: results/features-<label>.jsonl (features.ts: per dev turn the v2.3 hand opinion, whether the hand mapping
reached its fast/standard step (`eligible`), and every learned feature as map.ts computes it). Labels: the agreed
hindsight labels by default (score.py load_gold, per set suffix), or any jsonl of {"id", "tier"} (e.g. peer C's
counterfactual labels) via --labels <file>.

The head: L2 logistic regression P(label fast | features) on eligible labelled rows (pure Python IRLS, standardised
features, coefficients folded back onto raw features). Its threshold is chosen on the training rows: the highest
served exact among thresholds whose training fast precision, in every set, is at least that set's hand mapping's. Eligible rows get fast
or standard from the head; every other row keeps the hand opinion. Served tiers follow score.py serve() (held
opinions), scored per set with session-bootstrap CIs for learned − hand. Prints aggregates only.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assessor-v23'))
import score as S  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
V23 = os.environ.get('ASSESSOR_V23_RESULTS', os.path.join(HERE, '..', 'assessor-v23', 'results'))
TURNS = {'main': 'sessions/turns.jsonl', 'kiro': 'sessions/kiro-turns.jsonl'}
SUFFIX = {'main': '', 'kiro': '-kiro'}
GROUPS = {
    'card': {'log_turn_index', 'log_prompt_tokens', 'log_prev_tool_calls', 'prev_tool_errors', 'compacted', 'subagent', 'images', 'log_latest_chars', 'templated', 'log_template_chars'},
    'template': {'templated', 'log_template_chars'},
    'confidence': {'confidence'},
}
OPTS = argparse.Namespace(unmatched_standard=False, lowconf_standard=False, fast_min_conf=0.0, fast_lookup_only=False, no_fast=set(), skip=set(), no_held=False)


def fnv(s: str) -> int:
    x = 2166136261
    for ch in s:
        x = ((x ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return x


# ---------- logistic regression (IRLS, L2 on the non-intercept weights) ----------

def solve(a: list[list[float]], b: list[float]) -> list[float]:
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        piv = m[c][c] or 1e-12
        for r in range(n):
            if r != c and m[r][c]:
                f = m[r][c] / piv
                for k in range(c, n + 1):
                    m[r][k] -= f * m[c][k]
    return [m[i][n] / (m[i][i] or 1e-12) for i in range(n)]


def sigmoid(z: float) -> float:
    return 1 / (1 + math.exp(-z)) if z >= 0 else math.exp(z) / (1 + math.exp(z))


def fit_logistic(xs: list[list[float]], ys: list[int], l2: float, iters: int = 50) -> list[float]:
    d = len(xs[0]) + 1
    w = [0.0] * d
    rows = [[1.0] + x for x in xs]
    for _ in range(iters):
        h = [[0.0] * d for _ in range(d)]
        g = [0.0] * d
        for r, y in zip(rows, ys):
            p = sigmoid(sum(wi * ri for wi, ri in zip(w, r)))
            q = p * (1 - p)
            for i in range(d):
                g[i] += (y - p) * r[i]
                ri = r[i] * q
                if ri:
                    hi = h[i]
                    for j in range(d):
                        hi[j] += ri * r[j]
        for i in range(1, d):
            g[i] -= l2 * w[i]
            h[i][i] += l2
        step = solve(h, g)
        w = [wi + si for wi, si in zip(w, step)]
        if max(abs(s) for s in step) < 1e-9:
            break
    return w


class Head:
    """A fitted head on raw features: p = sigmoid(intercept + Σ weights[k] * x[k]) (as map.ts learnedScore)."""

    def __init__(self, names: list[str], rows: list[dict], ys: list[int], l2: float):
        cols = []
        for k in names:
            v = [r['x'][k] for r in rows]
            mu = sum(v) / len(v)
            sd = math.sqrt(sum((x - mu) ** 2 for x in v) / len(v))
            if sd > 1e-9:
                cols.append((k, mu, sd))
        w = fit_logistic([[(r['x'][k] - mu) / sd for k, mu, sd in cols] for r in rows], ys, l2)
        self.weights = {k: w[i + 1] / sd for i, (k, mu, sd) in enumerate(cols)}
        self.intercept = w[0] - sum(w[i + 1] * mu / sd for i, (k, mu, sd) in enumerate(cols))
        self.threshold = 0.5

    def p(self, r: dict) -> float:
        z = self.intercept
        for k in sorted(self.weights):
            z += self.weights[k] * r['x'][k]
        return sigmoid(z)

    def frozen(self, digits: int = 4) -> dict:
        return {'intercept': round(self.intercept, digits), 'weights': {k: round(v, digits) for k, v in sorted(self.weights.items()) if round(v, digits) != 0},
                'threshold': round(self.threshold, digits)}


# ---------- data ----------

def load(labels: list[str], label_arg: str):
    feats = [json.loads(l) for lab in labels for l in open(os.path.join(HERE, 'results', f'features-{lab}.jsonl')) if l.strip()]
    sets = sorted({r['set'] for r in feats})
    gold: dict[str, dict] = {}
    for s in sets:
        if label_arg.endswith('.jsonl'):
            gold.update({d['id']: {'tier': d['tier']} for d in map(json.loads, open(label_arg)) if d.get('tier') in S.RANK})
        else:
            S.HERE = os.path.dirname(V23.rstrip('/'))
            S.LABEL_SUFFIX = SUFFIX[s]
            gold.update(S.load_gold(label_arg))
    turns = {s: [t for t in S.jl(os.path.join(V23, TURNS[s])) if S.split_of(t['session']) == 'dev'] for s in sets}
    return feats, gold, turns


def served(turns: list[dict], ops: dict[str, str | None]) -> dict:
    run = {i: ({'status': 'ok', 'proposedTier': op} if op else {'status': 'ok', 'skipped': 'none'}) for i, op in ops.items()}
    return S.serve(turns, run, OPTS)


def train_head(rows: list[dict], gold: dict, names: list[str], l2: float, turns_by_set: dict) -> Head:
    tr = [r for r in rows if r.get(ELIGIBLE) and r['id'] in gold]
    head = Head(names, tr, [1 if gold[r['id']]['tier'] == 'fast' else 0 for r in tr], l2)
    # threshold: highest served exact on the training rows
    # per set: a set's training fast precision may not fall below its hand mapping's (one set cannot pay for another)
    floors = {}
    for st in {r['set'] for r in tr}:
        hf = [r for r in tr if r['set'] == st and r['op'] == 'fast']
        floors[st] = sum(1 for r in hf if gold[r['id']]['tier'] == 'fast') / len(hf) if hf else 0.0
    ids = {r['id'] for r in rows}
    best = None
    for k in range(10, 100, 2):
        tau = k / 100
        pred = [r for r in tr if head.p(r) >= tau]
        if not pred:
            continue
        if any(sum(1 for r in ps if gold[r['id']]['tier'] == 'fast') < floors[st] * len(ps)
               for st in floors for ps in [[r for r in pred if r['set'] == st]] if ps):
            continue
        head.threshold = tau
        ex = []
        for s, ts in turns_by_set.items():
            t2 = [t for t in ts if t['id'] in ids]
            sv = served(t2, apply(rows, head))
            ex += [sv[t['id']]['served'] == gold[t['id']]['tier'] for t in t2 if t['id'] in gold]
        score = sum(ex) / max(1, len(ex))
        if best is None or score > best[0] + 1e-12:
            best = (score, tau)
    head.threshold = best[1] if best else 0.99
    return head


UNION = False
ELIGIBLE = 'eligible'


def apply(rows: list[dict], head: Head | None) -> dict[str, str | None]:
    """Eligible rows: fast at p ≥ threshold, else standard (--union: or when the hand mapping says fast)."""
    def one(r: dict) -> str | None:
        if not head or not r.get(ELIGIBLE):
            return r['op']
        return 'fast' if head.p(r) >= head.threshold or (UNION and r['op'] == 'fast') else 'standard'
    return {r['id']: one(r) for r in rows}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--features', required=True)
    ap.add_argument('--labels', default='agree')
    ap.add_argument('--drop', default='')
    ap.add_argument('--folds', type=int, default=5)
    ap.add_argument('--l2', type=float, default=1.0)
    ap.add_argument('--reps', type=int, default=2000)
    ap.add_argument('--freeze', default='')
    ap.add_argument('--union', action='store_true', help='keep the hand fast opinions too (fast = hand fast OR head)')
    ap.add_argument('--low-confidence', action='store_true', help='the head also decides below the confidence threshold')
    a = ap.parse_args()
    if a.low_confidence:
        global ELIGIBLE
        ELIGIBLE = 'eligibleLow'
    global UNION
    UNION = a.union
    S.REPS = a.reps
    feats, gold, turns = load(a.features.split(','), a.labels)
    drop = set().union(*(GROUPS[g] for g in filter(None, a.drop.split(','))))
    names = [k for k in feats[0]['x'] if k not in drop] if any('x' in r for r in feats) else []
    names = sorted({k for r in feats if 'x' in r for k in r['x'] if k not in drop})

    # out-of-fold learned opinions
    oof: dict[str, str | None] = {}
    taus = []
    for k in range(a.folds):
        train = [r for r in feats if fnv(r['session']) % a.folds != k]
        test = [r for r in feats if fnv(r['session']) % a.folds == k]
        head = train_head(train, gold, names, a.l2, turns)
        taus.append(head.threshold)
        oof.update(apply(test, head))
    hand = {r['id']: r['op'] for r in feats}

    out = {'labels': a.labels, 'drop': sorted(drop), 'features': len(names), 'folds': a.folds, 'thresholds': taus, 'sets': {}}
    print(f"labels={a.labels} drop={sorted(drop) or '-'} features={len(names)} folds={a.folds} fold thresholds={taus}")
    for s, ts in turns.items():
        ids_in = {r['id'] for r in feats if r['set'] == s}
        t2 = [t for t in ts if t['id'] in ids_in]
        sv_h, sv_l = served(t2, {i: hand[i] for i in ids_in}), served(t2, {i: oof[i] for i in ids_in})
        ids = [t['id'] for t in t2 if t['id'] in gold]
        sess = {t['id']: t['session'] for t in t2}
        res = {}
        for name, sv in (('hand', sv_h), ('learned', sv_l)):
            m = S.metrics(ids, sv, gold)
            res[name] = m
            print(f"  {s:5s} {name:8s} n={m['n']} exact={m['exact']:.3f} wrongFast={m['wrongFast']:.3f} under={m['under']:.3f} "
                  f"fast n={m['fastN']} prec={m['fastPrec']:.3f} rec={m['fastRecall']:.3f} cost={m['cost']:.3f} (oracle {m['costOracle']:.3f})")
        for key in ('exact', 'wrongFast', 'under', 'cost', 'fastRecall'):
            d = S.boot(ids, sess, lambda x, key=key: S.metrics(x, sv_l, gold)[key] - S.metrics(x, sv_h, gold)[key])
            pt = res['learned'][key] - res['hand'][key]
            res[f'diff/{key}'] = {'diff': pt, 'ci': d}
            print(f'        learned − hand {key}: {pt:+.3f} [{d[0]:+.3f},{d[1]:+.3f}]')
        out['sets'][s] = {k: ({kk: vv for kk, vv in v.items() if kk != 'fastPrecCI'} if isinstance(v, dict) else v) for k, v in res.items()}

    if a.freeze:
        head = train_head(feats, gold, names, a.l2, turns)
        block = {'heads': {'fast': {**head.frozen(), **({'belowThreshold': True} if a.low_confidence else {}), **({'orHand': True} if a.union else {})}}}
        with open(a.freeze, 'w') as fh:
            json.dump({'learned': block, 'fit': {k: out[k] for k in ('labels', 'drop', 'features', 'folds', 'thresholds')}}, fh, indent=1)
        print(f'frozen head (all dev rows): threshold {head.threshold}, {len(block["heads"]["fast"]["weights"])} weights -> {a.freeze}')
        out['frozen'] = block
        # parity input for parity.ts: every row's opinion under the frozen (rounded) head, as fit.py applies it
        fr = block['heads']['fast']
        rounded = Head.__new__(Head)
        rounded.intercept, rounded.weights, rounded.threshold = fr['intercept'], fr['weights'], fr['threshold']
        with open(a.freeze.replace('.json', '') + '-ops.jsonl', 'w') as fh:
            for r in feats:
                fh.write(json.dumps({'id': r['id'], 'op': apply([r], rounded)[r['id']], **({'p': rounded.p(r)} if 'x' in r else {})}) + '\n')


if __name__ == '__main__':
    main()
