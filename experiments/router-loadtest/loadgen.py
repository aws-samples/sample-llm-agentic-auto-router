"""Closed-loop load test of the router's Chat Completions endpoint with 4 client processes.

Each stage runs for --stage-s seconds at a fixed total concurrency split across the processes; every worker sends
one streamed request, waits for it to finish, and sends the next one. Stages start on a minute boundary so the
1-minute CloudWatch ECS metrics line up with the load, and an idle minute separates them.

Output (--out): stages.jsonl (one line per stage window), req-<stage>-<proc>.jsonl (one line per request),
proc-<stage>-<proc>.json (client CPU per process), ecs.jsonl (service samples every 15 s).
Stop early: touch <out>/stop, or a stage with more than --max-error-rate failures ends the ladder.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import multiprocessing as mp
import random
import resource
import threading
import time
from pathlib import Path

import httpx

import common


def split(total: int, n: int) -> list[int]:
    return [total // n + (1 if i < total % n else 0) for i in range(n)]


def proc_main(pid: int, conc: int, url: str, tok: str, model: str, max_out: int, t_end: float, stage: int, out: str) -> None:
    async def run() -> None:
        f = open(Path(out) / f'req-{stage}-{pid}.jsonl', 'w')
        limits = httpx.Limits(max_connections=conc + 8, max_keepalive_connections=conc + 8)
        async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=10), limits=limits) as c:
            async def worker(w: int) -> None:
                await asyncio.sleep(w * 5.0 / max(conc, 1))  # spread the ramp over ~5 s
                seq, backoff = 0, 0.0
                while time.time() < t_end and not (Path(out) / 'stop').exists():
                    r = await common.call(c, url, tok, model, max_out, pid * 100000 + w * 1000 + seq, f'lt-c{stage}')
                    r.update(stage=stage, proc=pid, worker=w)
                    f.write(json.dumps(r) + '\n')
                    seq += 1
                    if r['http'] == 429 or 'rate_limit' in r['kind']:
                        # Exponential backoff with full jitter (0.5 s doubling to 8 s), so throttling does not turn into a retry storm.
                        backoff = min(8.0, backoff * 2 if backoff else 0.5)
                        await asyncio.sleep(random.uniform(0, backoff))
                    else:
                        backoff = 0.0
            await asyncio.gather(*(worker(w) for w in range(conc)))
        f.close()
    t0 = time.time()
    asyncio.run(run())
    ru = resource.getrusage(resource.RUSAGE_SELF)
    (Path(out) / f'proc-{stage}-{pid}.json').write_text(json.dumps(
        {'stage': stage, 'proc': pid, 'conc': conc, 'wall': time.time() - t0, 'cpu_user': ru.ru_utime, 'cpu_sys': ru.ru_stime, 'maxrss_kb': ru.ru_maxrss}))


def ecs_sampler(s, o: dict[str, str], out: Path, stop: threading.Event) -> None:
    ecs = s.client('ecs')
    with open(out / 'ecs.jsonl', 'a') as f:
        while not stop.is_set():
            try:
                v = ecs.describe_services(cluster=o['ClusterName'], services=[o['ServiceName']])['services'][0]
                f.write(json.dumps({'ts': time.time(), 'running': v['runningCount'], 'desired': v['desiredCount'], 'pending': v['pendingCount'],
                                    'taskDef': v['taskDefinition'].rsplit(':', 1)[-1], 'deployments': [d.get('rolloutState') for d in v['deployments']]}) + '\n')
                f.flush()
            except Exception as e:  # noqa: BLE001 - sampling must not stop the run
                f.write(json.dumps({'ts': time.time(), 'error': type(e).__name__}) + '\n')
            stop.wait(15)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('--region', required=True)
    p.add_argument('--prefix', default='llmar')
    p.add_argument('--model', default='auto:fast')
    p.add_argument('--max-out', type=int, default=64)
    p.add_argument('--procs', type=int, default=4)
    p.add_argument('--stages', default='4,20,50,100,150,200', help='comma list of <concurrency>[:<seconds>]')
    p.add_argument('--stage-s', type=int, default=180)
    p.add_argument('--idle-s', type=int, default=60)
    p.add_argument('--max-error-rate', type=float, default=0.2)
    p.add_argument('--out', required=True)
    a = p.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    s = common.session(a.region)
    o = common.outputs(s, a.prefix)
    url = common.endpoint(o)
    (out / 'meta.json').write_text(json.dumps({'model': a.model, 'max_out': a.max_out, 'procs': a.procs, 'stages': a.stages,
                                               'stage_s': a.stage_s, 'idle_s': a.idle_s, 'cluster': o['ClusterName'], 'service': o['ServiceName'],
                                               'restApiId': o.get('RestApiId'), 'logGroup': o.get('RouterLogGroup'), 'started': time.time()}))
    stop = threading.Event()
    th = threading.Thread(target=ecs_sampler, args=(s, o, out, stop), daemon=True)
    th.start()
    ctx = mp.get_context('spawn')
    try:
        for spec in a.stages.split(','):
            stage, _, dur = spec.partition(':')
            stage, stage_s = int(stage), int(dur or a.stage_s)
            if (out / 'stop').exists():
                break
            tok, exp = common.token(s, o, a.prefix)
            assert exp > time.time() + stage_s + 120
            t_start = (int(time.time() / 60) + 1) * 60 + 1  # next minute boundary
            time.sleep(max(0.0, t_start - time.time()))  # nosemgrep: arbitrary-sleep -- wait for the next minute boundary so stages line up with 1-minute CloudWatch metrics
            t_end = t_start + stage_s
            ps = [ctx.Process(target=proc_main, args=(i, c, url, tok, a.model, a.max_out, t_end, stage, str(out)))
                  for i, c in enumerate(split(stage, a.procs)) if c > 0]
            for x in ps:
                x.start()
            for x in ps:
                x.join()
            rows = [json.loads(l) for i in range(a.procs) if (out / f'req-{stage}-{i}.jsonl').exists() for l in open(out / f'req-{stage}-{i}.jsonl')]
            ok = sum(r['ok'] for r in rows)
            line = {'stage': stage, 't_start': t_start, 't_end': t_end, 't_done': time.time(), 'n': len(rows), 'ok': ok}
            with open(out / 'stages.jsonl', 'a') as f:
                f.write(json.dumps(line) + '\n')
            print(json.dumps(line), flush=True)
            if rows and (len(rows) - ok) / len(rows) > a.max_error_rate:
                print('error rate above limit, stopping', flush=True)
                break
            time.sleep(a.idle_s)  # nosemgrep: arbitrary-sleep -- idle gap between stages (--idle-s) so each stage has its own metric minutes
    finally:
        time.sleep(30)  # nosemgrep: arbitrary-sleep -- one more ECS sample after the last stage before the sampler stops
        stop.set()
        th.join(timeout=20)


if __name__ == '__main__':
    main()
