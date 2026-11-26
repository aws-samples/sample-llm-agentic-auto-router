# Router 压力测试报告：OpenAI Chat Completions，fast 档位（2026-11-23、11-24）

## 结论

1. **整条链路的上限在 AgentCore Gateway，约 200 RPS。** gateway 对推理请求按 tool call 计速率，默认每个 gateway、每个账号都是 200 TPS（[AgentCore 配额文档](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)）。Service Quotas 里这两项显示 2,000，但实测有效速率约 200/秒：50 并发时稳定在 195 RPS、没有 429；100 并发时放行均值 171 RPS，其余被 gateway 以 429 拒绝。这个速率是账号级的，压测期间有 7 个其他调用方的 `v1/messages` 请求也被限流了。
2. **单个 router task（1 vCPU / 2 GiB）约在 200–215 RPS 时 CPU 饱和。** CPU 与吞吐基本成线性关系，每 RPS 约 0.46–0.52%，两个 task 时每个 task 的比例相同。建议单 task 按 **约 150 RPS（CPU 约 70%）** 规划。在默认的 gateway 配额下，2 个 task 的 CPU 余量（约 420 RPS）已经超过 gateway 能放行的量，加 task 提供的是冗余，不是吞吐。
3. **两个 task 共享 DynamoDB 状态，运行正常。** NLB 把请求基本均分到两个 task（各约一半），状态表平均延迟约 3 ms、p99.9 约 20 ms，没有限流。
4. **自动扩缩容按设计工作。** 临时把 CPU 目标设为 30%、以 40 并发（149 RPS）压测：开始约 5.4 分钟后从 2 个 task 扩到 3 个，新 task 46 秒后开始服务并分担流量，之后 CPU 稳定在目标附近，没有来回扩缩。压测结束约 18.5 分钟后（15 分钟低于阈值，加上指标延迟）缩回 2 个 task。验证完已改回 60%。
5. **内存不是瓶颈。** 峰值约占 2 GiB 的 24%，压测结束后回落。
6. **router 自身开销：** p50 一直是 6–13 ms。p99 在负载较高时升到 100–230 ms。第一轮把这归因于 CPU 排队；第二轮在每个 task CPU 只有约 46% 时，p99 仍在一档之内从 56 ms 涨到 117 ms，同时 DynamoDB 的 p99.9 只有约 20 ms，所以长尾来自进程内部（可能是 GC 或分钟内的瞬时 CPU 峰值），原因还没有确认。
7. **Bedrock 配额也会先于 router 到达。** `gpt-6-luna` 的 4M TPM 按“输入 + 约 10 × 输出”计。第一轮每个请求约计 530，持续只能约 125 RPS；第二轮把输出上限降到 8 token，每个请求约计 99。
8. **约万分之一的请求会卡住。** 每一档都有极少数请求（0.01–0.02%）在 120 秒内没收到响应头，客户端读超时；router 日志里这些请求都是 200，所以卡在 router 之后、客户端之前的链路上，原因还没查清。

## 第一轮（2026-11-23）：单个 task

### 设置

| 项目 | 值 |
|---|---|
| 部署 | us-west-2，`llmar` 前缀，router task def :20（b90f104），1 个 task，ARM64，1024 CPU / 2048 MiB，`stateStore=dynamodb` |
| 链路 | 客户端 → AgentCore Gateway（Cognito JWT）→ 私有 API Gateway（stage 限流 1000/2000）→ NLB → router（ECS Fargate）→ Bedrock |
| 接口 | `POST /inference/v1/chat/completions`，`stream: true`，`stream_options.include_usage` |
| 模型 | `auto:fast`，经别名路由到 fast 档位，实际服务模型 `global.openai.gpt-6-luna`（配置版本 `11-20261123T152037Z`） |
| 请求 | 单轮短提示（约 18 个输入 token），`max_completion_tokens: 64`；每个请求都用新的 `x-router-session`，所以每次都是 session-start 决策 |
| 客户端 | 4 个进程（`multiprocessing` spawn），每个进程内用 asyncio + httpx 跑若干闭环 worker：发一个请求，读完整条流，再发下一个，没有退避。总并发均分到 4 个进程 |
| 阶梯 | 4 → 20 → 50 → 100（计划到 150、200），每档 180 秒，从整分钟开始，档间空闲 60 秒。统计时去掉每档开头 10 秒的爬坡 |
| 观测 | 客户端逐请求记录：首字节、首个内容 token、端到端、状态。router 日志：`overheadMs`、`decideMs`、`upstreamTtfbMs`。CloudWatch 1 分钟粒度：`AWS/ECS` CPU/内存、`AWS/ApiGateway`、`AWS/Bedrock`、`AWS/Bedrock-AgentCore`、`AWS/DynamoDB`。另外每 15 秒采样一次 ECS 服务状态 |

客户端机器有 8 核。4 个客户端进程在 100 并发时各占 19–30% CPU，客户端不是瓶颈。

### 各档结果

成功的定义：HTTP 200、SSE 正常结束（`finish_reason` 为 `stop` 或 `length`，并收到 `[DONE]`）。延迟只统计成功请求。

| 并发 | 请求数 | 成功率 | 成功吞吐 RPS | 首字节 p50/p99 ms | 首 token p50/p99 ms | 端到端 p50/p90/p99 ms | router 开销 p50/p99 ms | 上游首字节 p50/p99 ms | ECS CPU %（稳态） | ECS 内存 %（稳态） |
|---|---|---|---|---|---|---|---|---|---|---|
| 4 | 1,103 | 100% | 6.1 | 591 / 1,135 | 564 / 1,172 | 636 / 738 / 1,151 | 6 / 17 | 288 / 771 | 4.8 | 11.7 |
| 20 | 6,769 | 100% | 38.3 | 462 / 820 | 444 / 792 | 511 / 638 / 854 | 6 / 13 | 171 / 501 | 20.9 | 13.7 |
| 50 | 17,755 | 99.98% | 100.1 | 419 / 738 | 416 / 728 | 479 / 574 / 786 | 6 / 54 | 163 / 462 | 46.6 | 15.8 |
| 100（限流前 +10…+130 s） | 22,022 | 100% | 183.5 | 454 / 860 | 448 / 843 | 508 / 653 / 892 | 13 / 224（p90 79） | 167 / 477 | 85.3（15:44） | 19.6 |
| 100（整档） | 44,188 | 67.8% | — | | | | | | | |

说明：

- 50 并发档的 3 个失败是客户端读超时或连接错误（`ReadTimeout` ×2、`ReadError` ×1）。router 日志里这一档全部是 200。
- 100 并发整档的失败：Gateway 429 共 12,806 个，Bedrock 429 经 router 透传 1,410 个，读超时或连接错误 7 个。
- 约 13–30% 的成功响应没有可见内容：64 个输出 token 被 reasoning 用完，`finish_reason: length`。这对 router 的转发路径没有影响。首 token 延迟只统计有内容的响应。
- 端到端时间约为 0.5 秒，其中 router 开销只占几毫秒到几十毫秒，其余主要是 gateway 链路（约 290 ms）和模型首字节（约 170 ms）。

#### router ECS 每分钟 CPU 与内存（UTC，1 分钟平均值）

| 档位 | 分钟 | CPU 均值 % | 内存均值 % | API Gateway 请求数 |
|---|---|---|---|---|
| 空闲 | 15:23–15:26 | 0.0–0.1 | 7.0 | — |
| 4 | 15:28 / 15:29 / 15:30 | 3.4 / 5.0 / 4.6 | 8.6 / 11.1 / 12.3 | 202 / 373 / 358 |
| 20 | 15:33 / 15:34 / 15:35 | 15.2 / 20.8 / 21.0 | 10.1 / 13.5 / 13.8 | 1,104 / 2,255 / 2,372 |
| 50 | 15:38 / 15:39 / 15:40 | 32.1 / 47.5 / 45.7 | 14.4 / 15.4 / 16.1 | 3,193 / 6,172 / 5,855 |
| 100 | 15:43 / 15:44 / 15:45 | 56.7 / 85.3 / 74.4 | 14.3 / 19.6 / 21.1 | 5,715 / 11,064 / 9,779 |
| 结束后 | 15:48 / 15:49 | — | 13.2 / 12.8 | — |

（每档第一分钟包含爬坡和上一档的空闲时间。15:45 的 CPU 偏低，是因为大量请求在 gateway 被拒、没有到达 router。）

内存从 7% 增长到 22%，压测结束后回落到 13%，与在途请求数和 GC 节奏一致，没有看到持续泄漏的迹象。整个过程中 ECS 一直是 1 个 task、同一个 task def，没有重启或扩缩容。

### 限流过程（100 并发档）

逐秒数据（相对该档开始时刻）：

| 时间 | 每秒发送 | 成功 | Bedrock 429 | Gateway 429 |
|---|---|---|---|---|
| +120…+134 | 153–196 | 全部 | 0 | 0 |
| +135…+138 | 171–285 | 98–160 | 11–187 | 0 |
| +139…+149 | 444–1,439 | 0–161 | 0–42 | 264–1,348 |
| +150…+168 | 133–199 | 全部 | 0 | 0 |
| +169…+177 | 150–294 | 105–169 | 2–189 | 0–2 |
| +178…+180 | 698–1,286 | 0–75 | 0–190 | 433–1,286 |

1. **Bedrock TPM。** `AWS/Bedrock` 的 `EstimatedTPMQuotaUsage` 在 15:43 和 15:44 分别为 5.46M 和 5.82M，超过 4M 配额（Global 与 cross-region 都是 4M）。按配额口径，每个请求约计 530 个 token，远高于实际的约 70 个 token（18 个输入加约 50 个输出），这是配额估算方式导致的。Bedrock 在配额超出约 1–2 分钟后才开始限流（15:45 `InvocationThrottles` = 1,410），说明配额有短时突发余量。按这个口径，**`gpt-6-luna` 在当前配额下能持续承受的这类请求约为 4M / 530 ≈ 7,500 次/分钟（约 125 RPS）**，高于这个速率只能维持短时间。
2. **AgentCore Gateway。** Bedrock 的 429 返回只需约 30 ms，闭环客户端随即重发，到达 gateway 的速率在 1 秒内从约 200 RPS 升到 1,000+ RPS。之后 gateway 对 `v1/chat/completions` 限流（`AWS/Bedrock-AgentCore` `Throttles`：15:45 11,506 个，15:46 1,300 个），每个 429 只需约 23 ms，也不会到达 router。限流期间有约 10 秒几乎全部被拒，之后恢复。本轮数据不足以确定 gateway 的确切速率上限（第二轮确认约为 200 RPS，见下文）。Service Quotas 里只列出了 tool-call 的 2,000 TPS，没有单独列出推理入口的配额。
3. **API Gateway 与 router。** 私有 API Gateway 的 stage 限流（1000/2000）没有触发：15:45 的 514 个 `4XXError` 是 router 透传的 Bedrock 429。router 没有返回过 5xx。

### 并发和 router task 容量

- **router 的瓶颈是请求速率（以及流式分片速率），不是连接数。** 按 Little 定律，并发 ≈ RPS × 请求时长。本轮请求时长约 0.5 秒，所以 100 并发约等于 185 RPS。真实的 agent 请求一条流常常持续 10–60 秒：同样 150 RPS 的入口速率，对应几千条同时打开的流。这时每条流的分片转发和更大的请求体都会占用 CPU，单 task 能承受的 RPS 会低于本轮测得的数，需要用更接近真实的负载（长输出、大上下文）再测一轮。
- **按本轮数据的估算：** CPU% ≈ 0.46 × RPS + 2。1 vCPU 的 task 在约 210 RPS 时 CPU 到 100%。Node 主线程是单线程，CPU 接近 100% 后开销会迅速增大：100 并发时 p99 已经到 224 ms。
- **扩容方式。** 部署参数 `routerDesiredCount` 大于 1 需要 `stateStore=dynamodb`，当前部署已经满足。状态表在约 185 RPS（每秒约 740 次读写）时平均延迟约 3 ms，没有被限流，还有余量。task 也可以改成 2 vCPU，但单线程 Node 无法充分利用第二个核，横向加 task 更有效。
- **其他上限：** Bedrock 的单模型 TPM 配额（fast 档 Luna 持续约 125 RPS）和 AgentCore Gateway 的速率限制会比 router 更早到达。要提高整体容量，需要先申请提高 Bedrock 配额，并给客户端加 429 退避，避免重试风暴把 gateway 也打到限流。

### 副作用与成本

- router 统计的 Bedrock 成本为 **$1.54**：57,116 个到达 router 的请求，输入 1.07M token、输出 2.86M token（其中 reasoning 2.11M）。客户端总共发出 69,919 个请求，含冒烟和探测。gateway、DynamoDB、日志的费用另计，估计不到 $1。
- 约 5.7 万条测试请求进入了控制台的 usage 统计（principal `P#none`，未归属），会出现在 Overview 的请求数和成本里。
- 测试期间 `llmar-usage` 表有 3,057 次 `WriteThrottleEvents`，但 usage-ingest Lambda 0 错误、DLQ 为空，说明重试后都写进去了。如果以后长期在这个量级运行，需要关注这张表的写容量。
- Bedrock 限流期间（约 15:45–15:46），同账号同 Region 使用 Luna 的其他调用也会受影响。测试窗口内其他调用方的请求只有 10 个，全部成功。

### 局限

- 只测了一种很短的请求形态（短输入、短输出），没有长上下文、长输出、工具调用或多轮会话。
- ECS 指标是服务级的 1 分钟平均值（未开启 Container Insights），看不到秒级峰值。
- 每个请求都是新的 session，所以 router 每次都走 session-start 决策，并写 DynamoDB 状态。多轮会话中后续请求的开销可能不同。
- 150 和 200 并发档没有跑。100 并发时 router CPU 已到 85%，按线性外推，200 并发（约 370 RPS）需要 2 个 task 才能不饱和。

## 第二轮（2026-11-24）：2 个 task 与自动扩缩容

### 设置

与第一轮相同的链路、接口和模型（`auto:fast` → `global.openai.gpt-6-luna`），以下几处不同：

| 项目 | 值 |
|---|---|
| 部署 | GitLab main `68a3722`：`-c routerAutoscale=2,4 -c routerScaleCpu=60 -c stateStore=dynamodb`，task def 仍是 :20（镜像不变）。扩缩容策略为目标跟踪，指标是服务平均 CPU，扩容冷却 60 秒、缩容冷却 300 秒；告警为高于目标连续 3 分钟、低于目标的 90% 连续 15 分钟 |
| 请求 | `max_completion_tokens: 8`。第一轮的 64 让 Bedrock 配额先用完；16 时每个请求按配额计 179（实测），只能持续约 370 RPS；8 时约 99，可持续约 670 RPS。代价是请求更轻：几乎所有响应只有 reasoning token、没有可见内容 |
| 客户端 | 4 个进程，闭环；收到 429 后做带随机抖动的指数退避（0.5 秒起，翻倍，最多 8 秒） |
| 阶梯 | 20 → 50 → 100 → 150 → 200 并发（每档 3 分钟，200 计划保持 10 分钟），错误率超过 20% 停止 |

### 各档结果

| 并发 | 请求数 | 成功率 | 成功 RPS | 端到端 p50/p90/p99 ms | router 开销 p50/p99 ms | 上游首字节 p50/p99 ms | 每个 task 的 CPU（稳态） | 内存 | 两个 task 的请求数 |
|---|---|---|---|---|---|---|---|---|---|
| 20 | 12,484 | 99.98% | 70 | 249 / 298 / 486 | 7 / 19 | 158 / 391 | 19.5% | 15% | 6,048 / 6,436 |
| 50 | 34,519 | 99.99% | 194 | 242 / 284 / 489 | 6 / 100 | 153 / 375 | 46.2% | 17% | 16,493 / 18,026 |
| 100 | 39,776 | 77.3% | 171 | 246 / 324 / 589 | 7 / 228 | 153 / 349 | 43.6% | 19% | 14,997 / 15,768 |

100 并发档的失败中，9,011 个是 gateway 的 429，其余 5 个是读超时或连接错误。阶梯在这一档停止，150 和 200 没有跑。整个过程中 ECS 一直是 2 个 task，没有扩容（每个 task 约 46%，低于 60% 的目标）。

### AgentCore Gateway 的速率上限

- **限流发生在 router 之前。** gateway 的 429 约 20 ms 就返回，响应里没有 `x-router-model`，router 日志也没有这些请求。CloudWatch `AWS/Bedrock-AgentCore` 的 `Throttles`（`v1/chat/completions`）在 09:55–09:58 共 9,011 次，与客户端统计一致。Bedrock 这一轮没有限流（`InvocationThrottles` 为 0），API Gateway 没有 4XX/5XX。
- **放行速率约 200/秒。** 50 并发时每秒放行均值 195、最高 208，没有 429。100 并发时客户端每秒发出约 222 个请求，平均只放行 171 个；逐秒放行量在 82 到 354 之间，像是有突发余量的令牌桶。
- **来源。** gateway 上没有配置自定义速率限制（`list-gateway-rate-limits` 为空）。Service Quotas 里 “Rate of tool-call/tool-list requests per gateway”（L-8CAB3FF3）和 “Rate of tool-call/tool-list requests”（L-A0D48779）的默认值和当前值都是 2,000，账号没有申请过调整；而 AgentCore 文档写的默认值是每个 gateway、每个账号各 200 TPS，与实测一致。推理请求在指标里记为 `Protocol=MCP`、`Name=InvokeInference`，按 tool call 计。
- **账号级共享。** 09:56 有 7 个其他调用方的 `v1/messages` 请求也被 gateway 限流。这个速率由账号内所有 gateway 和所有调用方共用。
- **提高的方法**（本轮没有申请）：见[部署 runbook 的配额一节](../deploy-runbook.zh-CN.md#73-部署前申请提高的配额)。

### 扩缩容验证

在默认的 60% 目标下，gateway 的上限让 CPU 到不了扩容阈值，所以临时把目标改成 30%（`-c routerScaleCpu=30`，只改这一个参数，diff 只有 `TargetValue`），以 40 并发（约 150 RPS，给其他调用方留出约 50 RPS 的 gateway 余量）压测 12 分钟。

| 时间（相对压测开始） | 事件 |
|---|---|
| 0 | 2 个 task，每个约 38–40% CPU |
| +5.4 分钟 | 扩容告警（>30% 连续 3 分钟）进入 ALARM，desired 2 → 3（10:22:24） |
| +6.2 分钟 | 第 3 个 task 开始运行并通过 NLB 健康检查，开始分担请求 |
| +8.4 分钟 | 告警回到 OK；之后 3 个 task 每个约 28–29% CPU，高于缩容阈值 27%，没有来回扩缩 |
| +12 分钟 | 压测结束：107,044 个请求，成功率 99.99%（12 个读超时或连接错误），149 RPS，端到端 p50/p99 243/521 ms；gateway 和 Bedrock 都没有限流 |
| +30.5 分钟（压测结束后约 18.5 分钟） | 缩容告警（<27% 连续 15 分钟）进入 ALARM，desired 3 → 2（10:46:29），10:47:00 完成。被停的 task 先从 NLB 注销，再按优雅停止流程结束 |

三个 task 在压测期间处理的请求数为 44,749、45,992 和 14,074（第 3 个 task 从 +6.2 分钟起才加入）。验证完成后用 `-c routerScaleCpu=60` 重新部署，恢复原设置。

### 副作用与成本

- 两段压测共约 21 万个请求进入 router（第二轮阶梯 8.7 万，扩缩容验证 10.7 万，配额探测 2,828），全部进了控制台的 usage 统计（principal `P#none`）。
- 输出上限是 8 token，Bedrock 费用约为每请求 $0.000006，合计约 $1.3；gateway、DynamoDB、日志另计。
- 7 个其他调用方的请求在 gateway 被限流（见上文）。扩缩容验证期间没有任何接口被限流。

## 下一步

1. **提高 AgentCore Gateway 的速率上限**（暂不申请）：要突破约 200 RPS，需要提高每个 gateway 和每个账号的速率。Service Quotas 已经显示 2,000，所以要通过 AWS Support case 申请，见[部署 runbook](../deploy-runbook.zh-CN.md#73-部署前申请提高的配额)。之后才能测 2 个以上 task 的线性扩展。
2. **用接近真实的负载测量**：长输出流、几十 KB 的上下文，测单 task 能承受的并发流数和每请求的 CPU。
3. **查 router 开销的长尾和偶发的 120 秒卡住**：需要进程内的事件循环和 GC 指标，以及 gateway 侧的请求日志。
4. **压测和其他调用方隔离**：账号级的 gateway 速率是共用的，以后的压测应放在单独的账号里。

## 复现方法

测试脚本在 [experiments/router-loadtest/](../../experiments/router-loadtest/)（用法见其中的 README），各轮的汇总数据在其 `results-*/` 目录下，逐请求的原始数据没有入库。脚本按下面的方式运行：

- 用 E2E agent client 的 client-credentials token 调用 gateway 的 `/inference/v1/chat/completions`。
- 请求体与第一轮相同（第二轮把 `max_completion_tokens` 改为 8）：`model: "auto:fast"`，`stream: true`，`stream_options.include_usage: true`，`max_completion_tokens: 64`，单轮短提示，每个请求一个新的 `x-router-session`。
- 4 个进程闭环发送，每档 180 秒，从整分钟开始，档间空闲 60 秒，这样可以和 CloudWatch 的 1 分钟指标对齐。错误率超过 20% 时停止。
- 对照的数据源：router 日志 `/<prefix>/router` 中 `kind = "model"` 行的 `overheadMs`、`decideMs`、`upstreamTtfbMs`、`durationMs`；`AWS/ECS` 的 `CPUUtilization` / `MemoryUtilization`（ClusterName、ServiceName）；`AWS/Bedrock` 的 `Invocations`、`InvocationThrottles`、`EstimatedTPMQuotaUsage`；`AWS/Bedrock-AgentCore` 的 `Throttles`；`AWS/ApiGateway` 的 `Count`、`4XXError`、`5XXError`；`AWS/DynamoDB` 状态表的 `SuccessfulRequestLatency`。

客户端应对 429 做指数退避（第二轮已这样做），否则 Bedrock 限流后会形成重试风暴，触发 AgentCore Gateway 限流（见上文“限流过程”）。
