"""Shared helpers for the router load test: stack outputs, a client-credentials token, one streamed Chat Completions call.

Credentials come from the caller's AWS profile (LLMAR_PROFILE, default AWS_PROFILE); region and prefix are arguments.
Nothing here prints the token or the client secret.
"""
from __future__ import annotations

import base64
import json
import os
import time
import uuid
from typing import Any
from urllib.parse import urlsplit

import boto3
import httpx


def session(region: str) -> boto3.Session:
    return boto3.Session(profile_name=os.environ.get('LLMAR_PROFILE') or os.environ.get('AWS_PROFILE'), region_name=region)


def outputs(s: boto3.Session, prefix: str) -> dict[str, str]:
    st = s.client('cloudformation').describe_stacks(StackName=f'{prefix}-router')['Stacks'][0]
    return {o['OutputKey']: o['OutputValue'] for o in st.get('Outputs', [])}


def endpoint(o: dict[str, str]) -> str:
    u = urlsplit(o['GatewayUrl'])
    assert u.scheme == 'https' and '.gateway.bedrock-agentcore.' in (u.hostname or '')
    return f'https://{u.hostname}/inference/v1/chat/completions'


def token(s: boto3.Session, o: dict[str, str], prefix: str) -> tuple[str, float]:
    """Client-credentials access token for the E2E agent client and its expiry (epoch seconds)."""
    c = s.client('cognito-idp').describe_user_pool_client(UserPoolId=o['UserPoolId'], ClientId=o['AgentClientId'])['UserPoolClient']
    basic = base64.b64encode(f"{c['ClientId']}:{c['ClientSecret']}".encode()).decode()
    r = httpx.post(o['TokenEndpoint'], data={'grant_type': 'client_credentials', 'scope': f'{prefix}/invoke'},
                   headers={'authorization': f'Basic {basic}'}, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f'token endpoint HTTP {r.status_code}')
    j = r.json()
    return j['access_token'], time.time() + int(j.get('expires_in', 3600))


WORDS = ['river', 'lantern', 'harbor', 'maple', 'comet', 'granite', 'meadow', 'compass', 'violin', 'glacier',
         'orchard', 'beacon', 'canyon', 'falcon', 'ember', 'prairie', 'quartz', 'tundra', 'willow', 'zephyr']


def body(model: str, seq: int, max_out: int) -> dict[str, Any]:
    w = WORDS[seq % len(WORDS)]
    return {'model': model, 'stream': True, 'stream_options': {'include_usage': True}, 'max_completion_tokens': max_out,
            'messages': [{'role': 'user', 'content': f'Write one short sentence about a {w}. Request {seq}.'}]}


async def call(client: httpx.AsyncClient, url: str, tok: str, model: str, max_out: int, seq: int, tag: str) -> dict[str, Any]:
    """One streamed request. Records HTTP status, time to headers, time to first content token, end-to-end time,
    terminal state, served model and usage."""
    sid = f'{tag}-{uuid.uuid4()}'
    a: dict[str, Any] = {'seq': seq, 'ts': time.time(), 'http': 0, 'kind': 'unknown', 'done': False}
    h = {'authorization': f'Bearer {tok}', 'content-type': 'application/json', 'x-router-session': sid}
    t = time.monotonic()
    try:
        async with client.stream('POST', url, json=body(model, seq, max_out), headers=h) as r:
            a['http'] = r.status_code
            a['hdr'] = time.monotonic() - t
            a['served'] = r.headers.get('x-router-model')
            a['tier'] = r.headers.get('x-router-tier')
            if r.status_code != 200:
                raw = await r.aread()
                try:
                    j = json.loads(raw)
                    e = j.get('error', j)
                    a['kind'] = 'http:' + str((e.get('code') or e.get('type') or e.get('message')) if isinstance(e, dict) else e)[:80]
                except ValueError:
                    a['kind'] = 'http:' + raw[:80].decode(errors='replace')
            else:
                fields: list[str] = []
                async for line in r.aiter_lines():
                    if line.startswith('data:'):
                        fields.append(line[5:].lstrip(' '))
                        continue
                    if line or not fields:
                        continue
                    raw = '\n'.join(fields)
                    fields = []
                    if raw == '[DONE]':
                        a['done'] = True
                        break
                    ev = json.loads(raw)
                    if 'error' in ev:
                        a['kind'] = 'stream-error:' + str(ev['error'].get('code') or ev['error'].get('type'))[:60]
                        break
                    a['model'] = ev.get('model') or a.get('model')
                    for ch in ev.get('choices') or []:
                        d = ch.get('delta') or {}
                        if d.get('content') and 'ttft' not in a:
                            a['ttft'] = time.monotonic() - t
                        if ch.get('finish_reason'):
                            a['finish'] = ch['finish_reason']
                    if ev.get('usage'):
                        u = ev['usage']
                        a['in'] = u.get('prompt_tokens')
                        a['out'] = u.get('completion_tokens')
                        a['reason'] = (u.get('completion_tokens_details') or {}).get('reasoning_tokens')
                if a['kind'] == 'unknown':
                    a['kind'] = 'ok' if a['done'] and a.get('finish') in ('stop', 'length') else 'no-terminal'
    except (httpx.HTTPError, OSError, ValueError) as e:
        a['kind'] = type(e).__name__
    a['e2e'] = time.monotonic() - t
    a['ok'] = a['kind'] == 'ok'
    return a
