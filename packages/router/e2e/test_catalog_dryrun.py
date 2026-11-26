"""Dry run of the dynamic-catalog checks (cat-*) against fakes: no AWS, no network. Every boto3 client, the gateway
call and the console API are replaced by small in-memory fakes; e2e/catalog.ts (the real @auto-router/pricing code)
runs as in a live run. It proves the control flow, the restore paths and what results/ receives (no token, no
12-digit run), not AWS behaviour.

  uv run --with pytest --with boto3==1.43.126 --with requests==2.34.2 pytest -q packages/router/e2e/test_catalog_dryrun.py
"""
from __future__ import annotations

import copy
import importlib.util
import json
import pathlib
import re
import types
from typing import Any

import pytest

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[2]
ACCOUNT = '0' * 12
REGION = 'us-west-2'
BUCKET = 'config-bucket'
TOKEN = 'aaa.bbb.ccc'  # nosec B105: placeholder bearer value the dry run sends to its local fake, not a credential
NEW = 'global.anthropic.claude-opus-5-6'


def load_run(tmp: pathlib.Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location('e2e_run', HERE / 'run.py')
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    mod.RESULTS = tmp
    mod.LEDGER = tmp / 'ledger.json'
    mod.RESTORE = tmp / 'cat-restore.json'
    return mod


class World:
    """The deployment's state: config bucket objects, router logs, usage records, IAM attachments, the pointer."""

    def __init__(self) -> None:
        self.objects: dict[str, str] = {}
        self.etag = 0
        self.logs: list[dict[str, Any]] = []
        self.records: list[dict[str, Any]] = []
        self.calls: list[str] = []
        self.bundled = json.loads((REPO / f'packages/pricing/data/catalog.{REGION}.json').read_text())
        self.base = [m['modelId'] for m in self.bundled['models']]
        models = json.loads((REPO / 'packages/pricing/data/models.json').read_text())
        v2 = {'schemaVersion': 2, 'models': [], 'excluded': models.get('excluded', [])}
        for m in models['models']:
            v2['models'].append({**m, 'state': 'confirmed', 'fieldSources': {}, 'addedAt': 'x', 'updatedAt': 'x'})
        src = next(m for m in v2['models'] if m['modelId'] == 'global.anthropic.claude-opus-5-5')
        v2['models'].append({**copy.deepcopy(src), 'modelId': NEW, 'state': 'pending', 'stateReason': 'unconfirmed',
                             'fieldSources': {'family': 'template:global.anthropic.claude-opus-5-5'}})
        self.put('catalog/models.json', json.dumps(v2))
        policy = json.loads((REPO / 'packages/router/config/policy.default.json').read_text())
        self.put('config/baked.json', json.dumps({'schemaVersion': 1, 'version': '0-baked.x', 'policy': policy, 'assessor': {'mode': 'off'}}))
        self.history: list[str] = []
        self.publish(by='deploy')

    def put(self, key: str, body: str) -> None:
        self.etag += 1
        self.objects[key] = body

    def json(self, key: str) -> Any:
        return json.loads(self.objects[key]) if key in self.objects else None

    # -------- the catalog the fake refresh builds: bundled + confirmed extras, model-card prices from models.json
    def build(self) -> dict[str, Any]:
        cat = copy.deepcopy(self.bundled)
        f = self.json('catalog/models.json')
        by = {m['modelId']: m for m in f['models']}
        for m in cat['models']:
            card = (by.get(m['modelId']) or {}).get('modelCardPrice')
            if card:
                m['price'] = {**m['price'], 'input': card['price']['input'], 'output': card['price']['output']}
        if by[NEW]['state'] == 'confirmed':
            cat['models'].append({**copy.deepcopy(next(x for x in cat['models'] if x['modelId'] == 'global.anthropic.claude-opus-5-5')), 'modelId': NEW})
        return cat

    def content(self, cat: dict[str, Any]) -> str:
        return json.dumps(sorted(cat['models'], key=lambda m: m['modelId']), sort_keys=True)

    def current(self) -> dict[str, Any] | None:
        return self.json('catalog/current.json')

    def publish(self, by: str = 'refresh') -> str:
        day, seq = self.bundled['version'].rsplit('.', 1)  # the refresh publishes after the bundled label (same day)
        v = f'{day}.{int(seq) + len(self.history) + 1}'
        cat = self.build()
        cat['version'] = v
        prev = self.current()
        old = self.json(prev['key']) if prev else None
        prices = []
        if old:
            o = {m['modelId']: m for m in old['models']}
            for m in cat['models']:
                if m['modelId'] in o and o[m['modelId']]['price']['input'] != m['price']['input']:
                    a, b = o[m['modelId']]['price']['input'], m['price']['input']
                    prices.append({'modelId': m['modelId'], 'field': 'price.input', 'old': a, 'new': b, 'percent': round((b - a) / a * 100, 2), 'alert': True})
        self.put(f'catalog/versions/{v}.json', json.dumps(cat))
        self.put(f'catalog/changes/{v}.json', json.dumps({'version': v, 'prices': prices, 'alert': bool(prices)}))
        self.history.insert(0, v)
        self.put('catalog/current.json', json.dumps({'schemaVersion': 1, 'version': v, 'key': f'catalog/versions/{v}.json',
                                                     'previous': prev['version'] if prev else None, 'history': self.history[:10], 'publishedAt': 'x', 'by': by}))
        self.logs.append({'kind': 'config', 'source': 'catalog', 'catalogVersion': v, 'catalogSource': 'bucket'})
        self.logs.append({'kind': 'config', 'source': 'state', 'catalogVersion': v, 'catalogSource': 'bucket', 'universeVersion': 'e1'})
        return v

    def refresh(self, p: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(f"refresh {p.get('mode')}")
        cur = self.current()
        nxt = self.build()
        if self.content(nxt) == self.content(self.json(cur['key'])) and not (cur['by'] == 'rollback' and p.get('resumeAfterRollback')):
            out = 'unchanged'
        elif cur['by'] == 'rollback' and not p.get('resumeAfterRollback'):
            self.put('catalog/notices.json', json.dumps({'outcome': 'held', 'notices': [{'kind': 'update-held', 'models': [NEW]}]}))
            return {'outcome': 'held'}
        else:
            return {'outcome': 'published', 'version': self.publish()}
        self.put('catalog/notices.json', json.dumps({'outcome': out, 'notices': []}))
        return {'outcome': out}

    def grant(self) -> dict[str, Any]:
        self.calls.append('grant sync')
        cat = self.json(self.current()['key'])
        f = self.json('catalog/models.json')
        ids = {m['modelId'] for m in cat['models']}
        want = [m['modelId'] for m in f['models'] if m['state'] == 'confirmed' and m['modelId'] in ids and m['modelId'] not in self.base]
        self.put('catalog/universe.json', json.dumps({'schemaVersion': 1, 'updatedAt': 'x', 'models': [{'modelId': i, 'grantedAt': 'x'} for i in want]}))
        return {'outcome': 'synced', 'granted': want}

    def rollback(self) -> dict[str, Any]:
        cur = self.current()
        to = cur['previous']
        self.put('catalog/current.json', json.dumps({**cur, 'version': to, 'key': f'catalog/versions/{to}.json', 'previous': cur['version'], 'by': 'rollback'}))
        self.logs.append({'kind': 'config', 'source': 'catalog', 'catalogVersion': to, 'catalogSource': 'bucket'})
        return {'pointer': {'version': to}}


class Paginator:
    def __init__(self, fn: Any):
        self.fn = fn

    def paginate(self, **kw: Any) -> list[dict[str, Any]]:
        return [self.fn(**kw)]


class FakeClient:
    def __init__(self, name: str, w: World):
        self.name, self.w = name, w
        self.exceptions = types.SimpleNamespace(NoSuchKey=KeyError)

    # sts / cloudformation / ssm
    def get_caller_identity(self) -> dict[str, str]:
        return {'Account': ACCOUNT}

    def describe_stacks(self, StackName: str) -> dict[str, Any]:  # noqa: N803
        outs = {'ConfigBucketName': BUCKET, 'RouterLogGroup': '/llmar/router', 'GatewayUrl': 'https://gw.example/x',
                'ConsoleUrl': 'https://console.example', 'UsageTableName': 'usage'}
        return {'Stacks': [{'Outputs': [{'OutputKey': k, 'OutputValue': v} for k, v in outs.items()]}]}

    def get_parameter(self, Name: str) -> dict[str, Any]:  # noqa: N803
        vals = {'catalog-refresh-function': 'llmar-catalog-refresh', 'catalog-grant-function': 'llmar-catalog-grant', 'model-universe': ','.join(self.w.base)}
        return {'Parameter': {'Value': vals[Name.rsplit('/', 1)[-1]]}}

    # s3
    def get_object(self, Bucket: str, Key: str) -> dict[str, Any]:  # noqa: N803
        if Key not in self.w.objects:
            raise KeyError(Key)
        return {'Body': types.SimpleNamespace(read=lambda: self.w.objects[Key].encode()), 'ETag': f'"e{self.w.etag}"'}

    def put_object(self, **kw: Any) -> dict[str, Any]:
        raise AssertionError(f'the checks must not write S3 directly ({kw.get("Key")})')

    def get_paginator(self, op: str) -> Paginator:
        if op == 'list_objects_v2':
            return Paginator(lambda Bucket, Prefix: {'Contents': [{'Key': k} for k in sorted(self.w.objects) if k.startswith(Prefix)]})  # noqa: N803
        if op == 'filter_log_events':
            def logs(logGroupName: str, startTime: int, filterPattern: str = '') -> dict[str, Any]:  # noqa: N803
                want = re.search(r'catalogVersion = "([^"]+)"', filterPattern)
                st = '$.source = "state"' in filterPattern
                ev = [l for l in self.w.logs if (not want or l.get('catalogVersion') == want.group(1)) and (not st or l.get('source') == 'state')]
                return {'events': [{'message': json.dumps(e)} for e in ev]}
            return Paginator(logs)
        if op == 'query':
            return Paginator(lambda **kw: {'Items': [{k: {'S': v} if isinstance(v, str) else {'M': {kk: {'S': vv} for kk, vv in v.items()}} for k, v in r.items()} for r in self.w.records]})
        if op == 'list_attached_role_policies':
            return Paginator(lambda RoleName: {'AttachedPolicies': [{'PolicyName': 'llmar-dyn-models-1', 'PolicyArn': 'arn:aws:iam::x:policy/llmar-dyn-models-1'}]  # noqa: N803
                             if (self.w.json('catalog/universe.json') or {}).get('models') else []})
        if op == 'list_policies':
            return Paginator(lambda Scope: {'Policies': []})  # noqa: N803
        if op == 'describe_log_groups':
            return Paginator(lambda logGroupNamePrefix: {'logGroups': []})  # noqa: N803
        raise AssertionError(op)

    # lambda
    def invoke(self, FunctionName: str, InvocationType: str, Payload: bytes) -> dict[str, Any]:  # noqa: N803
        p = json.loads(Payload)
        out = self.w.refresh(p) if FunctionName.endswith('refresh') else self.w.grant()
        return {'Payload': types.SimpleNamespace(read=lambda: json.dumps(out).encode())}

    # iam
    def get_policy(self, PolicyArn: str) -> dict[str, Any]:  # noqa: N803
        return {'Policy': {'DefaultVersionId': 'v1'}}

    def get_policy_version(self, PolicyArn: str, VersionId: str) -> dict[str, Any]:  # noqa: N803
        ids = [m['modelId'] for m in (self.w.json('catalog/universe.json') or {}).get('models', [])]
        return {'PolicyVersion': {'Document': {'ids': ids}}}

    def simulate_principal_policy(self, **kw: Any) -> dict[str, Any]:
        return {'EvaluationResults': [{'EvalActionName': a, 'EvalDecision': 'implicitDeny', 'PermissionsBoundaryDecisionDetail': {'AllowedByPermissionsBoundary': False}}
                                      for a in kw['ActionNames']]}


@pytest.fixture()
def env(tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch) -> tuple[types.ModuleType, World]:
    run = load_run(tmp_path)
    w = World()
    run.ARGS = types.SimpleNamespace(prefix='llmar', region=REGION, cap=4.5, window_min=60, model=None)
    run.session = types.SimpleNamespace(client=lambda name, **kw: FakeClient(name, w))
    monkeypatch.setenv('LLMAR_CONSOLE_ADMIN_TOKEN', TOKEN)
    monkeypatch.setattr(run.time, 'sleep', lambda s: None)

    def call(path: str, body: Any, headers: dict[str, str] | None = None, **kw: Any) -> dict[str, Any]:
        pin = (headers or {}).get('x-router-hint', '').removeprefix('pin=')
        universe = [m['modelId'] for m in (w.json('catalog/universe.json') or {}).get('models', [])]
        ver = w.current()['version']
        if pin in w.base or pin in universe:
            w.records.append({'servedModel': pin, 'catalogVersion': ver, 'cost': {'cls': {'total': '12'}}})
            return {'status': 200, 'headers': {'x-router-model': pin}, 'usage': {'prompt_tokens': 10, 'completion_tokens': 2}, 'model': pin}
        return {'status': 400, 'headers': {}, 'body': {'error': {'code': 'pin-not-allowed'}}}
    monkeypatch.setattr(run, 'call', call)

    def console_api(method: str, path: str, body: Any = None) -> tuple[int, Any]:
        assert run.console_token() == TOKEN
        w.calls.append(f'console {method} {path}')
        f = w.json('catalog/models.json')
        if path == '/api/admin/catalog/rollback':
            return 200, w.rollback()
        mid = run.requests.utils.unquote(path.split('/')[4])
        m = next(x for x in f['models'] if x['modelId'] == mid)
        if method == 'PATCH':
            m.update(body)
            m.setdefault('fieldSources', {})['modelCardPrice'] = 'admin'
        elif path.endswith('/confirm'):
            m['state'], m['confirmedBy'] = 'confirmed', 'admin'
            m.pop('stateReason', None)
        elif path.endswith('/unconfirm'):
            m['state'], m['stateReason'] = 'pending', 'unconfirmed'
            m.pop('confirmedBy', None)
        w.put('catalog/models.json', json.dumps(f))
        if path.endswith('/unconfirm'):
            w.grant()  # console-api writes models.json, then asks the grant function to sync
        return 200, {'model': m}
    monkeypatch.setattr(run, 'console_api', console_api)
    return run, w


def no_secrets(tmp: pathlib.Path) -> None:
    for p in tmp.glob('*.json'):
        text = p.read_text()
        assert TOKEN not in text, p
        assert not re.search(r'(?<!\d)\d{12}(?!\d)', text), p


def test_cat_deploy(env: tuple[types.ModuleType, World], tmp_path: pathlib.Path) -> None:
    run, _w = env
    r = run.cmd_cat_deploy(run.ARGS)
    assert r['passed'], r['checks']
    assert set(r['checks']) >= {'version_after_bundled', 'same_content_as_bundled', 'router_state_line_from_bucket', 'ingest_record_carries_version'}
    no_secrets(tmp_path)


def test_cat_refresh_then_ingest(env: tuple[types.ModuleType, World], tmp_path: pathlib.Path) -> None:
    run, w = env
    r = run.cmd_cat_refresh(run.ARGS)
    assert r['passed'], {k: v for k, v in r['checks'].items() if not v}
    assert r['versions']['rolledBackTo'] == r['previousVersion']
    assert not run.RESTORE.exists()
    assert any(c.startswith('console PATCH') for c in w.calls) and 'console POST /api/admin/catalog/rollback' in w.calls
    i = run.cmd_cat_ingest(run.ARGS)
    assert i['passed'], i['checks']
    no_secrets(tmp_path)


def test_cat_grant_and_restore(env: tuple[types.ModuleType, World], tmp_path: pathlib.Path) -> None:
    run, w = env
    r = run.cmd_cat_grant(run.ARGS)
    assert r['model'] == NEW and r['kind'] == 'pending'
    assert r['passed'], {k: v for k, v in r['checks'].items() if not v}
    assert next(m for m in w.json('catalog/models.json')['models'] if m['modelId'] == NEW)['state'] == 'pending'
    assert not run.RESTORE.exists()
    no_secrets(tmp_path)


def test_cat_restore_after_an_interrupted_refresh(env: tuple[types.ModuleType, World]) -> None:
    run, w = env
    f = w.json('catalog/models.json')
    target = 'global.openai.gpt-5.6-terra'
    orig = copy.deepcopy(next(m for m in f['models'] if m['modelId'] == target))
    run.save_restore('cat-refresh', json.dumps(orig), target=target)
    next(m for m in f['models'] if m['modelId'] == target)['modelCardPrice']['price']['input'] = 99
    w.put('catalog/models.json', json.dumps(f))
    w.publish()
    w.rollback()
    run.cmd_cat_restore(run.ARGS)
    assert next(m for m in w.json('catalog/models.json')['models'] if m['modelId'] == target)['modelCardPrice'] == orig['modelCardPrice']
    assert 'refresh manual' in w.calls and w.current()['by'] == 'refresh'
    assert not run.RESTORE.exists()


def test_cat_assumptions_and_teardown(env: tuple[types.ModuleType, World]) -> None:
    run, w = env
    snap = json.loads((REPO / f'packages/pricing/data/snapshots/price-list.{REGION}.json').read_text())
    ids = json.loads((REPO / f'packages/pricing/data/snapshots/bedrock-ids.{REGION}.json').read_text())
    w.put('catalog/snapshots/20261116T030000Z.json', json.dumps({'schemaVersion': 1, 'capturedAt': snap['capturedAt'], 'region': REGION, 'rows': snap['rows'],
                                                                 'fallback': snap['fallback'], 'missing': snap['missing'], 'inferenceProfileIds': ids['inferenceProfileIds'],
                                                                 'foundationModels': ids['foundationModels'] + [{'modelId': 'meta.llama-9', 'inferenceTypesSupported': ['ON_DEMAND'], 'modelName': 'Llama 9'}]}))
    a = run.cmd_cat_assumptions(run.ARGS)
    assert a['checks']['snapshot_found'] and a['checks']['c_in_region_standard_rows'] and a['checks']['d_snapshot_covers_other_providers']
    # (b) cannot pass on the committed snapshot (it predates modelName capture): reported, not asserted here.
    assert a['report']['b_claude_modelName_is_sku']['noModelName']
    t = run.cmd_cat_teardown_verify(run.ARGS)
    assert t['passed']
