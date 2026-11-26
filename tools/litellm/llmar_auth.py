"""LiteLLM proxy callback: inject a fresh LLM Agentic Auto Router access token on every call to the router.

Gets a Cognito client_credentials token, caches it until 5 minutes before expiry, and sets both headers the router
needs (Authorization for AgentCore Gateway, x-api-key for the router) on deployments whose api_base is the router's
Gateway URL. Other deployments are left untouched.

Environment: LLMAR_GATEWAY_URL, LLMAR_TOKEN_ENDPOINT, LLMAR_CLIENT_ID, LLMAR_CLIENT_SECRET, LLMAR_SCOPE.
"""
import asyncio
import os
import time

import httpx
from litellm.integrations.custom_logger import CustomLogger

_AUTH_HEADERS = ('authorization', 'x-api-key')


class LlmarAuth(CustomLogger):
    def __init__(self) -> None:
        super().__init__()
        self.gateway = os.environ['LLMAR_GATEWAY_URL'].rstrip('/')
        self._token, self._exp = '', 0.0
        self._lock = asyncio.Lock()

    async def _access_token(self) -> str:
        if self._exp - time.time() > 300:
            return self._token
        async with self._lock:
            if self._exp - time.time() > 300:
                return self._token
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.post(os.environ['LLMAR_TOKEN_ENDPOINT'],
                                 auth=(os.environ['LLMAR_CLIENT_ID'], os.environ['LLMAR_CLIENT_SECRET']),
                                 data={'grant_type': 'client_credentials', 'scope': os.environ['LLMAR_SCOPE']})
            r.raise_for_status()  # the error body never contains the secret
            j = r.json()
            self._token, self._exp = j['access_token'], time.time() + int(j.get('expires_in', 3600))
            return self._token

    async def async_pre_call_deployment_hook(self, kwargs, call_type):
        if not str(kwargs.get('api_base') or '').startswith(self.gateway):
            return None
        token = await self._access_token()
        # Drop any credential a client sent or the config holds, so only the router token goes upstream.
        for key in ('extra_headers', 'headers'):
            if isinstance(kwargs.get(key), dict):
                kwargs[key] = {k: v for k, v in kwargs[key].items() if k.lower() not in _AUTH_HEADERS}
        kwargs['api_key'] = token
        kwargs['extra_headers'] = {**(kwargs.get('extra_headers') or {}),
                                   'Authorization': f'Bearer {token}', 'x-api-key': token}
        return kwargs


proxy_handler_instance = LlmarAuth()
