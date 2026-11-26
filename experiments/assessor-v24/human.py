#!/usr/bin/env python3
"""Human calibration labels for eval v2.4 (C2). Terminal only: no sockets, no network, nothing leaves this machine.

  python3 human.py sample [--n 100] [--seed 20261117]   draw the stratified sample (ids only) -> results/human/sample.jsonl
  python3 human.py label                                 pass 1: you give the tier each turn needed  -> results/human/labels.jsonl
  python3 human.py compare                               pass 2 (optional): fast vs standard next step, shuffled A/B
  python3 human.py status                                progress

Pass 1 shows the end of the conversation, the turn's request and what the agent then did (as the hindsight judges saw
it), and asks which tier the work needed: f = fast (a small cheap model would have done it as well), s = standard
(a competent mid-tier coding model), r = frontier (clearly needs the strongest model). Then your confidence (1 low,
2 medium, 3 high) and an optional note. Keys at any prompt: k skip, b back one, q save and quit. Answers are written
immediately; rerun to continue where you stopped. The labels are yours and stay in results/ (gitignored).

The sample is drawn BEFORE any counterfactual label exists (strata: turn kind x the v2.3 hindsight label), so it is not
selected on the labels it is compared with.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import random
import shutil
import sys
import textwrap
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, 'results')
HUM = os.path.join(RES, 'human')
V23 = os.environ.get('V23_RESULTS', os.path.join(HERE, '..', 'assessor-v23', 'results'))
TIERS = {'f': 'fast', 's': 'standard', 'r': 'frontier'}


def jl(path: str) -> list[dict[str, Any]]:
    if not os.path.exists(path):
        return []
    with open(path) as fh:
        return [json.loads(l) for l in fh if l.strip()]


def hindsight() -> dict[str, str]:
    """id -> agreed hindsight tier, or 'split' when the two v2.3 judges disagree."""
    a = {r['id']: r['tier'] for r in jl(os.path.join(V23, 'labels', 'judge-opus.jsonl')) if r.get('ok')}
    b = {r['id']: r['tier'] for r in jl(os.path.join(V23, 'labels', 'judge-astra.jsonl')) if r.get('ok')}
    return {i: (a[i] if a[i] == b[i] else 'split') for i in a.keys() & b.keys()}


def kind_group(r: dict[str, Any]) -> str:
    return 'subagent' if r['lineage'] == 'subagent' else ('human' if r['kind'] == 'human' else 'notification' if r['kind'] == 'notification' else 'other')


def cmd_sample(a: argparse.Namespace) -> None:
    out = os.path.join(HUM, 'sample.jsonl')
    if os.path.exists(out) and not a.force:
        sys.exit(f'{out} exists (use --force to redraw; labels refer to it)')
    hs = hindsight()
    rows = [r for r in jl(os.path.join(RES, 'requests', 'index.jsonl')) if r['status'] == 'ok' and r['split'] == 'dev' and r['id'] in hs]
    strata: dict[tuple[str, str], list[dict[str, Any]]] = collections.defaultdict(list)
    for r in rows:
        strata[(kind_group(r), hs[r['id']])].append(r)
    rnd = random.Random(a.seed)
    for v in strata.values():
        v.sort(key=lambda r: r['id'])
        rnd.shuffle(v)
    # Allocation: a floor of 3 per stratum (or all of it), the rest proportional to size (largest remainder).
    alloc = {k: min(3, len(v)) for k, v in strata.items()}
    left = a.n - sum(alloc.values())
    total = sum(len(v) - alloc[k] for k, v in strata.items())
    quota = {k: (len(v) - alloc[k]) * left / total for k, v in strata.items()} if total else {}
    for k in quota:
        alloc[k] += int(quota[k])
    rem = sorted(quota, key=lambda k: quota[k] - int(quota[k]), reverse=True)
    i = 0
    while sum(alloc.values()) < a.n and rem:
        k = rem[i % len(rem)]
        if alloc[k] < len(strata[k]):
            alloc[k] += 1
        i += 1
    picked = [(k, r) for k, v in strata.items() for r in v[: alloc[k]]]
    rnd.shuffle(picked)
    os.makedirs(HUM, exist_ok=True)
    with open(out, 'w') as fh:
        for n, (k, r) in enumerate(picked):
            fh.write(json.dumps({'order': n, 'id': r['id'], 'session': r['session'], 'stratum': f'{k[0]}/{k[1]}',
                                 'weight': len(strata[k]) / alloc[k]}) + '\n')
    print(f'{len(picked)} turns from {len(rows)} (seed {a.seed}); strata: ' + ', '.join(f'{k[0]}/{k[1]} {alloc[k]}/{len(v)}' for k, v in sorted(strata.items())))


# ---------- rendering (local terminal only) ----------

def width() -> int:
    return min(110, shutil.get_terminal_size((100, 30)).columns)


def clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + f' …[{len(s)} chars]'


def wrap(s: str, indent: str = '  ') -> str:
    w = width()
    return '\n'.join(textwrap.fill(line, w, initial_indent=indent, subsequent_indent=indent) if line.strip() else '' for line in s.split('\n'))


def blocks(c: Any) -> list[Any]:
    return c if isinstance(c, list) else [{'type': 'text', 'text': c}] if isinstance(c, str) else []


def tail_text(doc: dict[str, Any], turn: dict[str, Any], budget: int) -> str:
    ents = [doc['entries'][h] for h in turn['entries']]
    last_a = max((i for i, m in enumerate(ents) if m['role'] == 'assistant'), default=-1)
    parts, used = [], 0
    for m in reversed(ents[: last_a + 1]):
        lines = []
        for b in blocks(m.get('content')):
            if not isinstance(b, dict):
                continue
            if b.get('type') == 'text':
                lines.append(f"[harness context, {len(b.get('text', ''))} chars]" if m['role'] == 'system' else clip(b.get('text', ''), 1500))
            elif b.get('type') == 'tool_use':
                lines.append(f"→ {b.get('name')} {clip(json.dumps(b.get('input'), ensure_ascii=False), 300)}")
            elif b.get('type') == 'tool_result':
                c = b.get('content')
                t = c if isinstance(c, str) else '\n'.join(x.get('text', '') for x in c if isinstance(x, dict)) if isinstance(c, list) else ''
                lines.append(f"← result{' [ERROR]' if b.get('is_error') else ''}: {clip(t, 300)}")
        if not lines:
            continue
        who = 'AGENT' if m['role'] == 'assistant' else 'harness' if m['role'] == 'system' else 'USER'
        s = f'{who}: ' + '\n'.join(lines)
        parts.append(s)
        used += len(s)
        if used > budget:
            break
    return '\n\n'.join(reversed(parts))


def show_turn(n: int, total: int, s: dict[str, Any], t: dict[str, Any], doc: dict[str, Any], turn: dict[str, Any], more: bool) -> None:
    h = t['hindsight']
    bar = '═' * width()
    print(f'\n{bar}\n turn {n + 1}/{total}   kind: {t["kind"]}{" (sub-agent: " + (t.get("agentType") or "?") + ")" if t["lineage"] == "subagent" else ""}'
          f'   user turn #{t["turnIndex"]}   prompt ~{t["estPromptTokens"] // 1000}k tokens{"   [typed while the agent was working]" if turn.get("carrier") == "tool-result" else ""}\n{bar}')
    if t.get('first') and t['turnIndex'] > 0:
        print('FIRST MESSAGE OF THE CONVERSATION:\n' + wrap(clip(t['first'], 600)))
    print('\nEND OF THE CONVERSATION SO FAR:\n' + wrap(tail_text(doc, turn, 12000 if more else 3500) or '(start of the conversation)'))
    print('\n' + '─' * width() + '\nREQUEST OF THIS TURN:\n' + wrap(clip(t['latest'], 6000)))
    seq = '\n'.join(f"  {x[0]}{' ' + clip(x[1], 90) if x[1] else ''}{' [ERROR]' if x[2] else ''}" for x in h['tools'][: (70 if more else 25)])
    print('\n' + '─' * width() + f"\nWHAT THE AGENT THEN DID: {h['toolCalls']} tool calls ({h['toolErrors']} errors), {h['edits']} edits on {h['nFilesEdited']} files, "
          f"{h['spawns']} sub-agents, {h['outputTokens']} output tokens{'; the user interrupted' if t.get('interrupted') else ''}")
    if seq:
        print(seq + (f"\n  … ({h['toolCalls'] - min(len(h['tools']), 70 if more else 25)} more)" if h['toolCalls'] > (70 if more else 25) else ''))
    print('FINAL ANSWER:\n' + wrap(clip(h['finalHead'], 2500 if more else 900)))
    if t.get('nextUserHead'):
        print(f"USER'S NEXT MESSAGE ({t.get('nextUserKind')}):\n" + wrap(clip(t['nextUserHead'], 300)))


def ask(prompt: str, valid: set[str]) -> str:
    while True:
        try:
            x = input(prompt).strip().lower()
        except EOFError:
            return 'q'
        if x in valid:
            return x
        print(f'  one of: {", ".join(sorted(valid))}')


def load_all() -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], dict[str, Any]]:
    sample = jl(os.path.join(HUM, 'sample.jsonl'))
    if not sample:
        sys.exit('no sample: run `python3 human.py sample` first')
    turns = {t['id']: t for t in jl(os.path.join(V23, 'sessions', 'turns.jsonl'))}
    docs: dict[str, Any] = {}
    return sample, turns, docs


def doc_turn(docs: dict[str, Any], session: str, tid: str) -> tuple[dict[str, Any], dict[str, Any]]:
    if session not in docs:
        with open(os.path.join(RES, 'requests', f'{session}.json')) as fh:
            docs[session] = json.load(fh)
    d = docs[session]
    return d, next(x for x in d['turns'] if x['id'] == tid)


def append(row: dict[str, Any]) -> None:
    os.makedirs(HUM, exist_ok=True)
    with open(os.path.join(HUM, 'labels.jsonl'), 'a') as fh:
        fh.write(json.dumps({**row, 'ts': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}, ensure_ascii=False) + '\n')


def latest(pass_: int) -> dict[str, dict[str, Any]]:
    """The last answer per id for a pass (a later answer, e.g. after `b`, replaces an earlier one)."""
    out: dict[str, dict[str, Any]] = {}
    for r in jl(os.path.join(HUM, 'labels.jsonl')):
        if r.get('pass') == pass_:
            out[r['id']] = r
    return out


def cmd_label(_: argparse.Namespace) -> None:
    sample, turns, docs = load_all()
    print(__doc__.split('Pass 1 shows')[1].split('The sample is drawn')[0].strip())
    i = 0
    while i < len(sample):
        done = latest(1)
        s = sample[i]
        if s['id'] in done and done[s['id']].get('tier') != 'skip':
            i += 1
            continue
        t = turns[s['id']]
        doc, turn = doc_turn(docs, s['session'], s['id'])
        more = False
        while True:
            show_turn(i, len(sample), s, t, doc, turn, more)
            x = ask('\ntier needed? [f]ast [s]tandard f[r]ontier   (m more context, k skip, b back, q quit): ', {'f', 's', 'r', 'm', 'k', 'b', 'q'})
            if x == 'm':
                more = True
                continue
            break
        if x == 'q':
            break
        if x == 'b':
            i = max(0, i - 1)
            prev = sample[i]['id']
            append({'id': prev, 'pass': 1, 'tier': 'skip'})  # reopens it
            continue
        if x == 'k':
            append({'id': s['id'], 'pass': 1, 'tier': 'skip'})
            i += 1
            continue
        c = ask('confidence? [1] low [2] medium [3] high: ', {'1', '2', '3', 'q'})
        if c == 'q':
            break
        try:
            note = input('note (optional, enter to skip): ').strip()
        except EOFError:
            note = ''
        append({'id': s['id'], 'pass': 1, 'tier': TIERS[x], 'confidence': int(c), **({'note': note} if note else {})})
        i += 1
    cmd_status(_)


def cmd_compare(_: argparse.Namespace) -> None:
    sample, turns, docs = load_all()
    gen: dict[str, dict[str, Any]] = collections.defaultdict(dict)
    for r in jl(os.path.join(RES, 'cf', 'gen.jsonl')):
        if r.get('ok'):
            gen[r['id']][r['tier']] = r
    todo = [s for s in sample if 'fast' in gen[s['id']] and 'standard' in gen[s['id']]]
    print(f'pass 2: {len(todo)} of {len(sample)} sampled turns have both next steps. For each: is A as good as B for this turn?')
    for n, s in enumerate(todo):
        if s['id'] in latest(2):
            continue
        t = turns[s['id']]
        doc, turn = doc_turn(docs, s['session'], s['id'])
        show_turn(n, len(todo), s, t, doc, turn, False)
        a_is_fast = random.Random(f"{s['id']}/pass2").random() < 0.5
        steps = [gen[s['id']]['fast'], gen[s['id']]['standard']]
        if not a_is_fast:
            steps.reverse()
        for name, g in zip('AB', steps):
            st = g.get('step') or {}
            tools = '\n'.join(f"  - {x['name']} {clip(json.dumps(x['input'], ensure_ascii=False), 600)}" for x in st.get('tools', []))
            print(f"\n{'─' * width()}\nNEXT STEP {name}:\n" + wrap(clip(st.get('text') or '(no text)', 3000)) + (f'\n proposed tool calls:\n{tools}' if tools else '\n (no tool calls)')
                  + ('\n [cut off at the output limit]' if g.get('stopReason') == 'max_tokens' else ''))
        x = ask('\n[a] A better  [b] B better  [e] equally good   (k skip, q quit): ', {'a', 'b', 'e', 'k', 'q'})
        if x == 'q':
            break
        if x == 'k':
            continue
        suff = ask('is the WORSE (or either, if equal) step still acceptable? [y/n]: ', {'y', 'n', 'q'})
        if suff == 'q':
            break
        append({'id': s['id'], 'pass': 2, 'aIsFast': a_is_fast, 'verdict': {'a': 'A', 'b': 'B', 'e': 'equal'}[x], 'worseAcceptable': suff == 'y'})
    cmd_status(_)


def cmd_status(_: argparse.Namespace) -> None:
    sample = jl(os.path.join(HUM, 'sample.jsonl'))
    p1 = {k: v for k, v in latest(1).items() if v.get('tier') != 'skip'}
    p2 = latest(2)
    print(f'sample {len(sample)}; pass 1 labelled {len(p1)} {dict(collections.Counter(v["tier"] for v in p1.values()))}; pass 2 {len(p2)}')


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('sample')
    s.add_argument('--n', type=int, default=100)
    s.add_argument('--seed', type=int, default=20261117)
    s.add_argument('--force', action='store_true')
    sub.add_parser('label')
    sub.add_parser('compare')
    sub.add_parser('status')
    a = ap.parse_args()
    {'sample': cmd_sample, 'label': cmd_label, 'compare': cmd_compare, 'status': cmd_status}[a.cmd](a)


if __name__ == '__main__':
    main()
