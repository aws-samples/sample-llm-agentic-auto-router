"""Summarize a loadgen.py run: client-side stats per stage, router log stats (Logs Insights), ECS CPU/memory and
API Gateway metrics (CloudWatch, 1-minute). Writes summary.json and prints Markdown tables."""
from __future__ import annotations

import argparse
import json
import statistics
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import common

p = argparse.ArgumentParser()
p.add_argument('--region', required=True)
p.add_argument('--out', required=True)
p.add_argument('--warmup-s', type=int, default=10)
a = p.parse_args()
out = Path(a.out)
meta = json.loads((out / 'meta.json').read_text())
stages = [json.loads(l) for l in open(out / 'stages.jsonl')]
s = common.session(a.region)
cw, logs, apigw = s.client('cloudwatch'), s.client('logs'), s.client('apigateway')
TASK_MEM_MIB, TASK_CPU_UNITS = 2048, 1024


def pct(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, round(q / 100 * len(xs) + 0.5) - 1))]


def ms(x: float | None) -> str:
    return '-' if x is None else f'{x * 1000:.0f}'


def metric(ns: str, name: str, dims: list[dict[str, str]], t0: int, t1: int, stat: str) -> dict[int, float]:
    r = cw.get_metric_statistics(Namespace=ns, MetricName=name, Dimensions=dims, StartTime=datetime.fromtimestamp(t0, timezone.utc),
                                 EndTime=datetime.fromtimestamp(t1, timezone.utc), Period=60, Statistics=[stat])
    return {int(d['Timestamp'].timestamp()): d[stat] for d in r['Datapoints']}


def insights(t0: int, t1: int) -> dict:
    q = ('filter kind = "model" and requested = "auto:fast" | stats count(*) as n, sum(status = 200) as ok, '
         'avg(overheadMs) as ovAvg, pct(overheadMs, 50) as ov50, pct(overheadMs, 99) as ov99, max(overheadMs) as ovMax, '
         'pct(decideMs, 50) as dec50, pct(decideMs, 99) as dec99, '
         'pct(upstreamTtfbMs, 50) as up50, pct(upstreamTtfbMs, 99) as up99, pct(durationMs, 50) as dur50, pct(durationMs, 99) as dur99')
    qid = logs.start_query(logGroupName=meta['logGroup'], startTime=t0, endTime=t1, queryString=q)['queryId']
    for _ in range(90):
        r = logs.get_query_results(queryId=qid)
        if r['status'] == 'Complete':
            return {f['field']: float(f['value']) for f in (r['results'] or [[]])[0] if f['field'] != '@ptr'}
        time.sleep(1)  # nosemgrep: arbitrary-sleep -- poll interval while a Logs Insights query runs (bounded to 90 polls)
    raise TimeoutError('insights')


def per_task(t0: int, t1: int) -> dict[str, int]:
    q = 'filter kind = "model" and requested = "auto:fast" | stats count(*) as n by @logStream'
    qid = logs.start_query(logGroupName=meta['logGroup'], startTime=t0, endTime=t1, queryString=q)['queryId']
    for _ in range(90):
        r = logs.get_query_results(queryId=qid)
        if r['status'] == 'Complete':
            rows = [{f['field']: f['value'] for f in row} for row in r['results']]
            return {x['@logStream'].rsplit('/', 1)[-1][:8]: int(x['n']) for x in rows}
        time.sleep(1)  # nosemgrep: arbitrary-sleep -- poll interval while a Logs Insights query runs (bounded to 90 polls)
    raise TimeoutError('insights')


ecs_samples = [json.loads(l) for l in open(out / 'ecs.jsonl')] if (out / 'ecs.jsonl').exists() else []


def statuses(t0: int, t1: int) -> list[dict]:
    q = 'filter kind = "model" and requested = "auto:fast" | stats count(*) as n by status, reason'
    qid = logs.start_query(logGroupName=meta['logGroup'], startTime=t0, endTime=t1, queryString=q)['queryId']
    for _ in range(90):
        r = logs.get_query_results(queryId=qid)
        if r['status'] == 'Complete':
            return [{f['field']: f['value'] for f in row if f['field'] != '@ptr'} for row in r['results']]
        time.sleep(1)  # nosemgrep: arbitrary-sleep -- poll interval while a Logs Insights query runs (bounded to 90 polls)
    raise TimeoutError('insights')


ecs_dims = [{'Name': 'ClusterName', 'Value': meta['cluster']}, {'Name': 'ServiceName', 'Value': meta['service']}]
api_name = apigw.get_rest_api(restApiId=meta['restApiId'])['name'] if meta.get('restApiId') else None
t_lo, t_hi = stages[0]['t_start'] - 300, stages[-1]['t_end'] + 300
cpu_avg = metric('AWS/ECS', 'CPUUtilization', ecs_dims, t_lo, t_hi, 'Average')
cpu_max = metric('AWS/ECS', 'CPUUtilization', ecs_dims, t_lo, t_hi, 'Maximum')
mem_avg = metric('AWS/ECS', 'MemoryUtilization', ecs_dims, t_lo, t_hi, 'Average')
mem_max = metric('AWS/ECS', 'MemoryUtilization', ecs_dims, t_lo, t_hi, 'Maximum')
api_dims = [{'Name': 'ApiName', 'Value': api_name}, {'Name': 'Stage', 'Value': 'v1'}] if api_name else []
api_cnt = metric('AWS/ApiGateway', 'Count', api_dims, t_lo, t_hi, 'Sum') if api_name else {}
api_5xx = metric('AWS/ApiGateway', '5XXError', api_dims, t_lo, t_hi, 'Sum') if api_name else {}
api_4xx = metric('AWS/ApiGateway', '4XXError', api_dims, t_lo, t_hi, 'Sum') if api_name else {}
api_lat = metric('AWS/ApiGateway', 'Latency', api_dims, t_lo, t_hi, 'Average') if api_name else {}
api_int = metric('AWS/ApiGateway', 'IntegrationLatency', api_dims, t_lo, t_hi, 'Average') if api_name else {}

summary = {'meta': meta, 'stages': [], 'minutes': []}
for st in stages:
    c, t0, t1 = st['stage'], st['t_start'], st['t_end']
    rows = [json.loads(l) for f in sorted(out.glob(f'req-{c}-*.jsonl')) for l in open(f)]
    steady = [r for r in rows if r['ts'] >= t0 + a.warmup_s and r['ts'] + r['e2e'] <= t1 + 0.5]
    done_in = [r for r in rows if t0 + a.warmup_s <= r['ts'] + r['e2e'] <= t1]
    win = t1 - t0 - a.warmup_s
    ok = [r for r in steady if r['ok']]
    procs = [json.loads(f.read_text()) for f in sorted(out.glob(f'proc-{c}-*.json'))]
    minutes = [m for m in range(t0 - 1, t1 - 1, 60)]  # t_start = minute boundary + 1 s
    full = minutes[1:]  # drop the ramp minute
    row = {
        'conc': c, 'requests': len(rows), 'ok_all': sum(r['ok'] for r in rows), 'kinds': Counter(r['kind'] for r in rows).most_common(6),
        'rps': len(done_in) / win, 'ok_rps': sum(r['ok'] for r in done_in) / win, 'steady_n': len(steady),
        'hdr': {q: pct([r['hdr'] for r in ok if 'hdr' in r], q) for q in (50, 90, 99)},
        'ttft': {q: pct([r['ttft'] for r in ok if 'ttft' in r], q) for q in (50, 90, 99)},
        'e2e': {q: pct([r['e2e'] for r in ok], q) for q in (50, 90, 99, 100)},
        'empty_content': sum(1 for r in ok if 'ttft' not in r),
        'tokens_out_avg': statistics.mean([r.get('out') or 0 for r in ok]) if ok else None,
        'client_cpu_pct': [round(100 * (x['cpu_user'] + x['cpu_sys']) / x['wall'], 1) for x in procs],
        'served': Counter(r.get('served') for r in rows).most_common(3),
        'ecs_cpu_avg': [cpu_avg.get(m) for m in minutes], 'ecs_cpu_max': [cpu_max.get(m) for m in minutes],
        'ecs_mem_avg': [mem_avg.get(m) for m in minutes], 'ecs_mem_max': [mem_max.get(m) for m in minutes],
        'ecs_cpu_steady': statistics.mean([cpu_avg[m] for m in full if m in cpu_avg]) if any(m in cpu_avg for m in full) else None,
        'ecs_mem_steady': statistics.mean([mem_avg[m] for m in full if m in mem_avg]) if any(m in mem_avg for m in full) else None,
        'api_count': [api_cnt.get(m) for m in minutes], 'api_5xx': [api_5xx.get(m) for m in minutes], 'api_4xx': [api_4xx.get(m) for m in minutes],
        'api_latency': [api_lat.get(m) for m in minutes], 'api_integration': [api_int.get(m) for m in minutes],
        'router': insights(t0 + a.warmup_s, t1), 'router_status': statuses(t0, t1 + 120), 'per_task': per_task(t0, t1),
        'running_tasks': sorted({x['running'] for x in ecs_samples if t0 <= x['ts'] <= t1 and 'running' in x}),
        'task_timeline': [(round(x['ts'] - t0), x['running'], x['desired']) for x in ecs_samples if t0 <= x['ts'] <= t1 and 'running' in x],
    }
    summary['stages'].append(row)
for m in sorted(set(cpu_avg) | set(mem_avg)):
    summary['minutes'].append({'t': datetime.fromtimestamp(m, timezone.utc).strftime('%H:%M'), 'cpu_avg': cpu_avg.get(m), 'cpu_max': cpu_max.get(m),
                               'mem_avg': mem_avg.get(m), 'mem_max': mem_max.get(m), 'api_count': api_cnt.get(m)})
aas = s.client('application-autoscaling')
acts = aas.describe_scaling_activities(ServiceNamespace='ecs', ResourceId=f"service/{meta['cluster']}/{meta['service']}")['ScalingActivities']
summary['scaling'] = [{'start': x['StartTime'].strftime('%H:%M:%S'), 'end': x.get('EndTime') and x['EndTime'].strftime('%H:%M:%S'), 'status': x['StatusCode'],
                       'desc': x['Description'], 'cause': x['Cause'][:200]} for x in acts if x['StartTime'].timestamp() >= stages[0]['t_start'] - 600]
(out / 'summary.json').write_text(json.dumps(summary, indent=1, default=str))


def f1(x: float | None) -> str:
    return '-' if x is None else f'{x:.1f}'


print('| 并发 | 请求数 | 成功率 | 吞吐 RPS | 首字节 p50/p99 ms | 首 token p50/p99 ms | 端到端 p50/p90/p99 ms | router 开销 p50/p99 ms | 上游首字节 p50/p99 ms | ECS CPU % (稳态均值) | ECS 内存 % (稳态均值) |')
print('|---|---|---|---|---|---|---|---|---|---|---|')
for r in summary['stages']:
    ro = r['router']
    print(f"| {r['conc']} | {r['requests']} | {100 * r['ok_all'] / max(1, r['requests']):.2f}% | {r['rps']:.1f} | {ms(r['hdr'][50])}/{ms(r['hdr'][99])} | "
          f"{ms(r['ttft'][50])}/{ms(r['ttft'][99])} | {ms(r['e2e'][50])}/{ms(r['e2e'][90])}/{ms(r['e2e'][99])} | "
          f"{ro.get('ov50', 0):.0f}/{ro.get('ov99', 0):.0f} | {ro.get('up50', 0):.0f}/{ro.get('up99', 0):.0f} | {f1(r['ecs_cpu_steady'])} | {f1(r['ecs_mem_steady'])} |")
print()
print('| UTC 分钟 | CPU 均值 % | CPU 最大 % | 内存均值 % | 内存最大 % | API GW 请求数 |')
print('|---|---|---|---|---|---|')
for m in summary['minutes']:
    print(f"| {m['t']} | {f1(m['cpu_avg'])} | {f1(m['cpu_max'])} | {f1(m['mem_avg'])} | {f1(m['mem_max'])} | {m['api_count'] or '-'} |")
for r in summary['stages']:
    print(r['conc'], 'kinds', r['kinds'], 'client cpu %', r['client_cpu_pct'], 'empty', r['empty_content'], 'status', r['router_status'],
          'api5xx', r['api_5xx'], 'api4xx', r['api_4xx'], 'per_task', r['per_task'], 'tasks', r['task_timeline'])
for x in summary['scaling']:
    print('scaling', x)
