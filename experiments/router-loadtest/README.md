# Router load test

Closed-loop load test of a deployed router through its front door (AgentCore Gateway → API Gateway → router), on
the OpenAI Chat Completions endpoint. Results and conclusions:
[docs/experiments/router-loadtest.zh-CN.md](../../docs/experiments/router-loadtest.zh-CN.md). Quotas and limits:
[deployment runbook, section 7](../../docs/deploy-runbook.md#7-capacity-quotas-and-limits).

> [!WARNING]
> **A load test spends real money and shares account-wide quotas with every other caller.** AgentCore Gateway's request
> rate (about 200 requests/s per account by default) and each Bedrock model's tokens-per-minute quota are shared by
> every caller in the account and Region: a test near those limits throttles other callers too. Every request is also
> recorded in the console's usage table (principal `P#none`). Prefer a separate account; otherwise stay below the
> limits and watch `AWS/Bedrock-AgentCore` `Throttles` for methods the test does not use.

## Files

| File | What it does |
|---|---|
| `common.py` | Stack outputs, a client-credentials token for the E2E agent client (never printed), one streamed Chat Completions call with timing (headers, first content token, end to end) |
| `probe.py` | A few sequential requests: checks the endpoint, the served model and the token usage |
| `loadgen.py` | The ladder: `--procs` client processes (default 4), each with asyncio workers; stages `<concurrency>[:<seconds>]` start on a minute boundary so they line up with 1-minute CloudWatch metrics; 429s are retried with exponential backoff and jitter; the ladder stops when a stage's error rate passes `--max-error-rate` (default 0.2) or when `<out>/stop` exists |
| `watch_scaling.py` | Samples the router service's task counts and its target-tracking alarm states every 15 s, then writes the scaling activities |
| `analyze.py` | Per stage: client-side throughput and latency percentiles, router log statistics (Logs Insights: `overheadMs`, `upstreamTtfbMs`, requests per task), ECS CPU and memory, API Gateway metrics, scaling activities. Writes `summary.json` and prints Markdown tables |
| `results-*/` | Summaries of the runs in the report (per-request data stays local): `stages.jsonl`, `summary.json`, `ecs.jsonl`, and for the scaling run `scaling-samples.jsonl` and `scaling-activities.json` |

## Run

Needs [uv](https://docs.astral.sh/uv/) and credentials for the deployment's account (`AWS_PROFILE` or
`LLMAR_PROFILE`). The caller needs read access to the router stack and its log group, CloudWatch, ECS, Application
Auto Scaling and `cognito-idp:DescribeUserPoolClient` on the E2E agent client.

```bash
cd experiments/router-loadtest
RUN="uv run --no-project --with boto3 --with httpx python"
$RUN probe.py --region <aws-region> [--prefix <prefix>] -n 3
$RUN loadgen.py --region <aws-region> --stages 20,50,100 --stage-s 180 --idle-s 60 --max-out 8 --out /tmp/<prefix>-lt-<date>
$RUN watch_scaling.py --region <aws-region> --minutes 55 --out /tmp/<prefix>-lt-<date>   # in parallel, for scaling runs
$RUN analyze.py --region <aws-region> --out /tmp/<prefix>-lt-<date>
```

- `--model` defaults to `auto:fast`. `--max-out` sets `max_completion_tokens`: Bedrock's quota counts output tokens
  several times over (about 10 × for `gpt-6-luna`), so a small value lets a test reach higher rates before the model
  quota throttles it. With reasoning models most responses then carry no visible text, which the router forwards the
  same way.
- Each request uses a new `x-router-session`, so every call is a session start (a routing decision and DynamoDB
  state writes with `stateStore=dynamodb`).
- To check the scaling policy below the gateway's rate, deploy temporarily with a lower `-c routerScaleCpu` and
  redeploy with the normal value afterwards; the report's round 2 did this with 30.
