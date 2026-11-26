#!/usr/bin/env python3
"""Builds the candidate packs of the v2.3 experiment from the shipped v2.2 pack, one named change set each, so every
candidate is reproducible:  python3 mkpack.py <variant> [<variant> ...]   → packs/<variant>/

Every example is synthetic (written here); none comes from a session or a dataset.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, '..', '..', 'packages', 'assessor', 'prompts', 'assessor', 'v2.2')
RULE_IDS = ['explore-readonly', 'mechanical-edit', 'bounded-change', 'deep-investigation']

MAPPING = {"frontierFacts": ["prior-failures"], "priorFailuresMin": 2, "standardFacts": ["multi-file-edit"],
           "fastSpecifications": ["fully-specified"], "fastDepths": ["lookup", "routine"], "fastBeatsStandard": False,
           "unmatchedTier": "standard"}

CARD_FIELDS_OLD = """- `firstUser`: the first user message of this conversation (task framing), when different from the latest.
"""
CARD_FIELDS_NEW = CARD_FIELDS_OLD + """- `prevUser`: the user message before the latest one, when it is not the first.
- `prevAssistant`: the END of the agent's last reply before the latest message (`chars` is set when its start was
  cut). It is context, not a request: it shows what a short follow-up refers to.
"""
JUDGE_OLD = """Judge the latest request in the context of the rest of the card. A short follow-up ("now do the same for the tests")
inherits the scope of the work it refers to.
"""
JUDGE_NEW = """Judge the latest request in the context of the rest of the card. A short follow-up ("now do the same for the tests",
"yes, go ahead", "option 2") asks for the work it refers to: find that work in `prevAssistant`, `prevUser` and
`firstUser` and assess it. Approving a plan or a proposal asks for the work of carrying it out.

The latest message is sometimes not written by the user: a notice that a background command, a sub-agent or a tool
finished (for example `<task-notification>`), or a summary that continues an earlier session. The agent then goes on
with its work. Assess the step the agent takes next: reading a result and reporting it is a lookup; a notice of a
failure, or one that hands back unfinished work, asks for the work of dealing with it.
"""


def card(latest: str, *, first: str | None = None, prev_user: str | None = None, prev_assistant: str | None = None, prev_chars: int | None = None,
         turn: int = 0, tokens: int = 18000, calls: int = 0, errors: int = 0) -> dict[str, Any]:
    c: dict[str, Any] = {"v": "card/v2", "latestUser": {"text": latest, "images": 0}}
    if first is not None:
        c["firstUser"] = {"text": first}
    if prev_user is not None:
        c["prevUser"] = {"text": prev_user}
    if prev_assistant is not None:
        c["prevAssistant"] = {"text": prev_assistant, **({"chars": prev_chars} if prev_chars else {})}
    c.update({"role": {"label": "coding-agent"}, "tools": {"names": ["Read", "Grep", "Edit", "Bash"], "total": 4}, "lineage": {"kind": "root"},
              "stats": {"turnIndex": turn, "estPromptTokens": tokens, "prevTurnToolCalls": calls, "prevTurnToolErrors": errors}})
    return c


def out(matched: dict[str, str], unmatched: dict[str, str], facts: tuple[bool, str, str, str, int], conf: float, reason: str) -> dict[str, Any]:
    ra = [{"rule_id": r, "matched": r in matched, "reason": matched.get(r) or unmatched[r]} for r in RULE_IDS]
    return {"rule_assessments": ra, "task_facts": {"edits_code": facts[0], "scope": facts[1], "specification": facts[2], "reasoning_depth": facts[3], "prior_failures": facts[4]},
            "confidence": conf, "reason": reason}


NOTICE_OK = ('<task-notification>\n<task-id>t-4821</task-id>\n<status>completed</status>\n'
             '<summary>Background command "pnpm test" completed (exit code 0)</summary>\n</task-notification>')
NOTICE_FAIL = ('<task-notification>\n<task-id>t-5190</task-id>\n<status>failed</status>\n'
               '<summary>Background command "pnpm test" failed (exit code 1)</summary>\n</task-notification>')

FOLLOWUP_EXAMPLES: list[dict[str, Any]] = [
    {"tier": "standard",
     "card": card("ok, do it", first="the nightly export job sometimes writes an empty file", turn=1, tokens=41000, calls=7,
                  prev_assistant="…so the cause is that `flush()` runs before the last batch is appended when the queue is empty. I would move the flush after the loop in `export/writer.py` and add a regression test with an empty queue. Shall I make the change?", prev_chars=1630),
     "output": out({"bounded-change": "approves the proposed local fix and test"},
                   {"explore-readonly": "edits are requested", "mechanical-edit": "the fix and its test still have to be written", "deep-investigation": "a bounded bug with a known cause"},
                   (True, "multi-file", "partially", "routine", 0), 0.87, "Approves the proposed fix: move the flush in the export writer and add a regression test.")},
    {"tier": "fast",
     "card": card("which of those are still read anywhere?", first="we want to clean up old feature flags", prev_user="list the feature flags defined in config/flags.ts", turn=2, tokens=26000, calls=2,
                  prev_assistant="There are six flags in `config/flags.ts`: `newCheckout`, `betaSearch`, `legacyExport`, `fastSync`, `darkMode` and `auditTrail`."),
     "output": out({"explore-readonly": "asks where the listed flags are still read"},
                   {"mechanical-edit": "no change requested", "bounded-change": "no change requested", "deep-investigation": "a lookup"},
                   (False, "none", "fully-specified", "lookup", 0), 0.9, "Find which of the six listed feature flags are still read in the code.")},
    {"tier": "fast",
     "card": card(NOTICE_OK, first="bump the lodash version to 4.17.21 and make sure the tests still pass", turn=1, tokens=22000, calls=3,
                  prev_assistant="The version is bumped in `package.json` and the lockfile. I started the test suite in the background and will report the result when it finishes."),
     "output": out({"explore-readonly": "a notice that the test run passed; the next step is to read and report it"},
                   {"mechanical-edit": "no change left to make", "bounded-change": "nothing failed", "deep-investigation": "a routine result"},
                   (False, "none", "fully-specified", "lookup", 0), 0.86, "Background test run finished successfully; the agent reads the result and reports it.")},
    {"tier": "standard",
     "card": card(NOTICE_FAIL, first="add a `--limit` flag to the export command that caps the rows written; include tests", turn=1, tokens=38000, calls=11,
                  prev_assistant="The flag is implemented in `cli/export.ts` with two new tests. I am running the whole suite in the background."),
     "output": out({"bounded-change": "the test run failed; the agent has to find and fix the failure in its change"},
                   {"explore-readonly": "a failure must be fixed", "mechanical-edit": "the fix is not given", "deep-investigation": "a first failure of a bounded change"},
                   (True, "multi-file", "partially", "routine", 0), 0.84, "Background test run failed after the new flag; find and fix the failing tests.")},
]

BOUNDED_V23 = ("Implement or fix a bounded feature or bug in known code with clear acceptance, typical pull-request-sized work. Includes fixing a failing test or bug whose "
               "cause is not yet known but is likely local, a bug report that points to the faulty code or suggests a fix, and analysis with a defined question that is "
               "more than a lookup: review a change or a document, diagnose a reported problem, write a plan, a report or an evaluation.")


def build(variant: str) -> None:
    ins = open(os.path.join(BASE, 'instructions.md')).read()
    rules = json.load(open(os.path.join(BASE, 'rules.json')))
    ex = json.load(open(os.path.join(BASE, 'examples.json')))
    for e in ex:
        e['card']['v'] = 'card/v2'
    flags = set(variant.split('-')[1:]) if '-' in variant else set(variant[len('v23'):])
    # m: card/v2 + unmatchedTier only (the v2.2 text). a: + card fields and follow-up/notice guidance + examples.
    if 'a' in flags:
        assert CARD_FIELDS_OLD in ins and JUDGE_OLD in ins
        ins = ins.replace(CARD_FIELDS_OLD, CARD_FIELDS_NEW).replace(JUDGE_OLD, JUDGE_NEW)
        ex = ex + FOLLOWUP_EXAMPLES
    if 'b' in flags:  # as a, without the notice guidance and the two notice examples (they over-called fast on dev)
        assert CARD_FIELDS_OLD in ins and JUDGE_OLD in ins
        ins = ins.replace(CARD_FIELDS_OLD, CARD_FIELDS_NEW).replace(JUDGE_OLD, JUDGE_NEW.split('\n\nThe latest message is sometimes')[0] + '\n')
        ex = ex + FOLLOWUP_EXAMPLES[:2]
    if 'd' in flags:  # the v2.2 text plus the description of the two new card fields, nothing else
        assert CARD_FIELDS_OLD in ins
        ins = ins.replace(CARD_FIELDS_OLD, CARD_FIELDS_NEW)
    if 'r' in flags:  # rule text: analysis with a defined question is standard work
        for r in rules:
            if r['id'] == 'bounded-change':
                r['instruction'] = BOUNDED_V23
    for mod in EXTRA:
        if mod.__name__[4:] in flags:
            ins, rules, ex = mod(ins, rules, ex)
    d = os.path.join(HERE, 'packs', variant)
    os.makedirs(d, exist_ok=True)
    json.dump({"id": f"assessor/{variant}", "card": "card/v2", "output": "assessment/v1", "mapping": MAPPING}, open(os.path.join(d, 'pack.json'), 'w'), indent=1)
    open(os.path.join(d, 'instructions.md'), 'w').write(ins)
    json.dump(rules, open(os.path.join(d, 'rules.json'), 'w'), indent=2, ensure_ascii=False)
    json.dump(ex, open(os.path.join(d, 'examples.json'), 'w'), indent=1, ensure_ascii=False)
    print(variant, 'examples', len(ex), 'instruction chars', len(ins))


EXTRA: list[Any] = []

if __name__ == '__main__':
    for v in sys.argv[1:]:
        build(v)
