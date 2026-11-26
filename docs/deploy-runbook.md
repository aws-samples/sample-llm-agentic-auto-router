# Deployment runbook

How to deploy, upgrade, verify, scale, roll back and tear down the router stack (`<prefix>-router`) and the admin
console stack (`<prefix>-console`). The reference for every deploy input and resource is
[infra/README.md](../infra/README.md); this page is the procedure. 中文版：[deploy-runbook.zh-CN.md](deploy-runbook.zh-CN.md).

> [!IMPORTANT]
> **This is sample code for demonstration and education. It is not production-ready as is.** Review its
> security, cost and Bedrock / API Gateway quotas against your own requirements before you deploy it in your
> account. You are responsible for the AWS costs it incurs.
>
> The stack has a **fixed cost of about USD 113/month in ap-southeast-1 while it is deployed**, even with the
> router scaled to 0 tasks (interface endpoints and the internal NLB), plus per-task, per-request and token
> charges. Other Regions differ. **Destroy the stack when you finish testing.** See
> [infra/README.md, "Cost and teardown"](../infra/README.md#cost-and-teardown).

> [!WARNING]
> **Pass the full deploy context on every deploy, router or console, and run `cdk diff` first.** CDK context is not
> remembered between deploys. A key you leave out falls back to its default, and some defaults remove or stop things:
>
> | Left out | What the deploy does |
> |---|---|
> | `stateStore=dynamodb` | deletes the router state table and its DynamoDB endpoint (state goes back into each task's memory) |
> | `routerAutoscale` / `routerDesiredCount` | falls back to `routerDesiredCount=0`: **the router stops** |
> | `allowedModelUniverse` | shrinks the models the router may invoke; console policies that name a dropped model get 400 `pin-not-allowed` |
> | `assessorMode`, `identityMode`, `throttle`, `consoleThrottle` | resets them to their defaults |
> | `tags` | removes your tags from every resource |
> | `consoleBundle=true`, `ingest=true` | removes the web app from the site bucket, or stops usage ingestion |

## 1. Before you start

**Tools** (on the machine that deploys):

- Node.js 24, pnpm (the version in `package.json`), AWS CLI v2, [uv](https://docs.astral.sh/uv/) for the E2E checks.
- Docker that can build `linux/arm64` images: an ARM64 host, or Docker Buildx with QEMU. `cdk deploy` builds the
  router and Lambda images itself.

**Account and Region:**

- Credentials that can assume the CDK bootstrap roles in the target account. CDK deploys through those roles, so
  the deploying identity does not need broad permissions of its own.
- Model access in Amazon Bedrock for the models in your policy, in the target Region.
- AgentCore Gateway's tool-call payload size quota raised from the default 6 MB to 10 MB in the target Region
  (`L-603BFD8F`, [7.3](#73-quota-increases-to-request-before-you-deploy)). Do this for every deployment: with the default,
  request bodies over 6 MB are rejected at the gateway.
- Quotas you will need under load. The tightest by default is AgentCore Gateway's request rate, **200 requests/s
  per account**, shared by every caller; then the Bedrock tokens-per-minute quota of each model you route to (the
  fast tier is usually the first one you hit). Request increases before you deploy: see
  [Quota increases to request before you deploy](#73-quota-increases-to-request-before-you-deploy).
- If the account holds other workloads, decide now how you will tell this deployment's resources apart: a unique
  `prefix` and your own `tags`. Every change a diff shows must be on `<prefix>-*` resources.

## 2. Decide the deployment parameters once

Write them into one context file that every deploy sources, outside the repository (it holds the account id and
the first admin's address). A bash example:

```bash
# ~/llmar-<prefix>.ctx.sh  (chmod 600; source it in bash, or in zsh with the arrays as written)
R=<aws-region>; A=<account-id>; P=<unique-prefix>
S3PL=$(aws ec2 describe-managed-prefix-lists --region $R --filters Name=prefix-list-name,Values=com.amazonaws.$R.s3 \
  --query 'PrefixLists[0].PrefixListId' --output text)
DDBPL=$(aws ec2 describe-managed-prefix-lists --region $R --filters Name=prefix-list-name,Values=com.amazonaws.$R.dynamodb \
  --query 'PrefixLists[0].PrefixListId' --output text)
CTX=(-c region=$R -c account=$A -c prefix=$P -c 'tags={"Owner":"<team>"}'
     -c allowedModelUniverse=catalog -c assessorMode=observe
     -c stateStore=dynamodb -c routerAutoscale=2,4 -c routerScaleCpu=60
     -c throttle=1000,2000
     -c console=true -c consoleBundle=true -c ingest=true -c consoleThrottle=1000,2000
     -c adminEmail=<first-admin-e-mail>)
PARAMS=(--parameters $P-router:S3PrefixListId=$S3PL --parameters $P-router:DynamoDbPrefixListId=$DDBPL)
```

Choices to make:

| Decision | Options | Recommendation |
|---|---|---|
| Task count | fixed `routerDesiredCount=<n>`, or `routerAutoscale=<min>,<max>` (give one, not both) | Autoscaling with `min` ≥ 2 for a shared test or a load test; a fixed `1` for a trial. |
| Routing state | `stateStore=memory` (one task at most) or `dynamodb` (any number of tasks) | `dynamodb` whenever more than one task may run. Switching it later is a redeploy; the state is short-lived and rebuilds. |
| Model universe | `policy`, `catalog` or a list | `catalog` if admins should be able to choose any model the Region offers. Never narrow it without first removing the dropped models from the console policy. |
| Assessor | off, `observe`, `auto` | `observe`; admins turn rules on in the console after review. |
| Identity | `off`, `observe`, `require` | Start at `observe`, switch to `require` in the console once the unattributed share is near zero. **Until then, member blocks, budgets and tier limits are not enforced** for callers that send no valid `x-api-key`. |
| Throttles | `throttle`, `consoleThrottle` (`<rate>,<burst>`) | Defaults (1000,2000) leave room; lower them if the account's API Gateway quota is shared with busy workloads. |

`adminEmail` is needed on the first console deploy (it creates the first admin). Keep passing the same value on later
deploys so the diff stays clean; read it back from the live template if you do not have it
(`Resources.SeedAdmin.Properties.email` in `<prefix>-console`), and keep it out of the repository.

## 3. Prepare a clean build tree

CDK builds the router image and the Lambda code from the working tree, so deploy only from a clean checkout of the
exact commit you mean to ship, never from a tree with local edits or untracked files.

```bash
SHA=$(git rev-parse --short <commit>)              # e.g. origin/main after the merge request merged
git worktree add /tmp/<prefix>-deploy-$SHA $SHA
cd /tmp/<prefix>-deploy-$SHA
umask 022                                          # images and assets must be readable by the runtime user
pnpm install --frozen-lockfile --prefer-offline
pnpm -C packages/console-web build                 # needed whenever consoleBundle=true, also for router-only deploys
pnpm -C infra typecheck && pnpm -C infra test      # assertions and cdk-nag
```

If the change touches router or Lambda code, also run the strip-only check (Node runs the TypeScript sources by type
stripping, which tests do not exercise), for example
`(cd packages/usage-ingest && node ../../scripts/node-strip-check.mjs --import src/handler.ts src)`.

Remove the worktree after the deploy (`git worktree remove /tmp/<prefix>-deploy-$SHA`).

## 4. First deployment in an account and Region

Anonymous denial is checked before anything restricted exists, and again at each step that opens a path.

1. **Bootstrap** (once per account and Region): `(cd infra && npx cdk bootstrap aws://$A/$R "${CTX[@]}")`.
2. **Router at 0 tasks.** Use a fixed count for this step: replace `routerAutoscale…` in `CTX` with
   `-c routerDesiredCount=0`, then `(cd infra && npx cdk deploy $P-router --exclusively "${CTX[@]}" "${PARAMS[@]}")`.
3. **Gate E0** (anonymous, bad token, direct API, direct NLB and task: all denied). Set `LLMAR_SPIKE_ACCOUNT` to the
   target account (the runner refuses any other), then
   `uv run packages/router/e2e/run.py --region $R --prefix $P e0`.
4. **Router serving.** Deploy again with your real task setting (`routerAutoscale=…` or `routerDesiredCount=1`) and
   run `e0` again, then `run.py … all` and `run.py … e0-teardown` (it removes E0's probe stack).
5. **Console, closed.** Deploy `$P-console` with `consoleBundle` and `ingest` off and with `adminEmail`. Check that
   every `/api/*` route answers 401 without a token and that the site bucket answers 403 when called directly.
6. **Console web app.** Deploy again with `consoleBundle=true`. Sign in as the first admin (Cognito e-mails a
   temporary password) and check the pages.
7. **Usage ingest.** Deploy again with `ingest=true`. Usage appears on the Overview within minutes.
8. **Identity.** Members set up their tools (README, Connecting clients); when the Overview's unattributed share is
   near zero, switch identity to `require` in the console (Settings, Deployment). Until you do, a caller without a
   valid `x-api-key` is served unattributed, and member blocks, budget stops and tier limits do not apply to it.

From here on, every deploy uses the full `CTX` of section 2.

## 5. Routine upgrade

1. Merge the change, then prepare a clean tree at the merged commit (section 3).
2. **Diff both stacks:**
   ```bash
   cd infra && npx cdk diff $P-router $P-console "${CTX[@]}" "${PARAMS[@]}" 2>&1 | tee /tmp/$P-diff.log
   ```
   Read it before going on:
   - every changed resource belongs to `$P-router` or `$P-console`;
   - nothing is deleted or replaced that you did not intend (tables, the state table, the user pool, buckets);
   - a router image change replaces the tasks (step 4); a diff that only touches the console bundle needs only the
     console deploy.
3. **Deploy the router first, then the console** (the console reads router values from SSM at deploy):
   ```bash
   npx cdk deploy $P-router  --exclusively "${CTX[@]}" "${PARAMS[@]}"
   npx cdk deploy $P-console --exclusively "${CTX[@]}" "${PARAMS[@]}"
   ```
   Skip a stack whose diff is empty.
4. **What clients see during a router deploy.** New tasks start and pass health checks before old ones stop. An old
   task stops taking new connections, and a stream already running on it has about 135 seconds to finish; a longer
   one is cut and the client retries. Each task stop adds up to 150 seconds to the deploy. Deploy at a quiet time if
   members run long agent sessions.
5. **Verify** (section 6). If anything fails, roll back (section 9).

Changes to routing policy, assessor rules, aliases, members or budgets are configuration versions in the console.
They take effect within about 30 seconds without a deploy.

## 6. Verify after every deploy

| Check | How | Expected |
|---|---|---|
| Stacks | `aws cloudformation describe-stacks --stack-name $P-router` (and `$P-console`) | `UPDATE_COMPLETE` |
| Router service | `aws ecs describe-services --cluster $P-cluster --services $P-router` | `runningCount` = `desiredCount`, one deployment, `COMPLETED`, the expected task definition revision |
| Scaling (autoscale only) | `aws application-autoscaling describe-scalable-targets --service-namespace ecs` | `service/$P-cluster/$P-router` with your min and max, nothing suspended |
| NLB targets | `aws elbv2 describe-target-health --target-group-arn <router TG>` | every target `healthy` |
| End to end | `uv run packages/router/e2e/run.py --region $R --prefix $P e1`, then `e3` | both pass (a few short Bedrock calls) |
| Gateway closed | the gateway URL without a token | 401 |
| Console closed | `curl -s -o /dev/null -w '%{http_code}' <ConsoleUrl>/api/me` | 401 |
| Console version | `<ConsoleUrl>/build.json` | the commit you deployed (console deploys only) |
| Usage ingest | Lambda `$P-usage-ingest` `Errors` metric since the deploy; `$P-usage-ingest-dlq` depth | 0 and 0 |
| Router logs | `/<prefix>/router`: lines with `kind = "error"` since the deploy | none new |

If the DLQ is not empty after a fix, replay it as described in
[packages/usage-ingest/README.md](../packages/usage-ingest/README.md#failures-and-replay).

## 7. Capacity, quotas and limits

### 7.1 Router capacity and autoscaling

Measured on short streamed requests ([load test](experiments/router-loadtest.zh-CN.md)): one 1-vCPU / 2 GiB task uses
about 0.46 % CPU per request/s and saturates near 210 RPS; memory stays under 25 %. Plan about 150 RPS per task
(about 70 % CPU). Two tasks split the load evenly through the NLB and share their state through DynamoDB. Long agent
streams cost more CPU per request than that test, so measure with your own traffic before you size `max`.

- **Autoscaling** (`routerAutoscale=<min>,<max>`, `routerScaleCpu`, default 60): target tracking on the service's
  average CPU. It adds tasks after 3 minutes above the target (then a 60-second cooldown) and removes them after
  15 minutes below 90 % of it (300-second cooldown). A new task takes 1–2 minutes to serve, so keep `min` high
  enough for sudden bursts. A deploy keeps the current count.
- **Change min, max or the target** by redeploying with new values. Do not run `aws ecs update-service --desired-count`
  on an autoscaled service: the policy moves it back. A scalable target changed by hand is reset by the next deploy.
- **More tasks do not raise the ceiling of the whole path.** With the default AgentCore Gateway quota (200 requests/s,
  see 7.2), two tasks already have more CPU than the gateway lets through; extra tasks add redundancy, not throughput.

### 7.2 Quotas and limits on the request path

Values are the defaults or what this project measured; check your account's values in Service Quotas and the
service documentation, since they change.

| Layer | Limit | Value | When it is hit |
|---|---|---|---|
| AgentCore Gateway | Request rate per gateway, and per account (inference requests count as tool calls) | **200 requests/s** each ([AgentCore quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)). Service Quotas may list 2,000 (L-8CAB3FF3, L-A0D48779); on 2026-11-24 the effective rate was still about 200/s | 429 in about 20 ms, before the router (no router log line); metric `AWS/Bedrock-AgentCore` `Throttles`. The account-level rate is shared by every gateway and every caller in the account and Region: one heavy client throttles everyone |
| AgentCore Gateway | Concurrent connections per gateway, and per account | 10,000 each | Long streams hold a connection for their whole duration |
| AgentCore Gateway | Invocation timeout | 15 minutes | Matches API Gateway's stream limit |
| AgentCore Gateway | Tool-call/tool-list/tool-search payload size (Service Quotas `L-603BFD8F`, adjustable) | **6 MB by default**; raise it to 10 MB before you deploy (7.3). This project's E8 check passed 9.5 MiB requests after the increase | Requests over the quota are rejected by the gateway and never reach the router. With 10 MB, the effective request cap is API Gateway's 10 MiB (next rows) |
| AgentCore Gateway | Customer-configured rate limits (per caller, target or model) | none configured by this stack | Optional: cap a single caller (JWT `sub`) so it cannot use the whole account rate. The effective rate is the lower of the service limit and yours |
| API Gateway (private REST API) | Stage throttling | `throttle`, default 1000 requests/s, burst 2000 | 429 from API Gateway; `AWS/ApiGateway` `4XXError` |
| API Gateway | Account rate per Region | 10,000 requests/s, burst 5,000 (default) | Shared by every API in the account and Region |
| API Gateway | Request payload | 10 MiB (hard limit) | 413 before the router |
| API Gateway | Stream duration and idle time | 15 minutes per response; 5 minutes idle on private endpoints | The stream ends; the router logs `stream-duration-cap` (499). The router's own idle timeout (240 s) fires first |
| Router | Request body, stream cap, idle timeout | 10 MiB (`ROUTER_MAX_BODY_BYTES`), 900 s (`ROUTER_STREAM_CAP_MS`), 240 s | 413, 499 `stream-duration-cap` |
| Router | Throughput per 1-vCPU task | about 210 requests/s (short streams) | Overhead and latency rise near saturation; add tasks (7.1) |
| Amazon Bedrock | Tokens per minute (and requests per minute, where listed) per model, per Region and per profile type (global and geographic profiles have separate quotas) | Per model in Service Quotas (for example 4M tokens/minute for `gpt-6-luna`) | 429 `rate_limit_exceeded` through the router (router log `upstreamError`); `AWS/Bedrock` `InvocationThrottles`. The quota counts output tokens several times over: `EstimatedTPMQuotaUsage` was about input + 10 × output for `gpt-6-luna` |
| Console HTTP API | Stage throttling, payload | `consoleThrottle`, default 1000/2000; 10 MB | 429 or 413 on the console API |
| Amazon Cognito | Request-rate quotas for token requests | per user pool, in Service Quotas | Service clients should cache their 60-minute access token instead of fetching one per call |
| DynamoDB (on-demand) | Per-partition throughput | adapts on demand | The usage table showed write throttle events at about 250 requests/s; usage-ingest retried them and lost nothing (Errors 0, DLQ empty). Watch it if you run at that rate for long |

### 7.3 Quota increases to request before you deploy

Estimate the peak request rate and the number of concurrent streams first. Then, before you deploy
or run a load test:

1. **AgentCore Gateway payload size, always.** Raise *Tool-call/tool-list/tool-search payload size* (`L-603BFD8F`)
   from the default 6 MB to 10 MB in the deployment Region: Service Quotas console → AWS services → Amazon Bedrock
   AgentCore → the quota → *Request increase at account level*, or
   `aws service-quotas request-service-quota-increase --service-code bedrock-agentcore --quota-code L-603BFD8F --desired-value 10 --region $R`.
   Check the applied value with `aws service-quotas get-service-quota` (same codes) once the request closes.
2. **AgentCore Gateway request rate**, if the peak may pass about 150 requests/s (leave headroom below 200). Ask
   for both the per-gateway and the per-account rate. If Service Quotas already shows a higher value than you
   observe, open an AWS Support case for AgentCore Gateway and quote the observed `Throttles`.
3. **Bedrock tokens per minute** for the model of each tier that carries the load (the fast tier first), in the
   Region and for the profile type the policy uses (global or geographic). Size it as peak requests/minute ×
   (input + burndown × output) tokens, using `EstimatedTPMQuotaUsage` from a test run to find the burndown.
4. **API Gateway account rate**, only if other busy APIs share the account and Region.
5. **Router `max`** to the peak rate ÷ 150, plus one for redundancy.
6. **Clients** retry 429 with exponential backoff and jitter. Without it, a short throttle turns into a retry storm
   that uses up the gateway rate for everyone in the account.

Load tests count against the same account-wide quotas as every other caller in the account: run them in a separate account, or keep them
below the limits and watch `AWS/Bedrock-AgentCore` `Throttles` for methods your test does not use.

## 8. Changing the state store or the task setting

- **`memory` → `dynamodb`**: deploy with `-c stateStore=dynamodb` and the `DynamoDbPrefixListId` parameter. The
  tasks restart and start with empty state; conversations route cold once (cache misses, no errors).
- **Fixed count → autoscaling**: replace `routerDesiredCount` with `routerAutoscale`. The diff shows the scalable
  target and the policy added and `DesiredCount` removed; the running tasks are not restarted, and the scaling
  target raises the count to `min` right away.
- **Autoscaling → fixed count**: replace `routerAutoscale` with `routerDesiredCount=<n>` in the same deploy. Never
  drop both.

## 9. Rollback

| What went wrong | Rollback |
|---|---|
| A deploy fails mid-way | CloudFormation rolls the stack back by itself, and the ECS deployment circuit breaker rolls back tasks that do not become healthy. Check the stack events, fix, deploy again. |
| A deploy succeeded but the new version misbehaves | Prepare a clean tree at the previous good commit (section 3) and deploy it with the same `CTX`. Diff first: a rollback must not drop resources that later deploys added on purpose (for example the state table). |
| A configuration version misbehaves | In the console, open Routing policy, Versions, and activate the previous version. No deploy needed. |
| Usage records failed to ingest | Fix, then replay the DLQ (see section 6). |

## 10. Teardown

Export the console and usage tables first if the data matters, destroy `<prefix>-console` before `<prefix>-router`,
then run the verification listing. The full steps and what `cdk destroy` leaves behind are in
[infra/README.md](../infra/README.md#cost-and-teardown) and [Console teardown](../infra/README.md#console-teardown).

## 11. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Synth fails with `CannotFindAsset` for the console bundle | `packages/console-web/dist` is missing: build it (section 3). Router-only deploys synth the console stack too. |
| Synth: `console bundle was built from <sha>, not HEAD …` or `built from a dirty tree` | The bundle must come from the deploying tree's clean HEAD: rebuild it there after checking out (section 3). |
| Synth refuses `routerDesiredCount` above 1, or `routerAutoscale` with `max` above 1 | Needs `stateStore=dynamodb`. |
| Synth: `routerDesiredCount: drop it when routerAutoscale is set` | Give only one of the two. |
| zsh passes the whole context as one argument | Use arrays (`"${CTX[@]}"`) as in section 2; an unquoted string is not word-split in zsh. |
| A Lambda or the router crashes at start with a syntax error, though tests pass | Strip-only syntax (parameter properties, enums); run `scripts/node-strip-check.mjs` (section 3). |
| The gateway target is stuck in a failed state | Its model discovery ran before the router was up: deploy again. |
| Clients see 429 under load | Bedrock model quota (`AWS/Bedrock` `InvocationThrottles`, router log `upstreamError: rate_limit_exceeded`), the AgentCore Gateway rate of about 200 requests/s per account (`AWS/Bedrock-AgentCore` `Throttles`, no router log line), or the API stage throttle (`AWS/ApiGateway` `4XXError`). See section 7.2. |
| Members see "Please run /login" or 403 `insufficient_scope` | An expired access token; see [infra/README.md](../infra/README.md#deploy-notes-and-troubleshooting). |
