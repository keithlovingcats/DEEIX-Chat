# DEEIX-Chat 多模型讨论盲测独立性改造计划 (TODO)

本文档记录多模型讨论（Multi-Model Discussion）机制中「首轮锚定效应（Anchoring Effect）与自主性丧失」问题的成因分析、重构架构设计、代码落地方案与验证计划。

---

## 目录

1. [问题背景与现状诊断](#1-问题背景与现状诊断)
2. [核心理论缺陷：锚定效应与自主性丧失](#2-核心理论缺陷锚定效应与自主性丧失)
3. [重构架构设计：两阶段协商模型](#3-重构架构设计两阶段协商模型)
4. [核心落地代码方案（Minimal & Low-Risk）](#4-核心落地代码方案minimal--low-risk)
5. [已知限制（架构硬约束，方案内无法消除）](#5-已知限制架构硬约束方案内无法消除)
6. [进阶增强方案（可选实施）](#6-进阶增强方案可选实施)
7. [测试与验证计划](#7-测试与验证计划)
8. [待办任务清单 (Action Items)](#8-待办任务清单-action-items)
9. [方案可行性审视与架构优化建议 (Architecture Review)](#9-方案可行性审视与架构优化建议-architecture-review)

---

## 1. 问题背景与现状诊断

### 1.1 设计意图 vs 代码实际情况

- **设计意图**（CLAUDE.md「关键机制速查」）：
  > *「讨论 = 串行化的 fan-out——2-20 个模型 N 轮串行辩论（**第 1 轮独立回答**、后续轮互见 transcript 补纠挑战，主模型合成终稿）。」*
- **当前代码实际实现**（`frontend/features/chat/hooks/use-chat-discussion.ts`）：
  在串行循环中（`for (const turn of turns.slice(1))`，L416-L438），编排器**无差别地向每一次参与者发言注入了全量历史 Transcript**：
  ```ts
  // use-chat-discussion.ts L428-L436
  await runTurn(
    turn,
    buildDiscussionParticipantPrompt({
      modelName: turn.model,
      round: turn.round,
      userPrompt: content,
      transcript: buildDiscussionTranscript(turns), // ❌ 破绽：第 1 轮的模型 B、C 也被塞入了前序模型发言
    }),
  );
  ```
  `buildDiscussionTranscript`（L75-L86）收录所有 `status === "completed"` 且文本非空的 participant 发言。串行执行下，轮到第 1 轮的 Model B 时 Model A 已完成，因此 B 的 prompt 必然包含 A 的回答。

### 1.2 实际交互流水（以 3 模型 2 轮为例）

- **Turn 1（Model A, Round 1）**：输入仅为原始用户问题（首条走 default 分支，见 L406-L407）。独享唯一真正的「独立作答权」。
- **Turn 2（Model B, Round 1）**：输入被强行塞入 Model A 的回答，并被指令要求「*Read the previous viewpoints, then add missing points...*」。
- **Turn 3（Model C, Round 1）**：输入被强行塞入 Model A + Model B 的回答。

设计承诺的「第 1 轮独立回答」在代码中并不存在——除首条外，所有 Round 1 发言都是对前序发言的增量修补。

---

## 2. 核心理论缺陷：锚定效应与自主性丧失

这种实现虽然保障了对话的连贯性，但在多智能体（Multi-Agent Deliberation）博弈中带来了严重的认知偏置：

1. **议题框架锚定（Framing & Anchoring Bias）**：
   复杂问题具有多维度切入点（例如技术可行性、商业 ROI、安全风控、团队可维护性）。排在第一位的 Model A 划定了讨论的边界与术语基准，后续模型被强行吸附在 A 的框架下修修补补，丧失了提出全新分析维度的机会。
2. **大模型的「谄媚性」（Sycophancy / 顺从性）**：
   商用 LLM 经过 RLHF 微调后天然倾向于赞同上下文已有观点。面对已有答案，模型默认扮演「补充者」而非「推翻者」，激进质疑假设的概率锐减。
3. **信息级联与伪共识（Information Cascade）**：
   若 Model A 产生隐蔽幻觉或逻辑谬误，Model B、C 会将其视作已确立的事实继续外推，最终在错误的地基上形成虚假的高置信度共识。
4. **序列不平等特权（Sequence Privilege）**：
   仅通过调整模型在选择器中的拖拽顺序，整场讨论的基调与最终结果就会产生剧烈漂移。

---

## 3. 重构架构设计：两阶段协商模型

为了保证真正的多模型自主性与多元发散，讨论生命周期必须明确解耦为**盲测发散期**与**交叉评议期**：

```
阶段一：盲测独立发散 (Round 1)
┌────────────────────────────────────────────────────────┐
│                      用户提问 (Q)                       │
└───────┬──────────────────────┬──────────────────┬──────┘
        │ (无前序发言)          │ (无前序发言)      │ (无前序发言)
        ▼                      ▼                  ▼
   [Model A]              [Model B]          [Model C]
   输出: A1 (独立视角)     输出: B1 (独立视角)  输出: C1 (独立视角)
        │                      │                  │
        └──────────────────────┼──────────────────┘
                               ▼
阶段二：交叉评议与对冲 (Round 2)
┌────────────────────────────────────────────────────────┐
│            全量 Baseline 快照 (A1 + B1 + C1)            │
└───────┬──────────────────────┬──────────────────┬──────┘
        ▼                      ▼                  ▼
   [Model A]              [Model B]          [Model C]
   输出: A2 (互审修正)     输出: B2 (互审修正)  输出: C2 (互审修正)
                               │
                               ▼
阶段三：综合收口 (Final Round)
┌────────────────────────────────────────────────────────┐
│          基于全量 6 条充分碰撞发言合成最终回复           │
└────────────────────────────────────────────────────────┘
```

- **Round 1（盲测发散）**：所有模型互不可见，禁止注入 Transcript。每个模型基于自身专长独立产出初始观点。
- **Round 2（对撞互检）**：所有模型获取第 1 轮全量独立观点，进行真正的同行评审（Peer Review），指出盲点并修正错误。
- **Final Turn（终稿合成）**：基于经历过独立发散与批判对冲的真实共识成文。

> ⚠️ 关于「对称性」的准确表述：本方案达成的是**信息层面对称**（Round 1 互不可见）。prompt 层面存在一处无法消除的残留不对称（Model A 收裸问题、B/C 收 wrapper），详见第 5 节「已知限制」。

---

## 4. 核心落地代码方案（Minimal & Low-Risk）

> **改动范围**：仅需修改 1 个文件（`use-chat-discussion.ts`），零数据库迁移，零后端 API 变动，完全兼容现有断线重连、计费预留与面板渲染。三个 prompt 构建函数（`buildDiscussionTranscript` / `buildDiscussionParticipantPrompt` / `buildDiscussionFinalPrompt`）均无外部消费方、无单测锁定，改动不产生连带影响。

### 4.1 目标文件

`frontend/features/chat/hooks/use-chat-discussion.ts`

### 4.2 代码变更详情

#### 变更点 A：改写独立作答 Prompt（`buildDiscussionParticipantPrompt`）

> ⚠️ **关键约束：`!transcript` 分支是双用途的**，新文案必须同时服务两个场景：
>
> | 场景 | 触发条件 | 出现频率 |
> | --- | --- | --- |
> | (a) Round 1 盲测 | 变更点 B 实施后，`turn.round === 1` 恒走此分支 | 主场景 |
> | (b) Round 2+ 前序全失败 | 兜底路径：某轮所有前序 participant 均 error/stopped，`buildDiscussionTranscript` 返回空串 | 低频但真实存在 |
>
> 因此新文案必须满足三点：
> 1. 对场景 (a) 给出明确的独立分析指令，且**不预设轮次为第 1 轮**（避免场景 (b) 下出现 "round 3 … this is the independent first round" 的自相矛盾）；
> 2. **保留防幻觉指令** "do not infer anything from failed or empty turns"——场景 (b) 中模型必须知道存在失败发言、但不得从中推断内容；
> 3. 不使用 "INDEPENDENT ANALYSIS phase" 这类排他性阶段命名（在场景 (b) 下与轮次号冲突）。

```diff
 export function buildDiscussionParticipantPrompt(params: {
   modelName: string;
   round: number;
   userPrompt: string;
   transcript: string;
 }): string {
   const { modelName, round, userPrompt, transcript } = params;
   if (!transcript) {
     return (
       `You are ${modelName}, one participant in round ${round} of a multi-model discussion.\n` +
-      "No previous successful viewpoints are available yet. Continue from the user's question directly, " +
-      "and do not infer anything from failed or empty turns.\n\n" +
+      "This is the independent opening stage — no other viewpoints are available yet. " +
+      "Provide your own analysis directly from the user's question, without assuming " +
+      "what other models might say. Do not infer anything from failed or empty turns.\n\n" +
       `User question:\n${userPrompt}`
     );
   }
   return (
     `You are ${modelName}, one participant in round ${round} of a multi-model discussion.\n` +
     "Read the previous viewpoints, then add missing points, correct mistakes, or challenge weak reasoning. Do not repeat what is already sufficient.\n" +
     "The transcript below includes only successful turns; failed or empty turns are omitted and must not be treated as evidence.\n\n" +
     `User question:\n${userPrompt}\n\n` +
     `Previous discussion:\n${transcript}`
   );
 }
```

#### 变更点 B：在编排循环中切断第 1 轮的 Transcript 传递（`sendWithDiscussion`）

强制在第 1 轮中传入空字符串作为 Transcript：

```diff
       for (const turn of turns.slice(1)) {
         if (runtime.abortRequested) {
           markRemainingStopped();
           runtime.phase = "stopped";
           bump();
           return true;
         }
         if (turn.role === "final") {
           runtime.phase = "summarizing";
           bump();
           await runFinalWithFallback(turn);
         } else {
+          // 第 1 轮为盲测隔离期，禁止给模型传递前序发言，消除首模型锚定效应；
+          // 第 2 轮起注入全量历史纪要进行辩论与纠偏。前序全失败的兜底场景
+          // （transcript 为空串）由 buildDiscussionParticipantPrompt 的
+          // !transcript 分支承接，语义见变更点 A 的双用途约束。
+          const transcript = turn.round === 1 ? "" : buildDiscussionTranscript(turns);
+
           await runTurn(
             turn,
             buildDiscussionParticipantPrompt({
               modelName: turn.model,
               round: turn.round,
               userPrompt: content,
-              transcript: buildDiscussionTranscript(turns),
+              transcript,
             }),
           );
         }
       }
```

### 4.3 改动不影响的部分（确认清单）

| 机制 | 为何不受影响 |
| --- | --- |
| 后端生成上下文 | 讨论 prompt 经 `discussionMeta` 通道原样进生成上下文（后端 reuseUserMessage 分支对带 meta 的请求不回填原用户消息），改的只是纯前端拼接内容 |
| 终稿合成 | `runFinalWithFallback`（L351）独立调用 `buildDiscussionTranscript(turns)` 取全量，仍包含第 1 轮独立发言 + 第 2 轮互审发言 |
| 断线重连 | 每 turn 独立 run，重连按 run 回放，与 prompt 内容无关 |
| 计费预留 | 每 turn 独立预留，prompt 变短只会略微省 token |
| 面板渲染 | `DiscussionPanel` 从消息树 + `discussion_meta_json` 推导，不消费 transcript 字符串 |
| 刷新恢复 | 改动只影响新发出的讨论，已落库历史讨论凭 meta 重建，不受影响 |
| 失败过滤 | `buildDiscussionTranscript` 仅收录 completed 发言；Round 1 某模型失败不影响后续轮 transcript 正确性 |

---

## 5. 已知限制（架构硬约束，方案内无法消除）

**Round 1 的 prompt 不同构：Model A 收裸问题，B、C 收 wrapper prompt。**

- **成因**：首条 turn 走 default 分支建立 user 消息锚点（L403-L407），该分支的 `content` 会**落库为用户消息并渲染为用户气泡**——若换成讨论 wrapper，用户气泡将显示一段系统指令。此为硬约束，无解。
- **表现**：Model A 不知道自己在多模型讨论中（收到原始问题）；B、C 知道（收到 wrapper，被告知独立作答）。
- **影响评估**：有限。两侧均无锚定输入（A 天然独立；B、C 被明确要求独立），达成了盲测的核心目标。差异仅在于 B、C 的发言可能带「作为独立分析参与者」式的元话语，A 不会。
- **验证提示**：冒烟测试对照三个 Round 1 payload 时，Turn 1 无 wrapper、Turn 2/3 有 wrapper 是**预期行为**，不要误判为 bug。

---

## 6. 进阶增强方案（可选实施）

### 6.1 方案 A：轮次快照对称评议（Epoch Snapshot）

**解决痛点**：第 2 轮中，若 Model A 先发言，Model B 仍能看到 A 的第 2 轮新发言——第 2 轮内部不对称。此方案让第 N 轮所有模型**仅审阅第 N-1 轮及以前的确定快照**。

**⚠️ 明确权衡（不是免费收益）**：实施后**第 2 轮发言之间永久互相不可见**（B2 永远看不到 A2），所有交叉对撞延迟到终稿——互审密度实质性下降，换来的是轮内绝对对称。以「评审独立性」换「对撞充分性」，需在终稿发散质量上实测比对后再决定是否保留。

**实现方式**：为 `buildDiscussionTranscript` 增加 `maxRound` 过滤参数（不传 filter 时与现有行为完全等价，`runFinalWithFallback` 的全量调用不受影响）：

```ts
export function buildDiscussionTranscript(
  turns: DiscussionTurn[],
  filter?: { maxRound?: number },
): string {
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.role !== "participant" || turn.status !== "completed" || !turn.text.trim()) {
      continue;
    }
    if (filter?.maxRound !== undefined && turn.round > filter.maxRound) {
      continue;
    }
    lines.push(`Round ${turn.round}`);
    lines.push(`- ${turn.model}: ${turn.text.trim()}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}
```

调用时：

```ts
// 第 N 轮只审阅第 N-1 轮及以前的确定快照
const transcript = turn.round === 1
  ? ""
  : buildDiscussionTranscript(turns, { maxRound: turn.round - 1 });
```

### 6.2 方案 B：去权威化匿名盲审（Anonymized Blind Review）

**解决痛点**：消除模型对头部商业大模型（如 GPT-4o、Claude-3.5）的「品牌畏惧与盲从」。

**实现方式**：生成 transcript 时用位次代号替换模型名。**必须用 `participants.indexOf` 取位次**，不要用 `turn.index % participants.length`——后者依赖 index 按 `round × n + 位次` 递增的隐式规律才能保证同一模型跨轮代号稳定，属于巧合式正确，未来任何人改动 index 生成逻辑就会悄悄错乱：

```ts
export function buildDiscussionTranscript(
  turns: DiscussionTurn[],
  participants: string[],
): string {
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.role !== "participant" || turn.status !== "completed" || !turn.text.trim()) {
      continue;
    }
    const seat = participants.indexOf(turn.model);
    lines.push(`Round ${turn.round}`);
    lines.push(`- Participant ${seat >= 0 ? seat + 1 : turn.index}: ${turn.text.trim()}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}
```

**⚠️ 实施前需显式决策的两个连带影响**：

1. **终稿同步匿名**：`buildDiscussionFinalPrompt` 消费同一 transcript，终稿 prompt 里的模型名也全变 "Participant N"——终稿无法问责式引用（「GPT-4o 指出的并发风险」退化为「Participant 2 指出……」）。若要保留终稿的可问责性，需给 `buildDiscussionTranscript` 加匿名开关，仅 participant prompt 匿名、final prompt 用真名。
2. **自我身份仍暴露**：`You are ${modelName}` 会告诉模型自己是谁——自己有名、他人匿名的不对称。完全匿名需同步改写 wrapper 开头，但会让模型失去「以自身专长切入」的定位信号，得不偿失，建议保留。

UI 面板不受任何影响（从消息树 + meta 推导，不消费 transcript）。

---

## 7. 测试与验证计划

### 7.1 本地验证流程（3 模型 · 2 轮）

1. 启动本地环境，开启多模型讨论（选择 3 个模型，设为 2 轮）。
2. 发送具有主观分歧的技术选型问题（如：「Go 与 Rust 在高性能微服务选型上的利弊对比」）。
3. **Round 1 盲测断言（负向）**：
   - 观察 Turn 2、Turn 3 发往后端的 HTTP 请求 Payload 中的 `content` 字段。
   - **断言**：Payload 只含 wrapper 指令与用户原始问题，**不得出现** Turn 1 的输出文本。
   - 注意：Turn 1（首条 default 分支）无 wrapper 是预期行为，见第 5 节已知限制。
4. **Round 2 互审断言（正向）**：
   - 观察 Turn 4（第 2 轮首个发言）的 Payload。
   - **断言**：Payload **必须完整包含** Round 1 全部 3 个模型的独立发言文本——只验「没有」不验「有」无法证明盲测→互审链路正确接通。
5. **UI 与历史回放验证**：
   - 页面刷新后，检查讨论面板 `DiscussionPanel` 的「按模型」与「全部轮次」视图，确认各卡片正常呈现、无数据断裂。
   - 终稿内容应综合多个 Round 1 独立视角（而非仅复述首个模型）。

### 7.2 兜底场景（代码审查代替手测）

「Round 2+ 前序全失败」的兜底路径难以手工稳定构造（需某轮全部模型故障），以代码审查确认：`!transcript` 分支文案对任意 `round` 值均无语义矛盾（见变更点 A 的双用途约束）。

---

## 8. 待办任务清单 (Action Items)

- [ ] **Task 1**：修改 `frontend/features/chat/hooks/use-chat-discussion.ts` 中的 `buildDiscussionParticipantPrompt`，按第 4.2 节变更点 A 的新文案落地（注意双用途约束：不预设第 1 轮、保留防幻觉指令）。
- [ ] **Task 2**：修改同文件 `sendWithDiscussion` 循环，`turn.round === 1` 时 `transcript = ""`（变更点 B）。
- [ ] **Task 3**：3 模型 2 轮端到端冒烟测试——含 Round 1 负向断言（无前序文本污染）**与 Round 2 正向断言**（含全部 3 条独立发言），及刷新后面板回放检查。
- [ ] **Task 4**（可选）：实施方案 A（`maxRound` 轮次快照），A/B 对比终稿发散质量后再决定是否保留；接受「第 2 轮发言互不可见、对撞延迟到终稿」的权衡。
- [ ] **Task 5**（可选）：实施方案 B（匿名盲审）——用 `participants.indexOf` 实现代号；先对「终稿是否同步匿名」做出显式决策。

---

## 9. 方案可行性审视与架构优化建议 (Architecture Review)

本节记录对上述 1~8 节方案的可行性、理论假设、潜在副作用与工程细节的全面审视结论与修订建议。

### 9.1 核心认知纠偏：第 5 节“架构硬约束”实为伪约束

- **现状审视**：方案第 5 节将「Model A 接收裸问题，B/C 接收 wrapper prompt」定性为“无法消除的架构硬约束”，理由是首条发言走 `default` 分支落库为用户气泡，不能带系统指令。
- **纠偏分析**：
  - Turn 2 和 Turn 3 是 `retry` 分支复用用户气泡（`reuseUserMessage: true`），发往后端的 `content` 仅作为生成上下文的 prompt，**不会落库为新的用户消息气泡**。
  - 既然第 1 轮的目标是**纯粹、独立、原生的盲测**，Turn 2 和 Turn 3 在第 1 轮完全可以直接传入原始 `content`（即 `await runTurn(turn, content)`）。
  - 给 B/C 强加 wrapper 会产生三个严重的负面问题：
    1. **语言漂移（Language Drift）**：用户用中文提问，Model A 收到中文自然作答；Model B/C 收到一大段英文 instructions，极易引发英文作答或中英夹杂。
    2. **元话语污染（Meta-Talk）**：B/C 容易在开头生成「作为参与者 B，在独立分析阶段我的看法如下……」等无关角色扮演废话，而 A 的输出格式正常规范。
    3. **非对称输入**：A 完全无感知，B/C 知道处于讨论阶段，违背了“全对称盲测”的初衷。
- **优化建议**：在编排循环中，**第 1 轮（`turn.round === 1`）所有参与者统一直接传入原始 `content`**。仅需 2 行分支判断，即可达成 100% 绝对同构的真盲测，彻底消除第 5 节的“硬约束”。

### 9.2 文案自相矛盾：变更点 A 原则与 Diff 代码冲突

- **现状审视**：
  - 变更点 A 的文字说明明确强调了约束 3：*「不使用 "INDEPENDENT ANALYSIS phase" 这类排他性阶段命名（在场景 (b) 下与轮次号冲突）」*。
  - 但紧随其后的 Diff 代码第 143 行却写入了：`"This is the independent opening stage — no other viewpoints are available yet."`
- **缺陷表现**：
  - 一旦触发场景 (b)（即 Round 2 或 Round 3 所有前序模型均失败），模型将收到：
    `You are Model X, one participant in round 2 ... This is the independent opening stage ...`
    在后续轮次中宣称这是“独立开局阶段”，直接导致 Prompt 语义破裂与自相矛盾。
- **优化建议**：若采纳 9.1（第 1 轮直接全走裸 `content`），则 `!transcript` 分支将只在“后续轮次前序全部失败”的极端兜底场景下触发，文案应纯粹保持客观陈述，例如：
  `"No previous viewpoints are available for reference. Provide your analysis directly from the user's question, and do not infer anything from failed or empty turns."`

### 9.3 架构吞吐与耗时痛点：Round 1 盲测依然是完全串行的

- **现状审视**：第 3 节架构图将 Round 1 表现为同时向下发散的并行处理，但代码实际依旧是 `for (const turn of turns.slice(1)) await runTurn(...)` 逐个等待。
- **痛点分析**：
  - 既然第 1 轮模型互不可见、毫无依赖，让用户无意义地等待 $N$ 个模型依次串行（例如 5 个模型需等待超 1 分钟）是非常大的体验损耗。
  - **保留串行的真正硬约束**：当前 `useChatDiscussion` 的中止机制依赖单一权威 `runningTurn`（`stopDiscussion` 会找单条 `status === "running"` 的 turn 发起取消 `cancelRun(runningTurn.clientRunID)`）；若并行触发多个 run，当前的中止和运行态管理需要较大幅度重构。
- **结论与建议**：若保持“Minimal & Low-Risk”采用串行，方案应在“已知限制”中**显式披露串行盲测的耗时代价**，避免形成“已具备并发 fan-out 性能”的误解。

### 9.4 序列特权转移：Round 2 内部依然存在单向信息泄露

- **现状审视**：方案把重点放在第 1 轮的去锚定，却把第 2 轮的轮内隔离视作“可选方案 A”。
- **缺陷分析**：
  - 在目前的落地代码中：
    - Turn 4 (Model A, Round 2) 审阅：`[A1, B1, C1]`
    - Turn 5 (Model B, Round 2) 审阅：`[A1, B1, C1, A2]`（⚠️ B2 提前看到了 A2）
    - Turn 6 (Model C, Round 2) 审阅：`[A1, B1, C1, A2, B2]`（⚠️ C2 提前看到了 A2, B2）
  - 第 1 轮消除的“序列特权”在第 2 轮原样上演：Model A 率先奠定批评与修补基调，B 和 C 依旧受制于 A2 的框架（Sycophancy / 框架锚定）。
  - B2 看到 A2、而 A2 看不到 B2 并不是对撞，而是**单向信息泄露**。
- **优化建议**：`maxRound: turn.round - 1`（轮次快照 Epoch Snapshot）实现极轻（仅需几行代码过滤），应直接作为**核心方案的默认标配**，而非可选方案。

### 9.5 进阶方案 B（匿名盲审）的现实逻辑与模型认知漏洞

- **自我审判困境（Self-Critique Dilemma）**：
  在第 2 轮中，Model A 收到匿名后的 `Participant 1`（实际是 A 自己）、`Participant 2` 等观点，并被指示“批评弱逻辑、纠正错误”。此时 Model A 不知道谁是自己，很可能反驳自己上一轮的论述，导致论证逻辑人格分裂。学术盲审机制中必须标记 `Participant 1 (Your previous analysis)`，不能完全对自身屏蔽。
- **模型自报家门（Self-identification）**：
  很多主流商业大模型在输出时天然带有限定词（如“作为 Anthropic 研发的助手……”），单纯替换 Transcript 中的名字无法做到真正盲审。
- **重复选用模型导致序号重叠**：
  `participants.indexOf(turn.model)` 在未来若支持同模型多个实例时，会永远返回首个索引。

### 9.6 工程健壮性：Prompt 缺少边界隔离符与 Token 预算保护

1. **边界隔离符缺失**：
   在 `buildDiscussionParticipantPrompt` 中，用户的原始问题 `${userPrompt}` 与历史讨论 `${transcript}` 仅用换行分隔。若用户的提问本身包含 Markdown 标题、代码块或引用，容易与 Prompt 下方的系统提示产生上下文混淆。建议使用 `<user_question>` 或 Markdown 引用块明确包裹边界。
2. **Token 膨胀与上下文超限**：
   多模型多轮讨论下，累积 Transcript 会迅速膨胀到上万 Tokens。方案缺乏字符/Token 截断机制，容易撑爆小上下文模型的 Context Window。

### 9.7 测试策略：从手工抓包转向自动化纯函数单测

- **现状审视**：方案完全依赖人工开启本地环境、配置 3 个模型，在浏览器 Network 面板抓包检查 Payload。
- **改进建议**：`buildDiscussionTranscript` 与 `buildDiscussionParticipantPrompt` 是没有任何外部副作用的**纯函数（Pure Functions）**。应直接补充针对性的 Vitest 单元测试，秒级验证：
  - Round 1 时 Transcript 为空；
  - Round 2 时正确捕获 Round 1 且过滤 Round 2 增量；
  - 遇到 `stopped`/`error` 发言时过滤正确；
  - 极端全空情况下的文案兜底。

---

### 9.8 推荐的整合落地方案代码 (Refined Solution)

综合上述审视，对 `frontend/features/chat/hooks/use-chat-discussion.ts` 的最简且完备的修改建议如下：

```ts
// 1. buildDiscussionTranscript 支持 maxRound 轮次快照（消除第 2 轮内部级联）
export function buildDiscussionTranscript(
  turns: DiscussionTurn[],
  filter?: { maxRound?: number },
): string {
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.role !== "participant" || turn.status !== "completed" || !turn.text.trim()) {
      continue;
    }
    if (filter?.maxRound !== undefined && turn.round > filter.maxRound) {
      continue;
    }
    lines.push(`Round ${turn.round}`);
    lines.push(`- ${turn.model}: ${turn.text.trim()}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

// 2. buildDiscussionParticipantPrompt 仅负责 Round 2+ 互审与全空兜底
export function buildDiscussionParticipantPrompt(params: {
  modelName: string;
  round: number;
  userPrompt: string;
  transcript: string;
}): string {
  const { modelName, round, userPrompt, transcript } = params;
  if (!transcript) {
    return (
      `You are ${modelName}, one participant in round ${round} of a multi-model discussion.\n` +
      "No previous successful viewpoints are available yet. Answer directly from the user's question, " +
      "and do not infer anything from failed or empty turns.\n\n" +
      `User question:\n${userPrompt}`
    );
  }
  return (
    `You are ${modelName}, one participant in round ${round} of a multi-model discussion.\n` +
    "Read the previous viewpoints, then add missing points, correct mistakes, or challenge weak reasoning. Do not repeat what is already sufficient.\n" +
    "The transcript below includes only successful turns; failed or empty turns are omitted and must not be treated as evidence.\n\n" +
    `User question:\n${userPrompt}\n\n` +
    `Previous discussion:\n${transcript}`
  );
}

// 3. sendWithDiscussion 编排循环：
// - Round 1：所有人均传裸 content（消除不对称与伪硬约束）
// - Round 2+：审阅截至上一轮的确定快照（消除第 2 轮内部锚定）
for (const turn of turns.slice(1)) {
  if (runtime.abortRequested) {
    markRemainingStopped();
    runtime.phase = "stopped";
    bump();
    return true;
  }
  if (turn.role === "final") {
    runtime.phase = "summarizing";
    bump();
    await runFinalWithFallback(turn);
  } else if (turn.round === 1) {
    // 💡 关键：第 1 轮全员透传原始问题，零元话语污染、零语言漂移，100% 独立同构
    await runTurn(turn, content);
  } else {
    // 💡 关键：第 2 轮及以后只审阅第 N-1 轮快照，消除轮内序列偏见
    const transcript = buildDiscussionTranscript(turns, { maxRound: turn.round - 1 });
    await runTurn(
      turn,
      buildDiscussionParticipantPrompt({
        modelName: turn.model,
        round: turn.round,
        userPrompt: content,
        transcript,
      }),
    );
  }
}
```

