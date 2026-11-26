#!/usr/bin/env python3
"""Deterministic stage split of the dev conversations (eval v2.4 C4): smoke (fixed, also part of the pilot), pilot, rest.

  python3 stages.py [--pilot-root-turns 200] [--pilot-subagents 40]  -> results/stages/{smoke,pilot,rest}.txt (session ids)

Root sessions are taken whole, in FNV-1a order of their id, until the pilot has at least --pilot-root-turns root turns;
sub-agent conversations (one turn each) in the same order. Every rebuilt dev conversation lands in exactly one stage.
"""
from __future__ import annotations

import argparse
import collections
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SMOKE = ['5657c0e98a', '0328f20d19', '3c46e80a16', '5d64c3301b', '5de99db381']


def fnv(s: str) -> int:
    x = 2166136261
    for ch in s:
        x = ((x ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return x


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--pilot-root-turns', type=int, default=200)
    ap.add_argument('--pilot-subagents', type=int, default=40)
    a = ap.parse_args()
    rows = [json.loads(l) for l in open(os.path.join(HERE, 'results', 'requests', 'index.jsonl')) if l.strip()]
    ok = [r for r in rows if r['status'] == 'ok' and r['split'] == 'dev']
    n = collections.Counter((r['session'], r['lineage']) for r in ok)
    roots = sorted((s for (s, l) in n if l == 'root' and s not in SMOKE), key=fnv)
    subs = sorted((s for (s, l) in n if l == 'subagent' and s not in SMOKE), key=fnv)
    pilot, k = [], 0
    for s in roots:
        if k >= a.pilot_root_turns:
            break
        pilot.append(s)
        k += n[(s, 'root')]
    pilot += subs[: a.pilot_subagents]
    pilot += SMOKE  # the smoke turns are re-judged with the pilot's settings (generation is reused)
    rest = [s for s in roots + subs if s not in pilot]
    os.makedirs(os.path.join(HERE, 'results', 'stages'), exist_ok=True)
    for name, ss in (('smoke', SMOKE), ('pilot', pilot), ('rest', rest)):
        with open(os.path.join(HERE, 'results', 'stages', f'{name}.txt'), 'w') as fh:
            fh.write(','.join(ss))
        turns = sum(n[(s, 'root')] + n[(s, 'subagent')] for s in ss)
        print(f"{name}: {len(ss)} conversations ({sum(1 for s in ss if (s, 'root') in n)} root sessions), {turns} turns")


if __name__ == '__main__':
    main()
