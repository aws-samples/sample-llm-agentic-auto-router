# 评估器 v2.4 轮：反事实标签、人工校准、family 规则、保留意见与显式信号（评估报告）

> 本轮所有数字都只来自 **dev 集**（v2.3 的会话切分，801 个 turn）。v2.3 的留出集没有新的调用；只有 ⑦ 的一个示例在 v2.3 已有的 test 运行结果上离线重算。数据来自本机的
> Claude Code 会话记录，只在本地使用（各实验目录的 `results/` 不提交）。本报告只有汇总数字，不引用任何会话文本。
>
> 代码与数据：`experiments/assessor-v23/hold.py`（保留意见）、`packages/console-contract/src/family-proxy.ts`（family
> 规则的证据定义和校准）、`experiments/card-v3/`（card/v3 和学习头）、`experiments/assessor-v24/`（反事实标签、人工
> 校准、效用指标；计划见其中的 `PREREG.md`）。

## 摘要

**问题。** v2.3 之后剩下的误差主要有三类：被沿用的 fast 判断（保留意见）；fast 认不出来（交互会话召回约 20%，
自动化 agent 约 5%）；frontier 认不出来（约 4%）。另外，v2.3 的标签是"事后判断"，不是"换成另一档模型实际会怎样"。

**这一轮提出了七项改动**，分给四个并行的工作：

| # | 改动 | 负责 | 结果 |
|---|---|---|---|
| ① | 反事实标签，加一个人工校准集 | C | 试点后**停止**：一步的反事实标签与事后标签不一致，也预测不了用户；人工校准保留为结论 |
| ② | 按 template family 的 fast 规则，在控制台中从流量证据提名，管理员批准 | B | **合入**（控制台） |
| ③ | 保留意见不对称：只沿用 standard / frontier，不沿用 fast（`assessorHoldTiers`） | A | **合入**，默认开启 |
| ④ | card/v3：从用户文本中去掉学到的模板前缀 | D | **否决**（产品代码中移除） |
| ⑤ | 学习的映射，替代手写的门槛（`mapping.learned`） | D | 作为**可选项**保留，系数不提交 |
| ⑥ | 显式的 frontier 信号代替预测：policy 规则条件 `effort`、`permissionMode` | A | **合入**，只是能力，没有内置规则使用 |
| ⑦ | 用一个按成本加权的效用作为选择指标 | C | **采用**，从此是 pack 选择的主指标（`score24.py`） |

**结论（dev 集）：**

1. **一步的反事实标签与事后标签不一致**（κ −0.04 [−0.14, +0.10]，n 231）。在多步的 turn 上，它衡量的其实是"第一步是否
   相同"：219 个 turn 中 188 个，fast 与 standard 的第一个工具相同。
2. **用户第一遍给的是事先的偏好，不是"够不够"**（fast 只有 2%）。这是用户自己的说明："在没有看到 fast 的输出时我更想要
   的档位；如果 fast 的输出一样好，我会接受它。"
3. **看到真实输出时（第二遍，n 33），用户在 76% [59, 87] 的 turn 上接受 fast**，比任何一套标签都多（反事实 / 判断者 55%，
   事后约 30%，第一遍 2%）。所以按事后标签训练的路由，以用户的标准衡量是 fast 用得太少。这是上界：用户评判的是一步，
   不是整个 turn。
4. **Opus 判断者抓得住比例，抓不住是哪些 turn**（与用户 κ 0.14 [−0.14, +0.40]），所以取消了后续由 LLM 判断的标注。
5. **下一步的投入是人对真实输出的判断，在新的会话 `heldout-1` 上**（第 5 节）。
6. **合入的改动：** ② family 规则（dev 上一个自动化 family，721 个 turn，事后 fast 比例 98.1%；交互会话 0 / 8 个 family 过
   门槛）；③ 保留意见不沿用 fast（v2.3 上被错误留在 fast 2.7% → 2.4%，价格指数 +0.003）；⑥ `effort` / `permissionMode`
   规则条件（只是能力）；⑤ 学习头作为可选项（自动化 agent 判对率 +62.5 pp，但学到的就是 ② 的 family，系数不提交）；
   ⑦ 效用指标。④ card/v3 否决（判对率不变，自动化 agent 每次调用成本约 ×3.4）。
7. **花费 $78.90**（本轮预算 $300）：C $77.64、D $1.26、A 和 B $0。

## 1. 目标与做法

### 1.1 目标

- 减少质量风险：被错误留在 fast、服务档低于需要。
- 提高 fast 召回，尤其是自动化 agent 的流量。
- 给 frontier 一个 card 之外的来源。
- 用更接近"实际会怎样"的标签替代事后判断，并给 pack 选择一个综合了成本和质量风险的指标。

### 1.2 数据和切分

沿用 v2.3 的会话 turn 导出（`experiments/assessor-v23/sessions.py`）和按会话的 FNV 切分。本轮**只用 dev**：

| 数据 | dev | 说明 |
|---|---|---|
| 交互会话（Claude Code） | 801 个 turn，709 个两位标注者一致 | 与 v2.3 相同 |
| 自动化 agent（kiro-crew 工作区） | 763 个有标签的 turn | v2.3 的第二个留出集，本轮在其 dev 部分上校准 |

dev 用于 v2.3 的每一项选择，所以本轮的所有数字都是**探索性**的；确认需要新的留出集（第 5 节）。

### 1.3 指标

和 v2.3 相同：服务档按 core 的规则模拟（有意见用意见，否则沿用保留的意见，否则 pool 默认），不含成本门和降级保护。
判对率、被错误留在 fast、服务档偏低、价格指数（fast 0.05、standard 1、frontier 2，相对于全部 standard）；区间是
按会话的配对 bootstrap。C 的效用指标（⑦）见 3.7。

## 2. 合入与否决

| # | 改动 | 状态 | 位置 |
|---|---|---|---|
| ① | 反事实标签、人工校准集 | 试点后停止（实验代码，不进产品） | `experiments/assessor-v24/`（`rebuild.py`、`cf.ts`、`judge-cf.ts`、`label.py`、`human.py`、`agree.py`） |
| ② | family 规则的证据和提名（`fast-proxy/1`） | 已合入 main | console-contract、usage-ingest、console-api、console-web |
| ③ | `assessorHoldTiers`，默认 `['standard', 'frontier']` | 已合入 main | core、router（`ROUTER_ASSESSOR_HOLD_TIERS`）、infra（`-c assessorHoldTiers`） |
| ④ | card/v3 | 否决，从产品代码中移除 | 模板记忆只保留为学习特征的来源（3.4） |
| ⑤ | `mapping.learned`（fast / frontier 头），请求特征含 `templateChars` | 可选项，系数不提交 | assessor（`map.ts`、`pack.ts`、`template.ts`）、router（进程级模板记忆）、usage-ingest、console-web |
| ⑥ | `when.effort`、`when.permissionMode`，`RULE_WHEN_KEYS`、`WHEN_TOKEN_RE` | 已合入 main | core（policy、summarize）、console（规则编辑器） |
| ⑦ | 效用指标 | 采用，pack 选择的主指标 | `experiments/assessor-v24/score24.py` |

**合入 main 的代码**（1620c50 之后，按时间）：

| 提交 | 内容 | 项 |
|---|---|---|
| 2147474 | usage-ingest、console-api：template family 的证据（F# 汇总、`fast-proxy/1`、`GET /api/admin/config/family-rules`） | ② |
| 9f0099d | console-web：路由策略页"建议的 fast 规则"，加入草稿后经激活生效 | ② |
| 773fb05 | core、router：`assessorHoldTiers`，`ROUTER_ASSESSOR_HOLD_TIERS`，`assessor-hold-blocked` | ③ |
| 8738941 | core：规则条件 `effort`、`permissionMode`，从请求体只读提取；`RULE_WHEN_KEYS`、`WHEN_TOKEN_RE` | ⑥ |
| 185e9df | infra（`-c assessorHoldTiers`）和设计文档 | ③ ⑥ |
| 9493758 | 合并 `feat/held-asym`（上面三个提交） | ③ ⑥ |
| 0aee786 | console：规则编辑器、规则说明句和翻译支持 `effort`、`permissionMode` | ⑥ |
| 6365478 | console-web、usage-ingest：记录和决策详情里的 `holdTiers`；测试 mock 用临时端口 | ③ |
| 39cf5fc | assessor：模板记忆和学习的 fast 头（`mapping.learned`，可选；card 仍是 card/v2） | ⑤ |
| ef89354 | router、usage-ingest、console-web：进程级模板记忆给出 `templateChars`（只对验证身份的请求） | ⑤ |
| e2c008e | experiments：模板记忆的测量和学习头的拟合（只用 dev；系数不提交） | ⑤ |
| 60fb89d | console-api 测试：fixture id 不含 12 位数字（N5） | ② |
| ce4dcdc | experiments：学习头的说明，事后标签相对用户偏保守 | ⑤ |

未合入 main 的分支：`feat/eval-v24`（①、⑦ 的实验代码，C）、`feat/heldout-1`（`heldout.py`，A）。

## 3. 各项结果

### 3.1 ① 反事实标签和人工校准集（C）

**反事实标签。做法**（计划写在 `experiments/assessor-v24/PREREG.md`，在试点判断之前）：

- 从会话记录重建每个 turn 当时的真实请求（`rebuild.py`）。dev 上 801 个 turn 中 768 个（95.9%）能精确重建：24 个没有对应的
  请求记录，9 个有无法解析的条目；104 个子 agent turn 全部能重建。
- 把请求换成 fast（Haiku 5.5）和 standard（Sonnet 5.5）各生成一步（`cf.ts`），与原始的一步（多数是 Opus 5.5）比较。
  Opus 5.5 做两种顺序的成对判断：Q1 是 fast 对 standard，Q2 是 standard 对原始的一步（97% 的原始一步来自 frontier 档：
  Opus 5.5 或 Fable 5.2）。GPT Astra 在 20% 的试点 turn 上复核（自我偏好审计）。区域 ap-northeast-1，与 v2.3 的标注相同。
- 标签规则：两种顺序下 fast 都不差且都足够，才是 fast；frontier 要求两种顺序下原始一步都更好；其余为 standard。

**试点结果（255 个 dev turn，PREREG §10）：**

- 机制：510 / 510 步全部生成，没有截断，83% 的 prompt token 从缓存读取。每步输出 token：fast 平均 818（p90 2.0k），
  standard 525（p90 915）。
- 两种顺序的一致率：Opus Q1 83.5%（212 / 254），**低于 85% 的门槛**；Q2 87.0%。不一致都是"相同"对"一方更好"，
  没有 fast 与 standard 互换的情况。Astra Q1 86.4%，Q2 13 / 13。
- cf-opus 标签：fast 60%、standard 28%、frontier 11%；"fast 足够"变体下 87 / 7 / 5。
- 自我偏好（44 个两位判断都有的 turn）：fast 比例 Opus 0.64 [0.49, 0.76]，Astra 0.70 [0.56, 0.82]，差 −0.07
  [−0.21, +0.06]，未检出（只有 Opus 判 fast 的 4 个，只有 Astra 判 fast 的 7 个）。Opus 与 Astra 一致 70% [56, 82]，
  κ 0.40 [0.08, 0.66]。
- **反事实标签与事后标签不一致**：cf-opus 对事后一致标签，一致率 34% [28, 41]，κ −0.04 [−0.14, +0.10]，加权 κ −0.08
  （n 231）。对单个事后标注者（κ −0.05 / −0.04）、以及 Astra 判断的反事实标签（κ 0.02）都是如此，不是某一个判断者的问题。不一致有结构，两个方向都有：
  - 多步的 turn：一步主要衡量的是"第一步是否相同"。219 个 turn 中有 188 个，fast 与 standard 的第一个工具相同
    （多是探索性的 Bash 或 Read）。原始 agent 做了 41 次以上工具调用的 turn，反事实标签 73% 判 fast；子 agent turn
    91% 判 fast，而事后标签多数是 standard 或 frontier。
  - 短的 turn（原始 agent 至多 2 次工具调用，n 63）：事后标签 87% fast，反事实标签 52% fast。这里判断者比较的是
    两个真实的回答，事后标注者没有看到过它们。
- 因此 dev 其余部分的阶段暂停，由人工标签按预先登记的规则（PREREG §11，在任何人工标签之前提交）决定用哪种标签。

**人工校准集。做法：** 在任何反事实标签产生之前，从可重建的 dev turn 中抽取 100 个（种子 20261117），按 turn 类别和 v2.3 事后
标签分层，每层至少 3 个，权重为层大小除以抽样数。第一遍：用户看对话结尾、请求和 agent 实际做了什么（与事后标注者
看到的相同），给出需要的 tier 和把握程度。第二遍（可选）：fast 与 standard 两步随机 A/B 排列，盲评。`agree.py`
报告一致率（Wilson）、Cohen's κ、线性加权 κ（按会话 bootstrap）和混淆矩阵。

**第一遍（100 个 turn，PREREG §11.1）：** 在 34 个三种标签都有的 turn 上（99% 区间），线性加权 κ：人对事后
−0.01 [−0.37, +0.20]，人对反事实 +0.11 [−0.07, +0.31]，差 −0.12 [−0.54, +0.18]：分不出哪种标签更接近人
（预先登记规则的分支 U）。全部 100 个 turn 上，人给 fast 2%、standard 57%、frontier 41%；两位事后标注者分别是
30 / 40 / 30 和 28 / 51 / 21，事后一致标签（n 83）33 / 45 / 23；34 个共同 turn 上反事实 53 / 32 / 15（人 3 / 62 / 35）。
两位事后标注者都判 fast 的 27 个 turn，人给了 standard 78%、frontier 22%；短 turn（n 21）事后 90% fast，人 0%。
把握程度：3 分 72 个，2 分 28 个。补充：全部 83 个有事后一致标签的 turn 上，人对事后的加权 κ +0.02 [−0.16, +0.13]；
"是不是 frontier"上人对 Opus 事后标签的 κ 0.16。
**用户事后说明第一遍的标准是"在没有看到 fast 的输出时，我更想要的档位；如果 fast 的输出一样好，我会接受它"**
（原话："the tier I'd prefer, without having seen what fast does. If fast's output is as good, I'd accept it."）：
第一遍是事先的偏好，不是"够不够"的判断。

**第二遍（33 个 turn，PREREG §11.2）：** 用户看到同一 turn 真实的 fast（Haiku 5.5）和 standard（Sonnet 5.5）下一步，
A/B 随机排列。fast 更好 17、相同 8、standard 更好 8：**fast 不差于 standard 的比例 76% [59, 87]**，可接受 26 个。
fast 在 A、B 两个位置都占优（作为 A：7 好 / 6 差；作为 B：10 / 2），略偏向 B。同样这些 turn 上，第一遍判 standard 的
18 个里有 12 个、判 frontier 的 13 个里有 11 个，在第二遍里 fast 不差。

与 Opus 判断（Q1 认定 fast）对照：一致 58% [41, 73]，κ +0.14 [−0.14, +0.40]。判断者更严（fast 18 / 33，用户 25 / 33）：
判断者 standard、用户 fast 的有 10 个，反过来 4 个（这些 turn 上反事实标签的 fast 判断与 Q1 完全相同）：

| 分层 / 类别 | n | 一致 | κ |
|---|---|---|---|
| 短（原始至多 2 次工具调用） | 5 | 5 / 5 | 1.00 |
| 长 | 28 | 14 / 28（50%） | −0.05 [−0.33, +0.25] |
| 子 agent | 8 | 8 / 8（都是 fast） | — |
| 用户消息 | 7 | 4 / 7 | +0.22 |
| 其他（命令、压缩） | 9 | 5 / 9 | +0.05 |
| 通知 | 9 | 2 / 9 | −0.40 [−0.92, 0.00] |

**解读：** 看到输出时，用户用的正是一步"够不够"的标准，而且比任何一种标签都更常接受 fast：用户 76%，反事实 / 判断者
55%，事后约 30%，第一遍 2%。按事后标签训练的路由，以用户的标准衡量是 fast 用得太少。这是一个上界：用户评判的是下一步，
不是整个 turn。判断者抓得住比例，抓不住是哪些 turn（κ 0.14），所以取消了后续由 LLM 判断的标注（dev 其余部分，
约 $129 未花）。D 的标签仍用事后一致标签，带两条说明：第一遍是偏好；用户看到输出时 76% 接受 fast，所以事后标签
相对用户是 fast 用得太少。

### 3.2 ② 按 template family 的 fast 规则（B）

**做法。** v2.3 已经发现：自动化 agent 的流量里，一个固定模板的 family 几乎全是 fast，而 assessor 只认出约 5%。
本轮把"按 family 提名 fast 规则"做进控制台：usage-ingest 按 family 和天汇总 assessor 记录下的事实（不是判断），
console-api 用证据代理计算每个 family 的比例和 Wilson 下界，路由策略页列出"建议的 fast 规则"。管理员加入草稿、
校验、激活后才生效，激活说明里自动带上证据。

**证据代理 `fast-proxy/1`**：一个被咨询的用户 turn，如果 assessor 的事实是"不改代码、没有之前的失败、推理深度为
lookup 或 routine"，就算作 fast。默认门槛：14 天、n ≥ 30、Wilson 下界 ≥ 0.95。不用 assessor 的 tier 判断。

**校准**（v2.3 的 dev 集、事后标签、只看汇总）：

| 数据 | n ≥ 30 的 family | 过门槛 | 说明 |
|---|---|---|---|
| 自动化 agent（763 个有标签的 turn） | 1 个（721 个 turn） | 1 | 事后 fast 比例 98.1% |
| 交互会话（709 个有标签的 turn） | 8 个 | 0 | 单个 turn 上代理的精确率只有 0.49 |

交互会话上单个 turn 的代理并不准，规则安全靠的是 family 级的下界和管理员审核。

**否决的代理：**

- **"assessor 判了 fast"**：什么也提名不出来（自动化 dev turn 上的 fast 召回 6.5%）。
- **事实 + "本轮没有工具错误"**（重试的替代）：这个 family 13% 的 fast turn 有工具错误，加上它之后 family 落到
  0.95 以下（turn 召回 0.87，原来 0.99）；而且 router 的记录看不到工具错误。
- **输出规模**（模型调用少、输出短）：自动化的 fast turn 并不小（每个约 13 次工具调用），放宽到能容纳它们的程度时，
  交互会话约一半的 turn 会被判为 fast。

### 3.3 ③ 保留意见不沿用 fast（A1）

**改了什么。** core 在本轮没有可用意见时，用 lineage 保留的上一个意见代替（task 11-16 D2）。v2.3 的留出集上，74 个
被错误留在 fast 的 turn 里有 64 个是沿用来的。v2.3 堵住了"无规则"和"置信度不足"两条路，但 precheck 跳过、冲突、
超时、错误、不可用、无效的 turn 仍会沿用保留的 fast。现在只有 `assessorHoldTiers` 里的 tier 可以沿用，默认是
standard 和 frontier。被挡下时决策回落到基线，记 `guard: 'assessor-hold-blocked'`，auto 模式下原因末尾加
`; assessor-hold-blocked fast`；被挡下的意见仍然保留。`['fast', 'standard', 'frontier']` 是之前的行为（用于 replay），
`[]` 表示什么都不沿用。设计见 [assessor 设计 §2.4](../architecture/assessor-design.zh-CN.md#24-意见怎么用)。

**dev 上的离线模拟**（`hold.py`，709 个一致标签）。"对称"是旧行为，"不对称"是新默认：

| assessor | 沿用方式 | 判对率 | 被错误留在 fast | 服务档偏低 | 价格指数 |
|---|---|---|---|---|---|
| v2.3（现行映射） | 对称 | 54.9% | 2.7% | 16.6% | 0.931 |
| | 不对称 | 55.0% | 2.4%（−0.3 [−0.6, 0]） | 16.5% | 0.934（+0.003 [0, +0.006]） |
| | 只在 precheck 跳过时沿用 fast | 54.9% | 2.5% | 16.6% | 0.932 |
| | 什么都不沿用 | 55.0% | 2.4% | 16.5% | 0.934 |
| v2.2 | 对称 | 48.1% | 20.3% | 29.5% | 0.749 |
| | 不对称 | 48.8% | 2.4%（−17.9 [−26.5, −5.7]） | 15.4% | 1.047（+0.30 [+0.09, +0.45]） |
| | 只在 precheck 跳过时沿用 fast | 48.4% | 3.1% | 15.9% | 1.039 |
| | 什么都不沿用 | 52.5% | 2.4% | 16.1% | 0.972 |

- v2.3 上沿用 fast 的只有 2 个 turn，所以四种方式几乎相同。对线上的 auto 配置（`AUTO_RULES=all`、pack v2.3），新默认
  使成本约增加 0.3%，被错误留在 fast 的 turn 少约十分之一。
- "只在 precheck 跳过时沿用 fast" 在两种 pack 上都介于两者之间，没有更好，所以没有采用。core 也区分不出跳过和其他
  无意见的情况，采用它需要新的信号。
- v2.2 上"什么都不沿用"在判对率（52.5% 对 48.8%）和成本（0.972 对 1.047）上都好于"不对称"：沿用 standard / frontier 也会造成服务档偏高。
  v2.3 上两者相同。`[]` 或 `['frontier']` 是否更好，要在新的留出集上看。

### 3.4 ④ card/v3（否决）（D）

**card/v3。** 自动化客户端在用户消息开头放一大段固定提示词，card/v2 因而主要显示固定部分。card/v3 在进程内学习每个
范围内多个 lineage 都发过的行边界前缀（只存哈希），在 card 中去掉它，只保留可变部分和模板开头 300 字符。

dev，一致标签，v2.3 手写映射：

| 数据 | 指标 | v2.3（card/v2） | card/v3 |
|---|---|---|---|
| 交互会话 | 判对率 | 54.9% | 54.7%（−0.1 [−2.2, +1.4]） |
| | 被错误留在 fast | 2.7% | 2.0% |
| | 价格指数 | 0.931 | 0.956 |
| 自动化 agent | 判对率 | 9.4% | 9.4% |
| | 每次调用的 assessor 成本 | $0.00023 | $0.00078 |

判对率没有改变，成本反而更高，否决。

**评审发现**（A 对 card/v3 分支的独立评审）及处理：

| 发现 | 影响 | 处理 |
|---|---|---|
| 相同的整条消息由 3 个 lineage 发出时（任务重跑、重复粘贴），除最后一行外都会被当作模板去掉 | 实测 853 个字符中去掉 848 个，assessor 看不到任务 | card 不再去掉任何文本（仍是 card/v2）；前缀只有在发送它的 lineage 之后各走各路时才算模板，相同的重发不算 |
| 没有验证身份的请求共用一个范围 | 一个调用方的流量可以挤掉或制造另一个调用方的模板 | 没有验证身份时既不读也不写模板记忆 |
| 每个 assessor 实例各有一份记忆，最坏约 45 MB，最多缓存 8 个实例 | 2 GiB 的 task 上最坏约 360 MB；设置一变就从空开始 | 每个进程一份记忆，所有 assessor 实例共用，设置变化后保留；全局上限 131,072 项（约 20 MB） |
| 范围按用户而不是租户，最多 32 个范围 | 活跃的（用户, family）超过 32 个时反复淘汰 | 范围仍是验证身份 × template family，上限提到 64 个 |
| 记忆是进程内的 | 多个 router task、重启后，同一请求的特征不同；离线实验模拟的是一份全局记忆 | 保留；作为学习特征使用时这是训练和服务的差异 |

**最终形态（已合入 main）：** card 不变；router 对有验证身份的请求在进程级模板记忆中测出用户文本开头学到的模板长度，
只作为请求特征 `templateChars` 交给映射（供 `mapping.learned` 使用）并写进 assessor 日志（一个数字）；记忆只存截断的
sha256 哈希。

### 3.5 ⑤ 学习的映射（可选）（D）

**学习头（`mapping.learned`）。** 每个 tier 一个冻结的逻辑回归，特征来自 assessor 的事实、命中的规则和 card 的数字
（含模板长度），达到阈值时给出该 tier，`basis` 为 `fact:learned`。配置：orHand + belowThreshold，阈值 0.98，
在 v3 的 assessor 输出上做按会话分组的 5 折交叉验证：

| 数据 | 指标 | 加学习头（对 v2.3 手写映射） |
|---|---|---|
| 自动化 agent | 判对率 | 72.0% 对 9.4%（+62.5 pp [+57.5, +67.3]） |
| | fast 次数 / 精确率 / 召回 | 543 / 98.2% / 72.3% |
| | 价格指数 | 0.32 对 0.94 |
| | 被错误留在 fast | +1.2 pp [+0.3, +2.3] |
| 交互会话 | 判对率 | −0.1 pp [−0.6, 0.0] |
| | 被错误留在 fast | +0.1 pp |

- 不用 card 特征时没有任何收益；在 v2.3 的 assessor 输出上拟合时，自动化 agent 的判对率 +74.0 pp。
- 标签敏感性：自动化 agent +41.9 pp（只看 Opus）到 +75.8 pp（只看 Astra）；交互会话在"两者取高"的标签下，被错误
  留在 fast +3.0 pp [+0.5, +7.4]。
- **解读：** 学习头重新学到的是 3.2 那个带固定模板的自动化 family。family 规则覆盖同样的流量，而且要管理员批准、
  证据可审计。学习头在交互会话上没有收益，在一种标签定义下还会增加质量风险。所以它只作为可选项，系数不提交，
  不进入默认 pack。

### 3.6 ⑥ 显式信号：`effort`、`permissionMode`（A3）

**为什么。** frontier 召回约 4%，card 看不到客户端自己声明的设置。这两个条件让运维写确定性的规则，例如
`{ "id": "plan-frontier", "when": { "permissionMode": ["plan"] }, "tier": "frontier" }`。规则命中时不再咨询 assessor。

**哪些信号真的在请求体里。** 用离线抓包确认（回环网络命名空间、假服务端、抓包不提交）：

| 信号 | 来源 | 观察到的值 |
|---|---|---|
| `effort` | Anthropic `output_config.effort`（Claude Code 2.1.325，每个请求都带） | low / medium / high / xhigh / max，默认 high |
| `effort` | OpenAI Responses `reasoning.effort`（Codex 0.169，只在设置了 `model_reasoning_effort` 时带） | low、high |
| `permissionMode` | Claude Code `safeguards[].classifier_context.permission_mode` | 只有 `plan`、`auto`；default、acceptEdits、bypassPermissions、dontAsk 不带这个字段 |
| （不是信号） | `thinking` 始终是 `{type: 'adaptive'}`，`MAX_THINKING_TOKENS` 不改变请求体；`ultrathink` 只在用户文本里 | — |

Chat Completions 的 `reasoning_effort` 没有读取（没有抓到使用它的客户端）。值只接受短代码（`WHEN_TOKEN_RE`），
`safeguards` 里只读 `permission_mode` 一项（其余字段含主机路径）。内置 policy 和 preset 都不含这类规则。

**效果还没有衡量。** v2.3 的会话导出没有记录每个 turn 的权限模式和 effort。会话记录里有 `permission-mode` 记录，
下一轮可以据此统计 plan 模式 turn 的标签分布。

### 3.7 ⑦ 效用指标（C）

**做法**（PREREG §6–7）：

- 每个 turn 的 u = −价格(服务档) − 1·[服务档低于标签] − 7·[服务 fast 而标签不是 fast]，取平均。权重依据
  Harbor 的结果（见 PREREG §6），0.89 的盈亏点对应 v2.3 的 `fastMinConfidence` 0.9。只有效用差的配对区间在 0 以上、
  且被错误留在 fast 的差的区间不在 0 以上时，候选才替换基线。
- 检验力（PREREG §7，在 v2.3 的留出集运行上离线估计）：dev 大小（约 770）的集合上，判对率的最小可检出差异是
  3.6–7.1 pp；同样的运行上效用差为 +0.77 [+0.31, +1.21]，而判对率差的区间含 0。效用是这一轮有检验力的指标。

价格按 Haiku / Sonnet / Opus 5.5 的标价比（fast 0.05、standard 1、frontier 2）。一个被错误留在 fast 的 turn 两项错误都要付，
共 8。权重的依据：Harbor 上固定 Luna 以 −14 到 −17 pp 换 0.10–0.18 倍成本被否决，而按任务的 oracle（−2.4 到 −6.1 pp，
0.47–0.55 倍）被认为值得，这把一次失败的代价框在约 6–22 个 standard 运行；standard 不足而该用 frontier 记一次重做，
因为 Harbor 没有检出 frontier 的收益。权重敏感性网格 w_wf ∈ {3, 7, 20} × w_us ∈ {0.5, 1, 2} 只报告，不用于决策。

**示例**（标签为事后一致标签，2,000 次 bootstrap）：

| 比较 | 效用差 | 被错误留在 fast 差 | 判对率差 | 结论 |
|---|---|---|---|---|
| test：v2.2（发布版）→ v2.3（冻结） | +0.770 [+0.293, +1.220]（−2.038 → −1.268） | −0.118 [−0.187, −0.049] | +0.029 [−0.041, +0.085]，不显著 | 替换；成本 +0.127 [+0.045, +0.214] |
| dev：v2.2（b0）→ card/v2 + `unmatchedTier`（d，按运行时的映射，没有 v2.3 的另外两个键） | +0.836 [+0.188, +1.258] | −0.123 [−0.189, −0.025] | +0.052 [+0.005, +0.081] | 替换 |

效用检出了判对率没有检出的变化。检验力（v2.2 → v2.3 的 test 运行）：判对率的不一致率 21%，会话设计效应 2.6，3 pp 的
判对率差在 pack 不一致 5% / 10% / 20% 时需要 n ≈ 1,100 / 2,250 / 4,500；效用每个 turn 的标准差 2.4，设计效应 4.8。
③ 的沿用方式和 ⑤ 的学习头本轮没有在效用上重新比较。

## 4. 花费

| 项目 | 花费 | 上限 | 说明 |
|---|---|---|---|
| A：保留意见、显式信号、held-out 流水线 | $0 | — | 全部离线：dev 上的模拟和离线抓包，没有调用模型 |
| B：family 规则 | $0 | — | 没有实时调用：校准在 v2.3 的 dev 标签上离线完成，翻译器的测试使用假实现 |
| C：冒烟测试 | $3.12 | $5 | 其中 $0.80 是偏离：生成调用先在另一个账号里运行，结果已弃用，见 PREREG §10 |
| C：试点（255 个 turn） | $74.52 | $100 | 生成 $39.5（fast $7.6、standard $32.8），Opus 判断 $23.5（710 次，$0.092 / turn），Astra 复核 $11.5（44 个 turn，$0.26 / turn） |
| C：dev 其余部分（513 个 turn） | $0 | ≤ $175 | 取消（预先登记规则的分支 U 和第二遍的结果） |
| D：card/v3 与学习头 | $1.26 | — | $1.256 |
| **合计** | **$78.90** | 本轮 $300（C + D） | C $77.64（上限 $280）、D $1.26、A 和 B $0 |

## 5. 局限与下一步

- **所有数字都来自 dev。** dev 用于 v2.3 的每一项选择，本轮的比较只能排序候选，不能作为发布依据。v2.3 的留出集本轮
  没有再用。
- **新的留出集 `heldout-1`**（`experiments/assessor-v24/heldout.py`）：2026-11-17T00:00Z 之后有用户 turn、会话 id
  不在 v2.3 导出中（dev、test 和自动化 agent）的交互式 Claude Code 会话，项目范围与 v2.3 相同。每个 turn 标记
  `thisRepo`（本仓库及其工作树的会话讨论了评估设计，敏感性分析可以去掉它们）和 `afterSince`，可重建性按 `rebuild.py`
  的标准统计。

  | 截至 | 会话 | turn | 可重建 |
  |---|---|---|---|
  | 2026-11-17 13:30Z | 2（本仓库 1） | 2（human 1、notification 1） | 2 |

  原因：v2.3 的导出截到当天 09:11Z，上午的会话已在 dev / test 中；当天的主会话是恢复的 v2.3 会话；并行的 peer 会话
  里跨会话消息以工具结果或元数据记录，不算用户 turn。按 v2.3 的使用量（最近 10 天每天 4–157 个 root turn，中位数
  约 60），达到 v2.3 留出集的规模（约 580 个 turn）需要 1–2 周的正常使用。
- **标注成本估计（每个 turn）：** 事后标签约 $0.05（v2.3 实际：$69.0 / 1,382）；一步反事实加 Opus 判断约 $0.25（本轮试点：
  生成 $0.15、判断 $0.092）。下一步推荐的是人对真实输出的判断：两步生成在没有缓存时约 $1.1 / turn，像试点那样按会话顺序
  复用缓存时约 $0.16 / turn，另加用户的时间。500 个 turn 约 $80–550，取决于缓存；assessor 运行约 $1。
- **下一步：** 在 `heldout-1` 的新会话上做第二遍那样的人工判断（看真实的 fast 和 standard 输出），用效用指标比较 v2.3 与
  ③ 的沿用方式、⑤ 的学习头；不再做由 LLM 判断的一步标注。
- **frontier 召回仍未解决。** 显式信号给了确定性的办法，但需要有标签的 plan 模式 / 高 effort turn 才能衡量（3.6）。
- **反事实标签是一步，不是整条轨迹**，候选一步的工具调用没有执行；Opus 判断自己家族的输出（Astra 复核和人工集用来
  衡量这个偏差）。见 PREREG §9。
- **一位用户的会话，以 Claude Code 为主。**
