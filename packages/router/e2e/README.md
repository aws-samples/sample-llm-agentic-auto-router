# E2E runner (design §6)

`run.py` (uv, boto3, requests) checks a deployed router stack, E0–E12. `sdk.ts` makes the client-compatibility calls with the official OpenAI and Anthropic SDKs, using the router's dev dependencies.
- **Stack:** the runner only reads the router stack. The one thing it creates is E0's temporary probe stack `<prefix>-e2e-probe` (tagged `Purpose=mvp-e2e`), which `e0-teardown` deletes.
- **Account:** it refuses to run unless the caller account is `LLMAR_SPIKE_ACCOUNT`.
- **Secrets:** the Cognito client secret and the access tokens are read at runtime and kept in memory only.
- **Results:** written to `results/` (gitignored), with account ids masked. The spend ledger is `results/ledger.json`, capped at USD 4.50 by default (`--cap`).
  - Each call is priced from the usage in its response, and the run stops as soon as the total reaches the cap.
  - **A failed or timed-out call is priced at 0**, even though Bedrock may have billed part of it, so the ledger can undercount.
- **Child processes:** `sdk.ts` gets only `PATH`, with no `AWS_*` and no home-directory config. The gateway URL and the token reach it on stdin.

## What the runner writes in the account

- **Probe stack (E0 only):** a CloudFormation stack `<prefix>-e2e-probe`, tagged `Project=llm-auto-router, Purpose=mvp-e2e`, containing:
  - a Lambda function, its log group (1-day retention) and an IAM role (Lambda VPC access + `execute-api:Invoke` on the router API);
  - a security group;
  - **an ingress rule on the router stack's execute-api endpoint SG** (`ApiVpceSgId`), owned by the probe stack, so the probe can reach the endpoint.
  `e0-teardown` deletes all of it and exits non-zero if it can't. `pre-destroy` and `verify-teardown` refuse while the stack exists.
- **Bedrock invocations:** about 260 short calls in total, mostly E11's 200, all under the cap.
- **Stored Responses objects:** E2 creates two responses with `store: true` and deletes them immediately with the documented `DELETE /openai/v1/responses/{id}` on bedrock-runtime, using SigV4 with your credentials (`bedrock:DeleteInvoke`). Their ids and delete statuses are in `results/e2.json`. Any that weren't deleted expire after 30 days (Bedrock Responses retention).
- **CloudWatch Logs reads** (E3, E5b, E6, E8, E9, E11, E12): `filter_log_events` on the router log group. E12 sends no filter pattern and scans locally, so no secret is ever part of an AWS request.
- **Dynamic catalog checks** (cat-*): console-API calls as a test admin you create and delete, Lambda invokes of the catalog functions, and reads of the config bucket, usage table and IAM; see [Dynamic catalog checks](#dynamic-catalog-checks-cat-).
- **Other reads** (E7b): ECS `describe_services`, ELB `describe_load_balancers` / `describe_target_groups` / `describe_target_health`, CloudWatch `list_metrics` / `get_metric_data` on `AWS/Bedrock-AgentCore`. E7b never scales anything itself; you redeploy.

## Deploy order and commands

Run from the repository root with credentials for the target account.

```
source scripts/local.env                                    # LLMAR_SPIKE_ACCOUNT
R=<aws-region>; A=<account-id>; P=<unique-prefix>; OWNER=<owner>
PL=$(aws ec2 describe-managed-prefix-lists --region $R \
      --filters Name=prefix-list-name,Values=com.amazonaws.$R.s3 --query 'PrefixLists[0].PrefixListId' --output text)
CTX="-c region=$R -c account=$A -c prefix=$P -c tags={\"Owner\":\"$OWNER\"}"
```

1. **Bootstrap**, one-time per account and Region: `(cd infra && npx cdk bootstrap aws://$A/$R $CTX)` (the CLI synthesizes the app first, so it needs the same context). The router image is built by `cdk deploy` as an ARM64 Docker asset, so no separate image build or push is needed; Docker must be running.
2. **Deploy at 0 tasks.**
   ```
   (cd infra && npx cdk deploy $CTX -c routerDesiredCount=0 --parameters S3PrefixListId=$PL)
   ```
3. **Gate at 0.** `uv run packages/router/e2e/run.py --region $R --prefix $P e0`. It stops the run on any failure.
4. **Scale to 1.** Redeploy with `-c routerDesiredCount=1`, keeping the same `$CTX` and parameter.
5. **Gate at 1, then the checks.**
   - Run `run.py … e0` again.
   - Run `run.py … all`, which covers e0–e5, e5b, e8, e9, e11 and e12.
   - Then `run.py … e0-teardown`.
6. **State-specific checks.** Each one needs the stack redeployed with the context shown. Use the same `$CTX` and parameter every time, and drop the e2e keys before going back to normal.

   | Check | Deploy context | Notes |
   |---|---|---|
   | E6 | `-c routerDesiredCount=1 -c e2eFault=upstream-503-once:2` | The 503 replaces the task's 2nd upstream attempt, once. Use a fresh task and run e6 first on it: turn 1 is router-served, turn 2 faulted (served by the gateway fallback), turn 3 must be `retain;failover` (`failover: exhausted`). |
   | E10 | `-c routerDesiredCount=1 -c e2eFault=pause-after-first-frame:330000 -c e2eIdleTimeoutMs=420000` | Takes about 6 minutes. |
   | E7 | `-c routerDesiredCount=0` | The gateway documents no fallback or circuit-breaker metric; E7b records the gateway metrics it does publish. |
   | E7b | start at `-c routerDesiredCount=0` | Informational. Run `run.py … e7b` (`--n 30 --probe-s 10 --recover-min 30`). When it prints "phase A done", redeploy with `-c routerDesiredCount=1` from another terminal. It records when the router has a healthy NLB target and when `auto` is served by the router again, then the gateway's CloudWatch metrics for the window. About 6–8 minutes plus the deploy. |

7. **Teardown.**
   - `run.py … e0-teardown`, if it hasn't run yet, then `run.py … pre-destroy` (refuses while the probe stack exists).
   - `(cd infra && npx cdk destroy $CTX)`.
   - `run.py … verify-teardown`. Everything must be empty, except the default-SG custom resource's `/aws/lambda/…CustomVpcRestrictDefaultSG…` log group, which you delete by hand.

## Checks

| Check | Deployment state | Budget (USD) |
|---|---|---|
| e0 | 0 tasks, then 1 | 0 |
| e1 | 1 task | 0.05 |
| e2 | 1 task | 0.05 |
| e3 | 1 task (Anthropic-SDK agent loop shaped like Claude Code: synthetic tool_use/tool_result transcript, 12 calls, tool_choice auto, no local tools) | 0.30 |
| e4 | 1 task | 0.60 |
| e5 | 1 task | 0.02 |
| e5b | 1 task (`auto:fast` on all three paths, `auto:bogus`, `autox`) | 0.02 |
| e6 | `e2eFault=upstream-503-once:2` | 0.05 |
| e7 | 0 tasks | 0.10 |
| e7b | 0 tasks, then scaled to 1 while it runs (informational: circuit-breaker recovery timing) | 0.10 |
| e8 | 1 task | 0.05 |
| e9, e12 | after the others; scans the last `--window-min` minutes of router logs | 0 |
| e10 | `pause-after-first-frame` revision | 0.05 |
| e11 | 1 task | 0.20 |

Each check writes `results/<check>.json` with PASS or FAIL per assertion and its evidence.

**The gateway has no fallback: it fails closed.** Router 5xx answers, connection failures and timeouts go back to the client; nothing calls Bedrock around the router, so every served turn is in the router's cost accounting, logs/EMF and session state. Earlier revisions had a `bedrock` fallback target, removed in `cc9db98` (fix(gateway): fail closed when the router is unavailable). **The E6 and E7 checks (`e6`, `e7`, `e7b`) predate that change** and still assert fallback behaviour (for example `turn2_client_200_via_gateway_fallback`), so they fail on a current deployment until they are updated.

## Dynamic catalog checks (cat-*)

These check the dynamic catalog's acceptance criteria on a deployment with the router and console stacks (C2/C3:
`catalog-refresh`, `catalog-grant`, console-api `admin.models.*` / `admin.catalog.*`). They run after `e0`/`all`, on
a router with 1 task. `catalog/models.json` and `catalog/current.json` are writable only by the refresh and grant
functions and console-api (bucket policy), so the checks that change something do it **through the console API, as a
test admin**, plus direct Lambda invokes. Before a change they save the touched model's entry to
`results/cat-restore.json`; `cat-restore` puts it back if a run stops half way.

**Test admin** (you create and delete it; nothing here writes Cognito or DynamoDB). As in `experiments/console-e2e`:

```
POOL=$(aws cloudformation describe-stacks --stack-name $P-router --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
TABLE=$(aws cloudformation describe-stacks --stack-name $P-console --query "Stacks[0].Outputs[?OutputKey=='ConsoleTableName'].OutputValue" --output text)
U=e2e-catalog-admin-$(openssl rand -hex 3)@example.com
aws cognito-idp admin-create-user --user-pool-id $POOL --username $U --message-action SUPPRESS \
  --user-attributes Name=email,Value=$U Name=email_verified,Value=true \
  --temporary-password "$(python3 -c 'import secrets; print(secrets.token_urlsafe(18) + "aA1!")')"
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username $U --group-name admin
read -rs PW; aws cognito-idp admin-set-user-password --user-pool-id $POOL --username $U --password "$PW" --permanent; unset PW
SUB=$(aws cognito-idp admin-get-user --user-pool-id $POOL --username $U --query "UserAttributes[?Name=='sub'].Value" --output text)
NOW=$(date -u +%FT%TZ)
aws dynamodb put-item --table-name $TABLE --condition-expression 'attribute_not_exists(pk)' --item \
  "{\"pk\":{\"S\":\"MEMBER#user:$SUB\"},\"sk\":{\"S\":\"PROFILE\"},\"status\":{\"S\":\"active\"},\"role\":{\"S\":\"admin\"},\"budgetMonthlyUsd\":{\"NULL\":true},\"createdAt\":{\"S\":\"$NOW\"},\"updatedAt\":{\"S\":\"$NOW\"}}"
```

**Token.** Sign in to the console as `$U` in a private browser window. The access token is in the tab's
sessionStorage, under the `oidc.user:…` key (`access_token`, valid 60 minutes). Then either export it without echoing
it (`read -rs LLMAR_CONSOLE_ADMIN_TOKEN; export LLMAR_CONSOLE_ADMIN_TOKEN`), or let the run prompt for it (hidden
input). It is kept in memory only, and never printed or written.

**Delete the test admin afterwards** (also after an aborted run, once `cat-restore` has run):

```
aws cognito-idp admin-user-global-sign-out --user-pool-id $POOL --username $U
aws cognito-idp admin-delete-user --user-pool-id $POOL --username $U
aws dynamodb delete-item --table-name $TABLE --key "{\"pk\":{\"S\":\"MEMBER#user:$SUB\"},\"sk\":{\"S\":\"PROFILE\"}}"
unset LLMAR_CONSOLE_ADMIN_TOKEN
```

**Order:** `cat-deploy` → `cat-assumptions` → `cat-candidates` → `cat-refresh` → `cat-ingest` → `cat-grant` → (destroy) →
`verify-teardown` (now also lists the catalog leftovers) or `cat-teardown-verify`.

| Check | What it does | AWS actions (besides `sts:GetCallerIdentity`, `cloudformation:DescribeStacks`) | Spend | If interrupted |
|---|---|---|---|---|
| cat-deploy (AC1, AC8) | `current.json` exists; version after the bundled label; content = bundled catalog (`contentHash`, diff in the result); router state line `catalogSource=bucket` with that version; one pinned GPT-6 Luna call, whose usage record carries the version and is priced | `s3:GetObject` (catalog/*), `logs:FilterLogEvents` (router log group), `cognito-idp:DescribeUserPoolClient` (gateway token), `dynamodb:Query` (usage table, gsi1) | < $0.0001 | nothing to restore |
| cat-assumptions (C2b-R5) | from the newest snapshot: (a) GPT SKU candidates (report), (b) Claude `modelName` = sku name, (c) in-Region `_standard` rows, (d) the id snapshot covers other providers | `s3:ListBucket`, `s3:GetObject` | 0 | nothing |
| cat-candidates | read-only list of cat-grant candidates for this Region | `ssm:GetParameter` (/`$P`/router/*), `s3:GetObject` | 0 | nothing |
| cat-refresh (AC2, AC3) | two manual refreshes (the second publishes nothing); a ×1.5 admin edit of the model-card price of a confirmed model the configuration does not use → one new version, change log old → new, alert; router on it within 60 s; console rollback → router back within 60 s; scheduled refresh held (`update-held`); resume publishes; edit reverted and republished (content equal to the start) | `lambda:InvokeFunction` (`$P-catalog-refresh`), `ssm:GetParameter`, `s3:GetObject`, `s3:ListBucket`, `logs:FilterLogEvents`, `cognito-idp:DescribeUserPoolClient`; console API (test admin) | 2 Luna calls, < $0.0002 | `run.py … cat-restore` (reverts the price via the console API, resumes after the rollback, syncs grants) |
| cat-ingest (AC7, after cat-refresh) | the usage records of cat-refresh's two calls: the previous and the new catalog version, both priced, neither `catalog-mismatch` | `dynamodb:Query` | 0 | nothing |
| cat-grant (AC6) | confirm a candidate (console API) → refresh publishes it, grant sync → `universe.json`; pinned call → 200 from it; `iam:SimulatePrincipalPolicy` on the task role with an extra allow-all policy: `s3:PutObject`, `iam:CreateUser` denied (boundary); un-confirm → leaves the universe, revoked after the 35 s delay; pinned → 400 `pin-not-allowed` | `lambda:InvokeFunction` (refresh, grant), `ssm:GetParameter`, `s3:GetObject`, `iam:ListAttachedRolePolicies`, `iam:GetPolicy`, `iam:GetPolicyVersion` (`$P-router-task`, `$P-dyn-models-*`), `iam:SimulatePrincipalPolicy` (`$P-router-task`), `cognito-idp:DescribeUserPoolClient`; console API | ≤ 2 short calls on the candidate (input + output ≤ $30/M enforced), < $0.002 | `run.py … cat-restore` (un-confirms via the console API, republishes, syncs) |
| cat-teardown-verify (AC8, after destroy) | no `$P-dyn-models-*` / `$P-router-boundary` policy, no `/aws/lambda/$P-catalog-*` log group | `iam:ListPolicies`, `logs:DescribeLogGroups` | 0 | nothing |

What remains after a full cat-refresh + cat-grant run (by design, not restored byte for byte):
- **New catalog versions.** cat-refresh publishes about 3; cat-grant publishes 2 when its candidate was pending. The
  final version's content equals the starting one.
- **cat-refresh target model:** its `modelCardPrice` field source becomes `admin`; the value is the original.
- **cat-grant candidate:** it is back to `pending`, with `stateReason: unconfirmed` and `grant: none`.

**Choosing the cat-grant model.** On a deployment with `allowedModelUniverse=catalog` (both live ones) every shipped
model offered in the Region is already in the base grant, so a candidate is a model the refresh discovered: `pending`,
templated from a confirmed predecessor of the same line, with a price, and Chat or Messages. Run `cat-candidates` and
pick one with `cat-grant --model <id>` (default: the first). Avoid models whose line lacks Messages support on
bedrock-runtime (the curated exclusions list several Claude 4.x ids).

**Dry run against fakes** (no AWS, no network; the real `catalog.ts` helper):
`uv run --with pytest --with boto3==1.43.126 --with requests==2.34.2 pytest -q packages/router/e2e/test_catalog_dryrun.py`.

## Trying it with Claude Code (manual, in your own sandbox)

The runner never starts Claude Code. An autonomous agent with shell access would inherit the operator's AWS identity, `~/.aws`, `~/.claude` settings, hooks and MCP servers. To see Claude Code against your deployment, do it yourself in an isolated environment, ideally a throwaway container with no cloud credentials:

```
# inside a container or VM with no AWS credentials and no ~/.aws, ~/.claude
umask 077; HELPER=$(mktemp); TOK=$(mktemp)
<obtain a client-credentials access token for <prefix>/invoke> > "$TOK"          # 0600 by umask
printf '#!/bin/sh\ncat %s\n' "$TOK" > "$HELPER"; chmod 700 "$HELPER"
env -i PATH="$PATH" HOME="$(mktemp -d)" \
  ANTHROPIC_BASE_URL="https://<gateway-host>/inference" ANTHROPIC_MODEL=auto ANTHROPIC_SMALL_FAST_MODEL=auto:fast \
  claude --bare --restricted --strict-mcp-config --setting-sources '' \
    --settings "{\"apiKeyHelper\": \"$HELPER\"}" \
    --allowedTools 'Read,Grep,Glob' --max-budget-usd 1 \
    -p "Summarise this repository's README."
rm -f "$HELPER" "$TOK"
```

- Check the flags against `claude --help` for your version; this assumes the isolation flags listed above exist there.
- Keep `--allowedTools` narrow; no `Bash` unless the sandbox is disposable.
- The token comes from an `apiKeyHelper` file that only you can read, and is deleted afterwards; it never goes into the environment or the command line.
- The router logs show the betas Claude Code sent (`headers.anthropic-beta`) and the decision per turn.
