#!/usr/bin/env python3
"""Rebuilds, for each session turn of assessor-v23's export, the exact first API request of the turn (task: eval v2.4, C1).

Claude Code (2.1.3xx) writes every model request into the transcript in a deduplicated form:
  - `api-request-shape` {shapeHash, shape: {system, tools}}: the system blocks and full tool schemas;
  - `api-request` {querySource, shapeHash, params, keep, tail, cacheControl}: entries = previous request's
    entries[:keep] + tail, where each tail item is the sha256 of a message (sort-keyed compact JSON);
  - `api-request-blob` {hash, message}: messages that are not plain transcript records (e.g. `system`-role entries).
A tail hash resolves to a blob, to a transcript record's message, to an assistant message merged across its records
(one record per content block, same message id), or to consecutive tool-result user records merged into one message.
Entries map 1:1 to API messages (Claude Code's last cache breakpoint is always on the last entry); a `system`-role
entry is sent as a user-role message (see PREREG §Data).

Output (local only, results/ is gitignored; never print content):
  results/requests/<session>.json  {session, entries: {hash: message}, shapes: {shapeHash: shape}, turns: [...]}
  per turn: {id, kind, lineage, turnIndex, querySource, shapeHash, params, entries: [hash...], original: {...}}
  results/requests/index.jsonl     one line per turn: id, session, split, status, counts only (no text)

  python3 rebuild.py [--split dev|test|all] [--sessions n] [--projects ~/.claude/projects]
"""
from __future__ import annotations

import argparse
import collections
import glob
import hashlib
import json
import os
import sys
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
V23 = os.environ.get('V23_DIR', os.path.join(HERE, '..', 'assessor-v23'))
sys.path.insert(0, V23)
from sessions import h, kind_of, text_of  # noqa: E402  (the export's own turn detection)

MAIN_TREE_TURNS = os.path.join(HERE, '..', 'assessor-v23', 'results', 'sessions', 'turns.jsonl')  # local-only data


def split_of(session: str) -> str:
    x = 2166136261
    for ch in session:
        x = ((x ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return 'dev' if x % 100 < 50 else 'test'


def mhash(m: Any) -> str:
    return hashlib.sha256(json.dumps(m, separators=(',', ':'), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def blocks(c: Any) -> list[Any]:
    return c if isinstance(c, list) else [{'type': 'text', 'text': c}] if isinstance(c, str) else []


def read_file(path: str, lineage: str) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    """(turn requests in file order, entries by hash, shapes) of one transcript file."""
    recs = []
    with open(path, errors='replace') as fh:
        for line in fh:
            try:
                recs.append(json.loads(line))
            except Exception:
                continue
    blobs: dict[str, Any] = {}
    shapes: dict[str, Any] = {}
    cand: dict[str, Any] = {}
    amsg: dict[str, dict[str, Any]] = {}
    run: list[dict[str, Any]] = []  # consecutive user records (tool results, meta, text)

    def flush_run() -> None:
        # Every contiguous sub-run (up to 8 records) merged into one message, string content as one text block.
        for i in range(len(run)):
            for j in range(i + 1, min(len(run), i + 8) + 1):
                m = {'role': 'user', 'content': [b for r in run[i:j] for b in blocks(r['content'])]}
                cand[mhash(m)] = m
        run.clear()

    for o in recs:
        t = o.get('type')
        if t == 'api-request-blob' and isinstance(o.get('message'), dict):
            blobs[o['hash']] = o['message']
        elif t == 'api-request-shape' and isinstance(o.get('shape'), dict):
            shapes[o.get('shapeHash')] = o['shape']
        elif t == 'assistant' and isinstance(o.get('message'), dict):
            flush_run()
            m = o['message']
            mid = str(m.get('id') or o.get('uuid'))
            a = amsg.setdefault(mid, {'role': 'assistant', 'content': []})
            a['content'] = a['content'] + blocks(m.get('content'))
        elif t == 'user' and isinstance(o.get('message'), dict):
            m = {'role': 'user', 'content': o['message'].get('content')}
            cand[mhash(m)] = m
            run.append(m)
    flush_run()
    for a in amsg.values():
        cand[mhash(a)] = a
    entries = {**cand, **blobs}

    # Walk again: the main-chain requests and the turns (same rules as sessions.py), in file order.
    # The main chain: every repl_main_thread* source (the suffix follows the output style) in a root file, every
    # agent:* source in a sub-agent file. Side queries (titles, suggestions, ...) are other chains.
    prefix = ('repl_main_thread', 'sdk') if lineage == 'root' else ('agent:',)
    chain: list[str] = []
    reqs: list[dict[str, Any]] = []      # {pos, entries, rec}
    firsts: list[tuple[int, str]] = []   # (pos, assistant message id) of each new assistant message
    seen_mid: set[str] = set()
    turns: list[dict[str, Any]] = []
    for pos, o in enumerate(recs):
        t = o.get('type')
        if t == 'api-request' and str(o.get('querySource') or '').startswith(prefix):
            chain = chain[: int(o.get('keep') or 0)] + list(o.get('tail') or [])
            reqs.append({'pos': pos, 'entries': chain, 'rec': o})
            continue
        if t == 'assistant' and isinstance(o.get('message'), dict):
            mid = str(o['message'].get('id') or o.get('uuid'))
            if mid not in seen_mid:
                seen_mid.add(mid)
                firsts.append((pos, mid))
            continue
        if t != 'user' or not isinstance(o.get('message'), dict):
            continue
        if lineage == 'root' and o.get('isSidechain'):
            continue
        text, _, tr = text_of(o['message'].get('content'))
        if tr or o.get('isMeta'):
            continue
        text = text.strip()
        kind = kind_of(text, bool(o.get('isCompactSummary')))
        if kind is None or text == '':
            continue
        turns.append({'pos': pos, 'uuid': str(o.get('uuid')), 'kind': kind, '_text': text})

    # A turn's request = the first main-chain request, after the previous turn's request, whose entries after the
    # last assistant entry contain the turn's text. Claude Code may write that request record before the user record;
    # a message typed while the agent works arrives inside a tool-result entry (queued), a notification inside a
    # system-role entry.
    k = 0
    for ti, tr in enumerate(turns):
        needle = tr.pop('_text')[:2000]
        # Window: after the previous turn's request, before the record of the turn after next (a request written
        # before its user record is still found; a far later request that merely quotes the text is not).
        limit = turns[ti + 2]['pos'] if ti + 2 < len(turns) else len(recs)
        for j in range(k, len(reqs)):
            if reqs[j]['pos'] >= limit:
                break
            seq = reqs[j]['entries']
            # A new chain (keep 0: session start, after a compaction) carries the turn anywhere in it.
            tail_txt, where = after_last_assistant(entries, seq, whole=int(reqs[j]['rec'].get('keep') or 0) == 0)
            if where is None:
                continue
            if needle in tail_txt:
                r = reqs[j]['rec']
                tr.update(querySource=r.get('querySource'), shapeHash=r.get('shapeHash'), params=r.get('params') or {}, entries=list(seq), carrier=where)
                pos = reqs[j]['pos']
                nxt = next(((p, mid) for p, mid in firsts if p > pos), None)
                if nxt and nxt[1] in amsg:
                    m = amsg[nxt[1]]
                    rec = recs[nxt[0]]['message']
                    tr['original'] = {'messageId': nxt[1], 'model': rec.get('model'), 'hash': mhash(m)}
                    entries[tr['original']['hash']] = m
                    # The next request of the chain, if any, should carry it right after this request's entries.
                    later = reqs[j + 1]['entries'] if j + 1 < len(reqs) else None
                    tr['original']['verified'] = bool(later and len(later) > len(seq) and later[len(seq)] == tr['original']['hash'])
                k = j + 1
                break
    for tr in turns:
        tr.pop('pos', None)
    return turns, entries, shapes


def after_last_assistant(entries: dict[str, Any], seq: list[str], whole: bool = False) -> tuple[str, str | None]:
    """(the text of the entries after the last assistant entry, which carried the user turn), or ('', None) when one
    of those entries is unknown. `where`: 'user' (a user text entry), 'tool-result' (an entry with tool results:
    a queued message) or 'system' (a system-role entry only)."""
    parts: list[str] = []
    kinds: set[str] = set()
    for hh in reversed(seq):
        m = entries.get(hh)
        if m is None:
            return '', None
        if m.get('role') == 'assistant':
            if whole:
                continue
            break
        bl = blocks(m.get('content'))
        parts.append('\n'.join(b.get('text', '') for b in bl if isinstance(b, dict) and b.get('type') == 'text'))
        if m.get('role') == 'system':
            kinds.add('system')
        elif any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in bl):
            kinds.add('tool-result')
        else:
            kinds.add('user')
    where = 'tool-result' if 'tool-result' in kinds else 'user' if 'user' in kinds else 'system'
    return '\n'.join(reversed(parts)), where


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--projects', default=os.path.expanduser('~/.claude/projects'))
    ap.add_argument('--turns', default=os.environ.get('V23_TURNS', MAIN_TREE_TURNS))
    ap.add_argument('--split', default='dev')
    ap.add_argument('--sessions', type=int, default=0, help='only the first n root sessions (sorted by id hash)')
    ap.add_argument('--only', default='', help='comma-separated session hashes')
    ap.add_argument('--out', default=os.path.join(HERE, 'results', 'requests'))
    a = ap.parse_args()
    turns = [json.loads(l) for l in open(a.turns) if l.strip()]
    turns = [t for t in turns if a.split == 'all' or split_of(t['session']) == a.split]
    want = collections.defaultdict(list)
    for t in turns:
        want[t['session']].append(t)
    roots = sorted({t['session'] for t in turns if t['lineage'] == 'root'})
    if a.only:
        keep = set(a.only.split(','))
        roots = [s for s in roots if s in keep]
        subs_ok = keep
    elif a.sessions:
        roots = roots[: a.sessions]
        subs_ok = None
    else:
        subs_ok = None
    root_set = set(roots)
    os.makedirs(a.out, exist_ok=True)
    stats = collections.Counter()
    index: list[dict[str, Any]] = []
    for d in sorted(os.listdir(a.projects)):
        for f in sorted(glob.glob(os.path.join(a.projects, d, '*.jsonl'))):
            session = os.path.basename(f)[:-6]
            sh = h(session, n=10)
            files: list[tuple[str, str, str]] = []
            if sh in root_set:
                files.append((f, sh, 'root'))
            for sf in sorted(glob.glob(os.path.join(a.projects, d, session, 'subagents', '*.jsonl'))):
                ssh = h(session + '/' + os.path.basename(sf), n=10)
                if ssh in want and (subs_ok is None and (not a.sessions or sh in root_set) or (subs_ok is not None and ssh in subs_ok)):
                    files.append((sf, ssh, 'subagent'))
            for path, shash, lineage in files:
                reqs, entries, shapes = read_file(path, lineage)
                raw_session = session if lineage == 'root' else session + '/' + os.path.basename(path)
                by_id = {h(raw_session, r['uuid']): r for r in reqs}
                kept_turns = []
                used: set[str] = set()
                for t in want[shash]:
                    r = by_id.get(t['id'])
                    st = 'ok'
                    if r is None:
                        st = 'no-turn'
                    elif 'entries' not in r:
                        st = 'no-request'
                    elif any(x not in entries for x in r['entries']):
                        st = 'unresolved'
                    elif r.get('shapeHash') not in shapes:
                        st = 'no-shape'
                    elif not r.get('original') or 'hash' not in r['original']:
                        st = 'no-original'
                    stats[(lineage, st)] += 1
                    row = {'id': t['id'], 'session': t['session'], 'split': split_of(t['session']), 'lineage': lineage, 'kind': t['kind'], 'status': st,
                           'turnIndex': t['turnIndex'], 'compactions': t['compactions'], 'estPromptTokens': t['estPromptTokens']}
                    if st == 'ok' and r is not None:
                        row.update(nEntries=len(r['entries']), carrier=r['carrier'], originalModel=r['original']['model'], originalVerified=r['original']['verified'])
                        kept_turns.append({'id': t['id'], 'kind': t['kind'], 'lineage': lineage, 'turnIndex': t['turnIndex'], 'compactions': t['compactions'],
                                           'carrier': r['carrier'], 'querySource': r['querySource'], 'shapeHash': r['shapeHash'], 'params': r['params'], 'entries': r['entries'],
                                           'original': r['original']})
                        used.update(r['entries'])
                        used.add(r['original']['hash'])
                    index.append(row)
                if kept_turns:
                    kept_turns.sort(key=lambda x: (x['compactions'], x['turnIndex']))
                    doc = {'session': shash, 'lineage': lineage, 'entries': {k: entries[k] for k in used},
                           'shapes': {k: shapes[k] for k in {x['shapeHash'] for x in kept_turns}}, 'turns': kept_turns}
                    with open(os.path.join(a.out, f'{shash}.json'), 'w') as fh:
                        json.dump(doc, fh, ensure_ascii=False)
    with open(os.path.join(a.out, 'index.jsonl'), 'w') as fh:
        for row in index:
            fh.write(json.dumps(row) + '\n')
    print(json.dumps({f'{k[0]}/{k[1]}': v for k, v in sorted(stats.items())}), file=sys.stderr)


if __name__ == '__main__':
    main()
