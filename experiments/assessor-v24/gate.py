#!/usr/bin/env python3
"""Stage gate report (eval v2.4 C4): aggregates only, no text.

  python3 gate.py --stage pilot

Label mix, Q1/Q2 order consistency (gate >= 85%), primary vs the "fast sufficient" variant, labels by kind, carrier and
turn length, truncations and parameter edits, cost per stage from the ledgers and per-turn means. Agreement between
judges and with hindsight: agree.py.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, 'results')
V23 = os.environ.get('V23_RESULTS', os.path.join(HERE, '..', 'assessor-v23', 'results'))


def jl(path: str) -> list[dict[str, Any]]:
    if not os.path.exists(path):
        return []
    with open(path) as fh:
        return [json.loads(l) for l in fh if l.strip()]


def pct(c: collections.Counter, n: int) -> str:
    return ', '.join(f'{k} {v} ({v / n:.0%})' for k, v in c.most_common()) if n else '-'


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--stage', default='pilot')
    a = ap.parse_args()
    sessions = set(open(os.path.join(RES, 'stages', f'{a.stage}.txt')).read().strip().split(','))
    index = {r['id']: r for r in jl(os.path.join(RES, 'requests', 'index.jsonl')) if r['session'] in sessions and r['status'] == 'ok'}
    turns = {t['id']: t for t in jl(os.path.join(V23, 'sessions', 'turns.jsonl')) if t['id'] in index}
    gen = [r for r in jl(os.path.join(RES, 'cf', 'gen.jsonl')) if r['id'] in index]
    print(f'stage {a.stage}: {len(index)} turns, {len({r["session"] for r in index.values()})} conversations')
    ok = [r for r in gen if r['ok']]
    print(f'generation: {len(ok)}/{len(gen)} ok; failures: {collections.Counter((r["reason"] or "")[:60] for r in gen if not r["ok"]).most_common(5)}')
    for tier in ('fast', 'standard'):
        rows = [r for r in ok if r['tier'] == tier]
        if not rows:
            continue
        out = sorted(r['usage']['output'] for r in rows)
        print(f'  {tier}: output tokens mean {sum(out) / len(out):.0f} p50 {out[len(out) // 2]} p90 {out[int(len(out) * .9)]} max {out[-1]}; '
              f'stop {dict(collections.Counter(r["stopReason"] for r in rows))}; paramEdits {dict(collections.Counter(e for r in rows for e in r["paramEdits"]))}; '
              f'thinking chars>0 {sum(1 for r in rows if (r["step"] or {}).get("thinkingChars"))}; cost ${sum(r.get("costUsd") or 0 for r in rows):.2f} '
              f'(${sum(r.get("costUsd") or 0 for r in rows) / len(rows):.4f}/turn); cache read share {sum(r["usage"]["cacheRead"] for r in rows) / max(1, sum(r["usage"]["cacheRead"] + r["usage"]["cacheWrite"] + r["usage"]["input"] for r in rows)):.2f}')
    for judge in ('opus', 'astra'):
        jr = [r for r in jl(os.path.join(RES, 'cf', f'judge-{judge}.jsonl')) if r['id'] in index]
        if not jr:
            continue
        labs = {r['id']: r for r in jl(os.path.join(RES, 'labels', f'cf-{judge}.jsonl')) if r['id'] in index}
        suff = {r['id']: r for r in jl(os.path.join(RES, 'labels', f'cf-{judge}-suff.jsonl')) if r['id'] in index}
        n = len(labs)
        print(f'\njudge {judge}: {len(jr)} calls ({sum(1 for r in jr if not r["ok"])} invalid), ${sum(r.get("costUsd") or 0 for r in jr):.2f} '
              f'(${sum(r.get("costUsd") or 0 for r in jr) / max(1, len({r["id"] for r in jr})):.4f}/turn), {len(jr) / max(1, len({r["id"] for r in jr})):.2f} calls/turn')
        q1 = [r for r in labs.values() if r.get('q1')]
        q2 = [r for r in labs.values() if r.get('q2')]
        c1 = sum(1 for r in q1 if r['q1']['ab'] == r['q1']['ba'])
        c2 = sum(1 for r in q2 if r['q2']['ab'] == r['q2']['ba'])
        print(f'  order consistency: Q1 {c1}/{len(q1)} = {c1 / max(1, len(q1)):.1%}; Q2 {c2}/{len(q2)} = {c2 / max(1, len(q2)):.1%}  (gate >= 85%)')
        print(f'  Q1 verdicts (fast side, ab|ba): {dict(collections.Counter((r["q1"]["ab"], r["q1"]["ba"]) for r in q1).most_common(9))}')
        print(f'  labels: {pct(collections.Counter(r["tier"] for r in labs.values()), n)}')
        print(f'  basis: {dict(collections.Counter(r["basis"] for r in labs.values()))}')
        if suff:
            ch = collections.Counter((labs[i]['tier'], suff[i]['tier']) for i in labs if i in suff and labs[i]['tier'] != suff[i]['tier'])
            print(f'  "fast sufficient" variant: labels {pct(collections.Counter(r["tier"] for r in suff.values()), len(suff))}; changed {sum(ch.values())} turns {dict(ch)}')
        by_kind = collections.defaultdict(collections.Counter)
        by_len = collections.defaultdict(collections.Counter)
        by_carrier = collections.defaultdict(collections.Counter)
        for i, r in labs.items():
            t = turns.get(i, {})
            by_kind['subagent' if r['lineage'] == 'subagent' else r['kind']][r['tier']] += 1
            tc = t.get('hindsight', {}).get('toolCalls', 0)
            by_len['0-2' if tc <= 2 else '3-10' if tc <= 10 else '11-40' if tc <= 40 else '41+'][r['tier']] += 1
            by_carrier[r.get('carrier')][r['tier']] += 1
        for name, d in (('kind', by_kind), ('original tool calls in the turn', by_len), ('carrier', by_carrier)):
            print(f'  by {name}: ' + '; '.join(f'{k}: {pct(v, sum(v.values()))}' for k, v in sorted(d.items(), key=lambda x: str(x[0]))))
    led = os.path.join(RES, f'ledger-v24-{a.stage}.json')
    if os.path.exists(led):
        d = json.load(open(led))
        print(f'\nledger {a.stage}: spent ${d["spentUsd"]:.2f} of cap ${d["capUsd"]}')


if __name__ == '__main__':
    main()
