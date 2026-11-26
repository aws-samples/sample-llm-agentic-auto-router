#!/usr/bin/env python3
"""Held-out set 'heldout-1' for the v2.4 confirmation step: Claude Code sessions with a user turn at or after --since
that the v2.3 export never saw (task: eval v2.4, fresh held-out data).

Export: assessor-v23's own turn extraction (sessions.read_conv), over the same project directories as the v2.3 export
(every project directory except the kiro-crew automation workspaces and the bare home workspace), keeping a root
session when any of its user turns is at or after --since and its session id is not in the v2.3 export (dev or test,
turns.jsonl) or the kiro export. Sub-agent first prompts of a kept session come with it. Interactive sessions only by
default (the transcript's `entrypoint` is 'cli'; `claude -p` / SDK runs are 'sdk-cli').
Tags per turn (no text): split 'heldout-1', thisRepo (the project directory is this repository or an orca worktree of
it: analysis can drop these, since they discuss the eval design), afterSince (the turn itself is at or after --since),
entrypoint. Rebuildability: assessor-v24 rebuild.py's own criteria (read_file and its status codes), counted only.

Output (local only, results/ is gitignored; the text is the transcript owner's, never committed or quoted):
  results/heldout-1/turns.jsonl   sessions.py items + the tags above
  results/heldout-1/index.jsonl   one line per turn: id, session, lineage, kind, tags, rebuild status (no text)
Prints counts only.

  python3 heldout.py [--since 2026-11-17T00:00:00Z] [--projects ~/.claude/projects] [--all-entrypoints]
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import glob
import json
import os
import sys
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
V23 = os.environ.get('V23_DIR', os.path.join(HERE, '..', 'assessor-v23'))
sys.path.insert(0, V23)
sys.path.insert(0, HERE)
from sessions import h, read_conv  # noqa: E402  (v2.3's export: the same turn detection and fields)
from rebuild import read_file  # noqa: E402  (v2.4's request rebuild: the same rebuildability criteria)

SPLIT = 'heldout-1'
MAIN_TREE_V23 = os.path.join(HERE, '..', 'assessor-v23', 'results', 'sessions')  # local-only data: run from the checkout that holds it
# The v2.3 export's project set: every project directory except these (it matched the ten others by name).
EXCLUDE = ('kiro-crew',)
THIS_REPO = 'sample-llm-agentic-auto-router'


def ts_of(s: Any) -> dt.datetime | None:
    if not isinstance(s, str) or not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))
    except ValueError:
        return None


def entrypoint_of(path: str) -> str:
    with open(path, errors='replace') as fh:
        for line in fh:
            if '"entrypoint"' not in line:
                continue
            try:
                v = json.loads(line).get('entrypoint')
            except Exception:
                continue
            if isinstance(v, str):
                return v
    return ''


def project_dirs(projects: str) -> list[str]:
    """The v2.3 export's directories: all but the automation workspaces and the bare home workspace."""
    home = os.path.basename(os.path.expanduser('~')).strip()
    bare = {f'-local-home-{home}-workspace', f'-home-{home}-workspace'}
    return [d for d in sorted(os.listdir(projects)) if os.path.isdir(os.path.join(projects, d)) and not any(x in d for x in EXCLUDE) and d not in bare]


def rebuild_status(t: dict[str, Any], by_id: dict[str, Any], entries: dict[str, Any], shapes: dict[str, Any]) -> str:
    """rebuild.py main()'s per-turn status, unchanged."""
    r = by_id.get(t['id'])
    if r is None:
        return 'no-turn'
    if 'entries' not in r:
        return 'no-request'
    if any(x not in entries for x in r['entries']):
        return 'unresolved'
    if r.get('shapeHash') not in shapes:
        return 'no-shape'
    if not r.get('original') or 'hash' not in r['original']:
        return 'no-original'
    return 'ok'


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--projects', default=os.path.expanduser('~/.claude/projects'))
    ap.add_argument('--since', default='2026-11-17T00:00:00Z')
    ap.add_argument('--v23', default=MAIN_TREE_V23, help='directory with the v2.3 exports (turns.jsonl, kiro-turns.jsonl)')
    ap.add_argument('--all-entrypoints', action='store_true', help='also keep non-interactive (sdk-cli) sessions')
    ap.add_argument('--out', default=os.path.join(HERE, 'results', SPLIT))
    a = ap.parse_args()
    since = ts_of(a.since)
    if since is None:
        raise SystemExit(f'--since: ISO timestamp required, got {a.since!r}')
    seen: set[str] = set()
    for name in ('turns.jsonl', 'kiro-turns.jsonl'):
        p = os.path.join(a.v23, name)
        if not os.path.exists(p):
            raise SystemExit(f'{p}: missing (the v2.3 exports decide what is new)')
        with open(p) as fh:
            seen.update(json.loads(l)['session'] for l in fh if l.strip())

    stats: collections.Counter[str] = collections.Counter()
    out: list[dict[str, Any]] = []
    index: list[dict[str, Any]] = []
    for d in project_dirs(a.projects):
        project = h(d, n=6)
        this_repo = THIS_REPO in d
        for f in sorted(glob.glob(os.path.join(a.projects, d, '*.jsonl'))):
            session = os.path.basename(f)[:-6]
            sh = h(session, n=10)
            shapes: dict[str, Any] = {}
            root = read_conv(f, project, session, 'root', shapes)
            if not root or not any((ts_of(it.get('ts')) or since.min) >= since for it in root):
                continue
            stats['sessions:candidate'] += 1
            if sh in seen:
                stats['sessions:in-v23'] += 1
                continue
            ep = entrypoint_of(f)
            if ep != 'cli' and not a.all_entrypoints:
                stats[f'sessions:entrypoint-{ep or "none"}'] += 1
                continue
            items = list(root)
            files = [(f, session, 'root', root)]
            for sf in sorted(glob.glob(os.path.join(a.projects, d, session, 'subagents', '*.jsonl'))):
                raw = session + '/' + os.path.basename(sf)
                sub = read_conv(sf, project, raw, 'subagent', {})
                try:
                    agent_type = str(json.load(open(sf[:-6] + '.meta.json')).get('agentType') or '')
                except Exception:
                    agent_type = ''
                # as sessions.py: a fork inherits the parent's context; only the delegated prompt of a sub-agent counts
                if sub and agent_type != 'fork':
                    sub[0]['agentType'] = agent_type
                    items.append(sub[0])
                    files.append((sf, raw, 'subagent', [sub[0]]))
            stats['sessions:kept'] += 1
            stats[f'sessions:kept:{"this-repo" if this_repo else "other"}'] += 1
            for path, raw, lineage, its in files:
                reqs, entries, shp = read_file(path, lineage)
                by_id = {h(raw, r['uuid']): r for r in reqs}
                for it in its:
                    after = (ts_of(it.get('ts')) or since.min) >= since
                    it.update(split=SPLIT, thisRepo=this_repo, afterSince=after, entrypoint=ep)
                    st = rebuild_status(it, by_id, entries, shp)
                    out.append(it)
                    index.append({'id': it['id'], 'session': it['session'], 'lineage': lineage, 'kind': it['kind'], 'split': SPLIT,
                                  'thisRepo': this_repo, 'afterSince': after, 'entrypoint': ep, 'rebuild': st})
    overlap = {r['session'] for r in index} & seen
    if overlap:
        raise SystemExit(f'{len(overlap)} held-out sessions are in the v2.3 export: refusing to write')
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, 'turns.jsonl'), 'w') as fh:
        for it in out:
            fh.write(json.dumps(it, ensure_ascii=False) + '\n')
    with open(os.path.join(a.out, 'index.jsonl'), 'w') as fh:
        for r in index:
            fh.write(json.dumps(r) + '\n')

    def count(rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            'sessions': len({r['session'] for r in rows if r['lineage'] == 'root'}),
            'turns': len(rows),
            'byKind': dict(sorted(collections.Counter('subagent' if r['lineage'] == 'subagent' else r['kind'] for r in rows).items())),
            'rebuild': dict(sorted(collections.Counter(r['rebuild'] for r in rows).items())),
            'rebuildableByKind': dict(sorted(collections.Counter('subagent' if r['lineage'] == 'subagent' else r['kind'] for r in rows if r['rebuild'] == 'ok').items())),
        }
    report = {'split': SPLIT, 'since': a.since, 'selection': dict(sorted(stats.items())),
              'all': count(index), 'afterSinceOnly': count([r for r in index if r['afterSince']]),
              'excludingThisRepo': count([r for r in index if not r['thisRepo']]),
              'excludingThisRepoAfterSince': count([r for r in index if not r['thisRepo'] and r['afterSince']])}
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
