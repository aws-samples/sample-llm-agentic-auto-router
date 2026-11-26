#!/usr/bin/env python3
"""Deterministic fast rules by template family (core PolicyRule `when.templateFamily`), chosen on dev and checked on
test. A family qualifies when it has at least --min-n labelled dev turns and the Wilson lower bound of its fast share
is at least --min-lb. The rule overrides the assessor for that family (policy rules win over assessor opinions in core's
desiredTier). Output: the proposed rules (family ids only) and the test scores with and without them.

  python3 family_rules.py --set main|kiro [--min-n 30] [--min-lb 0.95] [--run v23-test|v23-kiro]

The family here is a proxy built from what the transcripts record (tool names + the head of the system text); in a
deployment use the `templateFamily` the router logs on every decision.
"""
import argparse, collections, hashlib, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score as S

SETS = {'main': ('results/sessions/turns.jsonl', '', {'test': 'v23-test', 'base': 'b0-v22-test'}),
        'kiro': ('results/sessions/kiro-turns.jsonl', '-kiro', {'test': 'v23-kiro', 'base': 'b0-v22-kiro'})}


def family(t):
    return hashlib.sha256(('\0'.join(sorted(t['tools'])) + '\1' + t['systemHead'] + '\2' + t['lineage'] + (t.get('agentType') or '')).encode()).hexdigest()[:12]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', choices=sorted(SETS), required=True)
    ap.add_argument('--min-n', type=int, default=30)
    ap.add_argument('--min-lb', type=float, default=0.95)
    ap.add_argument('--reps', type=int, default=2000)
    a = ap.parse_args()
    path, suffix, runs = SETS[a.set]
    S.LABEL_SUFFIX, S.REPS = suffix, a.reps
    turns = S.jl(f'{S.HERE}/{path}')
    gold = S.load_gold('agree')
    by = collections.defaultdict(collections.Counter)
    for t in turns:
        if S.split_of(t['session']) == 'dev' and t['id'] in gold:
            by[family(t)][gold[t['id']]['tier']] += 1
    rules = []
    for f, c in sorted(by.items(), key=lambda kv: -sum(kv[1].values())):
        n = sum(c.values())
        lb = S.wilson(c['fast'], n)[0]
        if n >= a.min_n and lb >= a.min_lb:
            rules.append({'id': f'fast-family-{f[:8]}', 'when': {'templateFamily': [f]}, 'tier': 'fast', 'devN': n, 'devFast': c['fast'] / n, 'devLowerBound': lb})
    print(json.dumps({'set': a.set, 'qualifying': len(rules), 'familiesSeen': len(by), 'rules': rules}, indent=1))

    fams = {r['when']['templateFamily'][0] for r in rules}
    test = [t for t in turns if S.split_of(t['session']) == 'test']
    opts = argparse.Namespace(unmatched_standard=False, lowconf_standard=False, fast_min_conf=0.0, fast_lookup_only=False, no_fast=set(), skip=set(), no_held=False)
    served = {}
    for name, lab in (('v2.2', runs['base']), ('v2.3', runs['test'])):
        rows = {r['id']: r for r in S.jl(f'{S.HERE}/results/runs/{lab}.jsonl')}
        served[name] = S.serve(test, rows, opts)
        ruled = {i: dict(v) for i, v in served[name].items()}
        for t in test:
            if family(t) in fams:  # the policy rule decides; the assessor is not consulted
                ruled[t['id']].update(op='fast', served='fast')
        served[f'{name}+rules'] = ruled
    ids = [t['id'] for t in test if t['id'] in gold]
    sess = {t['id']: t['session'] for t in test}
    hit = [i for i in ids if family(next(t for t in test if t['id'] == i)) in fams]
    if hit:
        k = sum(1 for i in hit if gold[i]['tier'] == 'fast')
        print(f'test turns the rules decide: {len(hit)} of {len(ids)}; labelled fast {k} ({k / len(hit):.3f}) {S.wilson(k, len(hit))}')
    for name, sv in served.items():
        m = S.metrics(ids, sv, gold)
        print(f"{name:10s} n={m['n']} exact={m['exact']:.3f} wrongFast={m['wrongFast']:.3f} under={m['under']:.3f} missedFast={m['missedFast']:.3f} cost={m['cost']:.3f} (oracle {m['costOracle']:.3f})")
    for k in ('exact', 'wrongFast', 'under', 'cost'):
        d = S.boot(ids, sess, lambda s, k=k: S.metrics(s, served['v2.3+rules'], gold)[k] - S.metrics(s, served['v2.2'], gold)[k])
        pt = S.metrics(ids, served['v2.3+rules'], gold)[k] - S.metrics(ids, served['v2.2'], gold)[k]
        print(f'v2.3+rules − v2.2: {k} {pt:+.3f} [{d[0]:+.3f},{d[1]:+.3f}]')


if __name__ == '__main__':
    main()
