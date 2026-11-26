#!/usr/bin/env python3
"""Export user turns from local Claude Code session transcripts as assessor eval items (task: assessor v2.3).

Each item is one user-text message that the model answered, with (a) the fields a task card is built from and
(b) a hindsight digest of what the model then did (tool calls, edits, errors, final answer), which the judge labels.
Output is local-only (results/ is gitignored): the text is the transcript owner's and is never committed or quoted.

  python3 sessions.py --projects <claude projects dir> --match <substring> [--match ...] --out results/sessions/turns.jsonl
"""
from __future__ import annotations

import argparse
import collections
import glob
import hashlib
import json
import os
import re
import sys
from typing import Any

EDIT_TOOLS = {'Edit', 'Write', 'NotebookEdit', 'MultiEdit'}
SPAWN_TOOLS = {'Agent', 'Task', 'Workflow'}
TAG = re.compile(r'^\s*<([a-zA-Z_-]+)[\s>]')
# User-text records that are not a request the model answers on their own.
SKIP_TAGS = {'local-command-stdout', 'local-command-stderr', 'bash-input', 'bash-stdout', 'bash-stderr', 'local-command-caveat'}
NOTIFY_TAGS = {'task-notification', 'teammate-message', 'system-reminder'}


def h(*parts: str, n: int = 12) -> str:
    return hashlib.sha256('\0'.join(parts).encode()).hexdigest()[:n]


def text_of(content: Any) -> tuple[str, int, bool]:
    """(text, images, has_tool_result) of a user message content."""
    if isinstance(content, str):
        return content, 0, False
    texts, images, tr = [], 0, False
    for b in content if isinstance(content, list) else []:
        if not isinstance(b, dict):
            continue
        t = b.get('type')
        if t == 'text' and isinstance(b.get('text'), str):
            texts.append(b['text'])
        elif t in ('image', 'document'):
            images += 1
        elif t == 'tool_result':
            tr = True
    return '\n'.join(x.strip() for x in texts if x.strip()), images, tr


def brief(name: str, inp: Any) -> str:
    if not isinstance(inp, dict):
        return ''
    for k in ('file_path', 'notebook_path', 'path', 'pattern', 'command', 'description', 'query', 'url', 'skill', 'prompt'):
        v = inp.get(k)
        if isinstance(v, str) and v:
            return v.replace('\n', ' ')[:140]
    return ''


def kind_of(text: str, compact: bool) -> str | None:
    if compact:
        return 'compaction'
    if text.startswith('[Request interrupted'):
        return None
    m = TAG.match(text)
    tag = m.group(1) if m else None
    if tag in SKIP_TAGS:
        return None
    if tag in NOTIFY_TAGS:
        return 'notification'
    if tag in ('command-name', 'command-message'):
        return 'command'
    return 'human'


class Conv:
    """State of one conversation (a session file or a subagent file), reset at each compaction."""

    def __init__(self) -> None:
        self.first: str | None = None
        self.user_texts = 0
        self.compactions = 0
        self.prev_user: str | None = None
        self.turn: dict[str, Any] | None = None  # the open turn (item under construction)
        self.session_calls = 0
        self.session_errors = 0


def digest_turn(t: dict[str, Any]) -> None:
    """Finishes the hindsight part of an item in place."""
    calls = t.pop('_calls')
    errs = t.pop('_errs')
    for c in calls:
        c['err'] = c.pop('id') in errs
    files = sorted({c['brief'] for c in calls if c['name'] in EDIT_TOOLS and c['brief']})
    texts = t.pop('_texts')
    final = texts[-1] if texts else ''
    t['hindsight'] = {
        'toolCalls': len(calls), 'toolErrors': sum(1 for c in calls if c['err']),
        'tools': [[c['name'], c['brief'], c['err']] for c in calls[:70]],
        'toolHist': dict(collections.Counter(c['name'] for c in calls)),
        'filesEdited': files[:40], 'nFilesEdited': len(files),
        'dirsEdited': len({os.path.dirname(f) for f in files}),
        'edits': sum(1 for c in calls if c['name'] in EDIT_TOOLS),
        'spawns': sum(1 for c in calls if c['name'] in SPAWN_TOOLS),
        'assistantMsgs': t.pop('_msgs'), 'outputTokens': t.pop('_out'), 'thinkingMs': t.pop('_think'),
        'finalHead': final[:1500], 'finalTail': final[-1500:] if len(final) > 3000 else final[1500:3000],
        'finalChars': len(final), 'models': sorted(t.pop('_models')),
    }
    t['prevForNext'] = {'assistant': final, 'calls': len(calls), 'errors': sum(1 for c in calls if c['err'])}


def read_conv(path: str, project: str, session: str, lineage: str, shapes: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    cv = Conv()
    prev: dict[str, Any] = {'assistant': '', 'calls': 0, 'errors': 0}
    shape: dict[str, Any] | None = shapes.get('last')
    seen_msg: dict[str, int] = {}

    def close() -> None:
        nonlocal prev
        if cv.turn is not None:
            digest_turn(cv.turn)
            prev = cv.turn.pop('prevForNext')
            if cv.turn['hindsight']['assistantMsgs'] > 0:
                items.append(cv.turn)
            cv.turn = None

    with open(path, errors='replace') as fh:
        for line in fh:
            try:
                o = json.loads(line)
            except Exception:
                continue
            t = o.get('type')
            if t == 'api-request-shape' and isinstance(o.get('shape'), dict):
                shape = o['shape']
                shapes['last'] = shape
                continue
            if t not in ('user', 'assistant') or not isinstance(o.get('message'), dict):
                continue
            if lineage == 'root' and o.get('isSidechain'):
                continue
            msg = o['message']
            if t == 'assistant':
                if cv.turn is None:
                    continue
                tr = cv.turn
                mid = str(msg.get('id') or o.get('uuid'))
                if mid not in seen_msg:
                    seen_msg[mid] = 1
                    tr['_msgs'] += 1
                    u = msg.get('usage') or {}
                    tr['_out'] += int(u.get('output_tokens') or 0)
                    if tr.get('estPromptTokens') is None:
                        tr['estPromptTokens'] = sum(int(u.get(k) or 0) for k in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'))
                tr['_think'] += int(o.get('thinkingDurationMs') or 0)
                if isinstance(msg.get('model'), str):
                    tr['_models'].add(msg['model'])
                for b in msg.get('content') if isinstance(msg.get('content'), list) else []:
                    if not isinstance(b, dict):
                        continue
                    if b.get('type') == 'text' and isinstance(b.get('text'), str) and b['text'].strip():
                        tr['_texts'].append(b['text'].strip())
                    elif b.get('type') == 'tool_use':
                        tr['_calls'].append({'name': str(b.get('name')), 'brief': brief(str(b.get('name')), b.get('input')), 'id': str(b.get('id'))})
                continue
            # user record
            text, images, has_tr = text_of(msg.get('content'))
            if has_tr:
                if cv.turn is not None:
                    for b in msg['content']:
                        if isinstance(b, dict) and b.get('type') == 'tool_result' and b.get('is_error') is True:
                            cv.turn['_errs'].add(str(b.get('tool_use_id')))
                continue
            if o.get('isMeta'):
                continue
            text = text.strip()
            compact = bool(o.get('isCompactSummary'))
            kind = kind_of(text, compact)
            if kind is None or text == '':
                if cv.turn is not None and text.startswith('[Request interrupted'):
                    cv.turn['interrupted'] = True
                continue
            if cv.turn is not None:
                cv.turn['nextUserHead'] = text[:300]
                cv.turn['nextUserKind'] = kind
            close()
            if compact:
                cv.first, cv.user_texts, cv.prev_user = None, 0, None
                cv.compactions += 1
                prev = {'assistant': '', 'calls': 0, 'errors': 0}
            item: dict[str, Any] = {
                'id': h(session, str(o.get('uuid'))), 'session': h(session, n=10), 'project': project, 'kind': kind, 'lineage': lineage,
                'turnIndex': cv.user_texts, 'compactions': cv.compactions,
                'latest': text[:MAX_CHARS], 'latestChars': len(text), 'images': images,
                'first': (cv.first or '')[:MAX_FIRST_CHARS] if cv.first is not None else None,
                'prevUser': (cv.prev_user or '')[:MAX_FIRST_CHARS] if cv.prev_user is not None else None,
                'prevAssistant': prev['assistant'][-6000:], 'prevAssistantChars': len(prev['assistant']),
                'prevTurnToolCalls': prev['calls'], 'prevTurnToolErrors': prev['errors'],
                'systemHead': ''.join(b.get('text', '') for b in (shape or {}).get('system', []) if isinstance(b, dict))[:1200] if shape else '',
                'tools': [str(x.get('name')) for x in (shape or {}).get('tools', []) if isinstance(x, dict) and x.get('name')] if shape else [],
                'estPromptTokens': None, 'ts': o.get('timestamp'),
                '_calls': [], '_errs': set(), '_texts': [], '_msgs': 0, '_out': 0, '_think': 0, '_models': set(),
            }
            if cv.first is None:
                cv.first = text
            cv.prev_user = text
            cv.user_texts += 1
            cv.turn = item
    close()
    for it in items:
        it['estPromptTokens'] = it['estPromptTokens'] or 0
    # Turns answered only by a synthetic (client-made) error message were never served by a model.
    return [it for it in items if it['hindsight']['models'] != ['<synthetic>']]


MAX_CHARS = 12000
MAX_FIRST_CHARS = 3000


def main() -> None:
    global MAX_CHARS, MAX_FIRST_CHARS
    ap = argparse.ArgumentParser()
    ap.add_argument('--projects', default=os.path.expanduser('~/.claude/projects'))
    ap.add_argument('--match', action='append', required=True, help='substring of a project directory name (repeatable)')
    ap.add_argument('--exclude', action='append', default=[])
    ap.add_argument('--out', required=True)
    # card/v3 measurement (brief D): automated prompts run past 12,000 chars; the defaults keep the v2.3 export as it was.
    ap.add_argument('--max-chars', type=int, default=12000, help='chars kept of the latest user text')
    ap.add_argument('--max-first-chars', type=int, default=3000, help='chars kept of the first and previous user texts')
    a = ap.parse_args()
    MAX_CHARS, MAX_FIRST_CHARS = a.max_chars, a.max_first_chars
    out: list[dict[str, Any]] = []
    for d in sorted(os.listdir(a.projects)):
        if not any(m in d for m in a.match) or any(x in d for x in a.exclude):
            continue
        project = h(d, n=6)
        for f in sorted(glob.glob(os.path.join(a.projects, d, '*.jsonl'))):
            session = os.path.basename(f)[:-6]
            shapes: dict[str, Any] = {}
            out.extend(read_conv(f, project, session, 'root', shapes))
            for sf in sorted(glob.glob(os.path.join(a.projects, d, session, 'subagents', '*.jsonl'))):
                sub = read_conv(sf, project, session + '/' + os.path.basename(sf), 'subagent', {})
                try:
                    agent_type = str(json.load(open(sf[:-6] + '.meta.json')).get('agentType') or '')
                except Exception:
                    agent_type = ''
                # A fork inherits the parent's whole context: not a clean sub-agent start.
                if sub and agent_type != 'fork':
                    sub[0]['agentType'] = agent_type
                    out.append(sub[0])  # the delegated prompt only: later user texts in a subagent are harness messages
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, 'w') as fh:
        for it in out:
            fh.write(json.dumps(it, ensure_ascii=False) + '\n')
    c = collections.Counter((it['lineage'], it['kind']) for it in out)
    print(json.dumps({'items': len(out), 'sessions': len({it['session'] for it in out}), 'projects': len({it['project'] for it in out}),
                      'by': {f'{k[0]}/{k[1]}': v for k, v in sorted(c.items())}}), file=sys.stderr)


if __name__ == '__main__':
    main()
