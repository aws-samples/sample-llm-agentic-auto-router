# 部署 Runbook

本文是 router stack（`<prefix>-router`）和管理控制台 stack（`<prefix>-console`）的操作步骤：部署、升级、验证、扩缩容、回滚和销毁。每个部署参数和资源的说明见 [infra/README.md](../infra/README.md)。English: [deploy-runbook.md](deploy-runbook.md)。

> [!IMPORTANT]
> **这是用于演示和学习的示例代码，不能直接用于生产。** 在自己的账号里部署之前，请对照自身要求评估它的安全性、成本以及 Bedrock / API Gateway 配额。部署产生的 AWS 费用由你承担。
>
> 只要 stack 处于部署状态，就有**固定成本，在 ap-southeast-1 约 USD 113/月**。即使 router 缩到 0 个任务也一样，这部分来自接口终端节点和内部 NLB。此外还有按任务、按请求和按 token 计的费用，其他区域价格不同。**测试结束后请销毁 stack**，见 [infra/README.md 的 “Cost and teardown”](../infra/README.md#cost-and-teardown)。

> [!WARNING]
> **每次部署（不管是 router 还是控制台）都要传完整的部署 context，并且先跑 `cdk diff`。** CDK 不会记住上一次部署用的 context。漏掉的参数会回到默认值，其中有些默认值会删掉或停掉东西：
>
> | 漏掉的参数 | 部署会做什么 |
> |---|---|
> | `stateStore=dynamodb` | 删除 router 状态表和它的 DynamoDB endpoint（状态退回到每个 task 的内存里） |
> | `routerAutoscale` / `routerDesiredCount` | 回到 `routerDesiredCount=0`：**router 停止服务** |
> | `allowedModelUniverse` | 缩小 router 可调用的模型范围；控制台策略里指定了被去掉的模型的请求会返回 400 `pin-not-allowed` |
> | `assessorMode`、`identityMode`、`throttle`、`consoleThrottle` | 恢复成默认值 |
> | `tags` | 从所有资源上去掉你的标签 |
> | `consoleBundle=true`、`ingest=true` | 从站点 bucket 删掉 web 应用，或停止 usage 写入 |

## 1. 开始之前

**工具**（部署所在的机器上）：

- Node.js 24、pnpm（版本以 `package.json` 为准）、AWS CLI v2、[uv](https://docs.astral.sh/uv/)（运行 E2E 检查）。
- 能构建 `linux/arm64` 镜像的 Docker：ARM64 机器，或带 QEMU 的 Docker Buildx。`cdk deploy` 会自己构建 router 和 Lambda 镜像。

**账号和 Region：**

- 能扮演目标账号 CDK bootstrap 角色的凭证。CDK 通过这些角色部署，所以部署者自己不需要很大的权限。
- 目标 Region 的 Amazon Bedrock 中，策略里用到的模型已开通访问。
- 目标 Region 的 AgentCore Gateway tool-call payload 大小配额已从默认的 6 MB 提高到 10 MB（`L-603BFD8F`，见 [7.3](#73-部署前申请提高的配额)）。每个部署都要做：保持默认值时，超过 6 MB 的请求体会在 gateway 被拒绝。
- 有负载时会用到的配额。默认最紧的是 AgentCore Gateway 的请求速率，**每个账号每秒 200 个请求**，所有调用方共用；其次是路由目标模型各自的 Bedrock 每分钟 token 配额（通常最先碰到的是 fast 档位的模型）。部署前申请提高配额，见[部署前申请提高的配额](#73-部署前申请提高的配额)。
- 如果账号里还有其他工作负载，先定好怎样区分本部署的资源：唯一的 `prefix` 和你自己的 `tags`。diff 里出现的每一处变化都必须在 `<prefix>-*` 资源上。

## 2. 一次性确定部署参数

把参数写进一个 context 文件，每次部署都 source 它。文件放在仓库外面，因为里面有账号 id 和第一个管理员的邮箱。bash 示例：

```bash
# ~/llmar-<prefix>.ctx.sh（chmod 600；在 bash 里 source，zsh 里按下面的数组写法也能用）
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

需要做的选择：

| 决定 | 选项 | 建议 |
|---|---|---|
| task 数 | 固定 `routerDesiredCount=<n>`，或 `routerAutoscale=<min>,<max>`（二选一，不能都给） | 多人共用的测试或压测用自动扩缩容，`min` ≥ 2；试用可以固定为 `1` |
| 路由状态 | `stateStore=memory`（最多 1 个 task）或 `dynamodb`（task 数不限） | 只要可能多于 1 个 task 就用 `dynamodb`。以后切换要重新部署；状态是短期的，会自动重建 |
| 模型范围 | `policy`、`catalog` 或列表 | 如果管理员要能选 Region 里的任意模型，用 `catalog`。缩小之前，先把要去掉的模型从控制台策略里删掉 |
| Assessor | 关、`observe`、`auto` | `observe`；管理员审核后在控制台打开规则 |
| 身份 | `off`、`observe`、`require` | 先用 `observe`，Overview 上未归属的比例接近 0 后，在控制台切到 `require`。**切换之前，对没有带有效 `x-api-key` 的调用方，成员封禁、预算和档位上限都不生效** |
| 限流 | `throttle`、`consoleThrottle`（`<rate>,<burst>`） | 默认值（1000,2000）留有余量；如果账号的 API Gateway 配额要和繁忙的工作负载共用，可以调低 |

第一次部署控制台时需要 `adminEmail`（它会创建第一个管理员）。以后的部署继续传同一个值，diff 才会干净。如果手头没有这个值，可以从线上模板读回来（`<prefix>-console` 的 `Resources.SeedAdmin.Properties.email`），不要放进仓库。

## 3. 准备干净的构建目录

CDK 从工作目录构建 router 镜像和 Lambda 代码，所以只能从要部署的那个 commit 的干净 checkout 部署。有本地修改或未跟踪文件的目录不能用来部署。

```bash
SHA=$(git rev-parse --short <commit>)              # 例如 merge request 合并后的 origin/main
git worktree add /tmp/<prefix>-deploy-$SHA $SHA
cd /tmp/<prefix>-deploy-$SHA
umask 022                                          # 镜像和资源要让运行时用户可读
pnpm install --frozen-lockfile --prefer-offline
pnpm -C packages/console-web build                 # consoleBundle=true 时都需要，只部署 router 也一样
pnpm -C infra typecheck && pnpm -C infra test      # 断言和 cdk-nag
```

如果改动涉及 router 或 Lambda 代码，还要跑 strip-only 检查。Node 通过类型擦除直接运行 TypeScript 源码，而测试覆盖不到这一点。例如：
`(cd packages/usage-ingest && node ../../scripts/node-strip-check.mjs --import src/handler.ts src)`。

部署完删掉 worktree（`git worktree remove /tmp/<prefix>-deploy-$SHA`）。

## 4. 在一个账号和 Region 里首次部署

在任何受限内容存在之前先验证匿名访问会被拒绝；之后每打开一条路径，都再验证一次。

1. **Bootstrap**（每个账号和 Region 一次）：`(cd infra && npx cdk bootstrap aws://$A/$R "${CTX[@]}")`。
2. **router 先以 0 个 task 部署。** 这一步用固定 task 数：把 `CTX` 里的 `routerAutoscale…` 换成 `-c routerDesiredCount=0`，然后运行 `(cd infra && npx cdk deploy $P-router --exclusively "${CTX[@]}" "${PARAMS[@]}")`。
3. **E0 关卡**：匿名请求、错误 token、直连 API、直连 NLB 和 task，全部要被拒绝。先把 `LLMAR_SPIKE_ACCOUNT` 设成目标账号（runner 拒绝其他账号），然后运行 `uv run packages/router/e2e/run.py --region $R --prefix $P e0`。
4. **router 开始服务。** 用真正的 task 设置（`routerAutoscale=…` 或 `routerDesiredCount=1`）再部署一次，再跑一次 `e0`，然后依次运行 `run.py … all` 和 `run.py … e0-teardown`（删除 E0 的探测 stack）。
5. **控制台先关闭部署。** 部署 `$P-console`，`consoleBundle` 和 `ingest` 都关闭，带上 `adminEmail`。检查不带 token 时所有 `/api/*` 路由都返回 401，直接访问站点 bucket 返回 403。
6. **上传控制台 web 应用。** 加上 `consoleBundle=true` 再部署一次。用第一个管理员登录（Cognito 会把临时密码发到邮箱），检查各页面。
7. **打开 usage 写入。** 加上 `ingest=true` 再部署一次。几分钟内 Overview 上就会出现用量。
8. **身份。** 成员按 README 的“客户端接入”配置好工具。Overview 上未归属的比例接近 0 后，在控制台（设置 → 部署）把身份模式切到 `require`。切换之前，没有带有效 `x-api-key` 的调用方会被服务但不归属到成员，成员封禁、预算停用和档位上限对它都不生效。

从这以后，每次部署都用第 2 节的完整 `CTX`。

## 5. 日常升级

1. 合并改动，然后在合并后的 commit 上准备干净目录（第 3 节）。
2. **对两个 stack 跑 diff：**
   ```bash
   cd infra && npx cdk diff $P-router $P-console "${CTX[@]}" "${PARAMS[@]}" 2>&1 | tee /tmp/$P-diff.log
   ```
   继续之前先读一遍：
   - 每个有变化的资源都属于 `$P-router` 或 `$P-console`；
   - 没有意料之外的删除或替换（各张表、状态表、user pool、各个 bucket）；
   - router 镜像有变化时会替换 task（见第 4 步）；如果 diff 只涉及控制台的前端包，只需要部署控制台。
3. **先部署 router，再部署控制台**（控制台部署时从 SSM 读取 router 的值）：
   ```bash
   npx cdk deploy $P-router  --exclusively "${CTX[@]}" "${PARAMS[@]}"
   npx cdk deploy $P-console --exclusively "${CTX[@]}" "${PARAMS[@]}"
   ```
   diff 为空的 stack 可以跳过。
4. **router 部署期间客户端会看到什么。** 新 task 先启动并通过健康检查，旧 task 才停止。旧 task 不再接新连接，已经在它上面运行的流还有约 135 秒可以结束；更长的流会被切断，由客户端重试。每停一个 task，部署时间最多增加 150 秒。如果成员在跑很长的 agent 会话，选流量少的时候部署。
5. **验证**（第 6 节）。任何一项失败就回滚（第 9 节）。

路由策略、assessor 规则、别名、成员和预算的改动都是控制台里的配置版本，约 30 秒内生效，不需要部署。

## 6. 每次部署后的验证

| 检查 | 方法 | 预期 |
|---|---|---|
| Stack | `aws cloudformation describe-stacks --stack-name $P-router`（以及 `$P-console`） | `UPDATE_COMPLETE` |
| router 服务 | `aws ecs describe-services --cluster $P-cluster --services $P-router` | `runningCount` 等于 `desiredCount`；只有一个 deployment，状态 `COMPLETED`；task definition 是预期的版本 |
| 扩缩容（仅自动扩缩容） | `aws application-autoscaling describe-scalable-targets --service-namespace ecs` | `service/$P-cluster/$P-router` 的 min 和 max 符合设置，没有被暂停 |
| NLB target | `aws elbv2 describe-target-health --target-group-arn <router TG>` | 全部 `healthy` |
| 端到端 | 先 `uv run packages/router/e2e/run.py --region $R --prefix $P e1`，再 `e3` | 都通过（只有少量短的 Bedrock 调用） |
| gateway 关闭 | 不带 token 访问 gateway URL | 401 |
| 控制台关闭 | `curl -s -o /dev/null -w '%{http_code}' <ConsoleUrl>/api/me` | 401 |
| 控制台版本 | `<ConsoleUrl>/build.json` | 部署的 commit（仅控制台部署） |
| usage 写入 | 部署之后 Lambda `$P-usage-ingest` 的 `Errors` 指标；`$P-usage-ingest-dlq` 的消息数 | 都是 0 |
| router 日志 | `/<prefix>/router` 中部署之后 `kind = "error"` 的行 | 没有新增 |

修复后如果 DLQ 里还有消息，按 [packages/usage-ingest/README.md](../packages/usage-ingest/README.md#failures-and-replay) 重放。

## 7. 容量、配额与限制

### 7.1 router 容量与自动扩缩容

数据来自短流式请求的测量（[压测报告](experiments/router-loadtest.zh-CN.md)）：单个 1 vCPU / 2 GiB task 每 RPS 约占 0.46% CPU，约 210 RPS 时饱和；内存一直低于 25%。规划时按每个 task 约 150 RPS（CPU 约 70%）计算。两个 task 经 NLB 均匀分摊负载，通过 DynamoDB 共享状态。agent 的长流式请求每个请求消耗的 CPU 比这次测试多，确定 `max` 之前请用自己的流量实测。

- **自动扩缩容**（`routerAutoscale=<min>,<max>`、`routerScaleCpu`，默认 60）：按服务平均 CPU 做目标跟踪。CPU 连续 3 分钟高于目标后加 task（之后冷却 60 秒）；连续 15 分钟低于目标的 90% 后减 task（冷却 300 秒）。新 task 要 1–2 分钟才能开始服务，所以 `min` 要留够应对突发的量。部署时保留当前的 task 数。
- **修改 min、max 或目标值**：用新值重新部署。不要对开启了自动扩缩容的服务执行 `aws ecs update-service --desired-count`，扩缩容策略会把它改回去。手工改过的 scalable target 会在下次部署时被重置。
- **加 task 提高不了整条链路的上限。** 在 AgentCore Gateway 的默认配额下（每秒 200 个请求，见 7.2），两个 task 的 CPU 已经超过 gateway 能放行的量，再加 task 只能增加冗余，不能提高吞吐。

### 7.2 请求链路上的配额与限制

下表是默认值或本项目实测的值。配额会变化，请在 Service Quotas 和服务文档里核对你账号的实际值。

| 层 | 限制 | 值 | 达到时的表现 |
|---|---|---|---|
| AgentCore Gateway | 每个 gateway、每个账号的请求速率（推理请求按 tool call 计） | **各 200 个请求/秒**（[AgentCore 配额](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)）。Service Quotas 里可能显示 2,000（L-8CAB3FF3、L-A0D48779），但 2026-11-24 实测的有效速率仍约为 200/秒 | 约 20 ms 返回 429，请求到不了 router（router 日志里没有记录）；指标 `AWS/Bedrock-AgentCore` 的 `Throttles`。账号级速率由账号和 Region 内所有 gateway、所有调用方共用：一个重度客户端会让所有人被限流 |
| AgentCore Gateway | 每个 gateway、每个账号的并发连接数 | 各 10,000 | 长流式请求在整个持续时间内都占一个连接 |
| AgentCore Gateway | 单次调用超时 | 15 分钟 | 与 API Gateway 的流时长上限一致 |
| AgentCore Gateway | Tool-call/tool-list/tool-search payload 大小（Service Quotas `L-603BFD8F`，可调整） | **默认 6 MB**；部署前提高到 10 MB（见 7.3）。本项目的 E8 检查在提高配额之后，9.5 MiB 的请求能通过 gateway | 超过配额的请求被 gateway 拒绝，到不了 router。提高到 10 MB 后，实际的请求上限是 API Gateway 的 10 MiB（见下面几行） |
| AgentCore Gateway | 自定义速率限制（按调用方、target 或模型） | 本 stack 没有配置 | 可选：给单个调用方（JWT `sub`）设上限，避免它用光整个账号的速率。有效速率取服务上限和自定义值中较小的一个 |
| API Gateway（私有 REST API） | stage 限流 | `throttle`，默认 1000 请求/秒，突发 2000 | API Gateway 返回 429；`AWS/ApiGateway` 的 `4XXError` |
| API Gateway | 每个 Region 的账号级速率 | 10,000 请求/秒，突发 5,000（默认） | 账号和 Region 内所有 API 共用 |
| API Gateway | 请求 payload | 10 MiB（硬限制） | 在到达 router 之前返回 413 |
| API Gateway | 流时长和空闲时间 | 每个响应 15 分钟；私有 endpoint 空闲 5 分钟 | 流被结束，router 记为 `stream-duration-cap`（499）。router 自己的空闲超时（240 秒）会先触发 |
| Router | 请求体、流时长上限、空闲超时 | 10 MiB（`ROUTER_MAX_BODY_BYTES`）、900 秒（`ROUTER_STREAM_CAP_MS`）、240 秒 | 413、499 `stream-duration-cap` |
| Router | 每个 1 vCPU task 的吞吐 | 约 210 请求/秒（短流式请求） | 接近饱和时开销和延迟上升；加 task（见 7.1） |
| Amazon Bedrock | 每个模型的每分钟 token 数（有的还有每分钟请求数），按 Region 和推理配置类型区分（global 和地理推理配置的配额分开） | 见 Service Quotas 中各模型的值（例如 `gpt-6-luna` 为每分钟 4M token） | 经 router 返回 429 `rate_limit_exceeded`（router 日志的 `upstreamError`）；`AWS/Bedrock` 的 `InvocationThrottles`。配额把输出 token 计成好几倍：`gpt-6-luna` 的 `EstimatedTPMQuotaUsage` 约为“输入 + 10 × 输出” |
| 控制台 HTTP API | stage 限流、payload | `consoleThrottle`，默认 1000/2000；10 MB | 控制台 API 返回 429 或 413 |
| Amazon Cognito | token 请求的速率配额 | 按 user pool，见 Service Quotas | 服务客户端应缓存 60 分钟有效的 access token，不要每次调用都重新获取 |
| DynamoDB（按需） | 单分区吞吐 | 按需自动调整 | usage 表在约 250 请求/秒时出现过写入限流事件，usage-ingest 重试后都写进去了（Errors 0，DLQ 为空）。长期在这个量级运行时要关注 |

### 7.3 部署前申请提高的配额

先估算峰值请求速率和同时打开的流数。然后在部署或压测之前：

1. **AgentCore Gateway payload 大小（每次都要做）**：在部署所在的 Region，把 *Tool-call/tool-list/tool-search payload size*（`L-603BFD8F`）从默认的 6 MB 提高到 10 MB。方法：Service Quotas 控制台 → AWS 服务 → Amazon Bedrock AgentCore → 该配额 → *在账号级别请求提高*，或者运行 `aws service-quotas request-service-quota-increase --service-code bedrock-agentcore --quota-code L-603BFD8F --desired-value 10 --region $R`。申请关闭后，用 `aws service-quotas get-service-quota`（同样的参数）确认生效的值。
2. **AgentCore Gateway 请求速率**：如果峰值可能超过约 150 请求/秒（在 200 以下留出余量），同时申请提高每个 gateway 和每个账号的速率。如果 Service Quotas 里显示的值已经高于你实测到的速率，就提交 AWS Support case（AgentCore Gateway），附上实测的 `Throttles` 数据。
3. **Bedrock 每分钟 token 数**：针对承载主要流量的各档位模型（先看 fast 档位），按策略使用的 Region 和推理配置类型（global 或地理推理配置）申请。按“峰值每分钟请求数 ×（输入 + burndown × 输出）token”估算，burndown 系数可以用一次测试的 `EstimatedTPMQuotaUsage` 推算。
4. **API Gateway 账号级速率**：只在账号和 Region 内还有其他繁忙 API 时才需要。
5. **router 的 `max`**：设为“峰值速率 ÷ 150”，再加 1 个作为冗余。
6. **客户端**：对 429 做带随机抖动的指数退避重试。没有退避的话，一次短暂限流就会变成重试风暴，把账号里所有人的 gateway 速率都用光。

压测和账号内的其他调用方共用同一组账号级配额：在单独的账号里压测，或者把压测控制在上限以下，并留意 `AWS/Bedrock-AgentCore` 的 `Throttles` 里有没有出现压测没有用到的接口。

## 8. 切换状态存储或 task 设置

- **`memory` → `dynamodb`**：加上 `-c stateStore=dynamodb` 和 `DynamoDbPrefixListId` 参数部署。task 会重启，状态从空开始，会话会冷路由一次（缓存未命中，不会出错）。
- **固定 task 数 → 自动扩缩容**：把 `routerDesiredCount` 换成 `routerAutoscale`。diff 会显示新增 scalable target 和扩缩容策略、删除 `DesiredCount`；运行中的 task 不会重启，scalable target 注册后立即把 task 数提到 `min`。
- **自动扩缩容 → 固定 task 数**：在同一次部署里把 `routerAutoscale` 换成 `routerDesiredCount=<n>`。两个都不传会让 router 停止服务。

## 9. 回滚

| 出了什么问题 | 回滚方法 |
|---|---|
| 部署中途失败 | CloudFormation 会自动回滚 stack，ECS 的部署熔断会回滚起不来的 task。查看 stack 事件，修好后再部署 |
| 部署成功但新版本有问题 | 在上一个正常的 commit 上准备干净目录（第 3 节），用同样的 `CTX` 部署。先 diff：回滚不能删掉之后的部署有意加上的资源（例如状态表） |
| 某个配置版本有问题 | 在控制台打开“路由策略 → 版本”，启用上一个版本，不需要部署 |
| usage 记录写入失败 | 修好后重放 DLQ（见第 6 节） |

## 10. 销毁

如果控制台表和 usage 表的数据有用，先导出。先销毁 `<prefix>-console`，再销毁 `<prefix>-router`，然后按清单检查剩余资源。完整步骤，以及 `cdk destroy` 之后会留下哪些资源，见 [infra/README.md](../infra/README.md#cost-and-teardown) 和 [Console teardown](../infra/README.md#console-teardown)。

## 11. 常见问题

| 现象 | 原因和处理 |
|---|---|
| synth 报控制台前端包 `CannotFindAsset` | 缺少 `packages/console-web/dist`：先构建（第 3 节）。只部署 router 时也会 synth 控制台 stack |
| synth 报 `console bundle was built from <sha>, not HEAD …` 或 `built from a dirty tree` | 前端包必须用部署目录干净的 HEAD 构建：checkout 之后在那个目录里重新构建（第 3 节） |
| synth 拒绝 `routerDesiredCount` 大于 1，或 `routerAutoscale` 的 `max` 大于 1 | 需要 `stateStore=dynamodb` |
| synth 报 `routerDesiredCount: drop it when routerAutoscale is set` | 两个参数只能给一个 |
| zsh 把整个 context 当成一个参数 | 按第 2 节用数组（`"${CTX[@]}"`）；zsh 不会拆分未加引号的字符串 |
| 测试都通过，Lambda 或 router 启动时却报语法错误 | 用了类型擦除不支持的语法（parameter properties、enum）；运行 `scripts/node-strip-check.mjs`（第 3 节） |
| gateway target 一直处于失败状态 | 它的模型发现在 router 起来之前就运行了：再部署一次 |
| 有负载时客户端收到 429 | 可能是 Bedrock 模型配额（`AWS/Bedrock` 的 `InvocationThrottles`，router 日志里有 `upstreamError: rate_limit_exceeded`），可能是 AgentCore Gateway 每个账号约 200 请求/秒的速率上限（`AWS/Bedrock-AgentCore` 的 `Throttles`，router 日志里没有对应的行），也可能是 API stage 限流（`AWS/ApiGateway` 的 `4XXError`）。见 7.2 |
| 成员看到 “Please run /login” 或 403 `insufficient_scope` | access token 过期了；见 [infra/README.md](../infra/README.md#deploy-notes-and-troubleshooting) |
