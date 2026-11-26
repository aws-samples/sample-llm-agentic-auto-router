"""Send a few sequential requests to check the endpoint, the served fast model and the token usage."""
import argparse
import asyncio
import json

import httpx

import common

p = argparse.ArgumentParser()
p.add_argument('--region', required=True)
p.add_argument('--prefix', default='llmar')
p.add_argument('--model', default='auto:fast')
p.add_argument('--max-out', type=int, default=64)
p.add_argument('-n', type=int, default=3)
a = p.parse_args()
s = common.session(a.region)
o = common.outputs(s, a.prefix)
tok, _ = common.token(s, o, a.prefix)
url = common.endpoint(o)


async def main() -> None:
    async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=10)) as c:
        for i in range(a.n):
            print(json.dumps(await common.call(c, url, tok, a.model, a.max_out, i, 'lt-probe')))

asyncio.run(main())
