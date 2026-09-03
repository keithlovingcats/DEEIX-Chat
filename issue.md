# 代码审查报告：多模型组合支持模型级启用/禁用功能审查

## 审查目标

* **目标提交**: `5bfa9a34d01aa2424d7f72b644eed07d97f27fdb`
* **提交信息**: `feat: 多模型组合支持模型级启用/禁用，禁用者退出对话但保留组合`
* **涉及核心文件**:
  * [`frontend/features/chat/hooks/use-chat-model-options.ts`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/hooks/use-chat-model-options.ts)
  * [`frontend/features/chat/hooks/use-chat-message-submit.ts`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/hooks/use-chat-message-submit.ts)
  * [`frontend/features/chat/hooks/use-chat-discussion.ts`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/hooks/use-chat-discussion.ts)
  * [`frontend/features/chat/components/sections/conversation-parallel-models-bar.tsx`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/components/sections/conversation-parallel-models-bar.tsx)
  * [`frontend/features/chat/components/app-chat-area.tsx`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/components/app-chat-area.tsx)

---

## 审查结论综述

本次提交的整体架构与核心发送链路设计良好：实现了主模型防禁用、常规 Fan-out 并行发送排除禁用模型、入队快照隔离以及移除主模型时首个附加模型的自动提升解禁。

然而，在 **多模型讨论持久化**、**会话切换状态重置** 以及 **顶栏 UI 计数与门槛联动** 3 个方面存在缺陷，导致提交信息中所承诺的 *“会话组合持久化保留全量（禁用≠删除），刷新/切换会话后恢复全启用”* 未能完全正确工作。

---

## 缺陷详述与分析

### 1. 【严重 Bug】多模型讨论执行时会意外擦除禁用模型的持久化组合

* **问题严重度**: 高 (导致用户数据/会话状态非预期丢失)
* **影响场景**: 多模型组合（≥3 个模型）且包含已禁用模型时，开启多模型讨论并发送消息。
* **现象描述**:
  例如组合为 `[Model A, Model B, Model C]`，用户将 `Model C` 禁用。开启讨论并发送，`Model A` 与 `Model B` 正常开展辩论。但当首轮生成完毕并执行会话 patch 时，**`Model C` 被从会话的多模型持久化组合中永久剔除**。刷新页面或重新进入该会话后，组合缩减为仅有 `[Model A, Model B]`。
* **原因分析**:
  1. 在 [`frontend/features/chat/hooks/use-chat-discussion.ts`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/hooks/use-chat-discussion.ts#L289-L291) 中：
     ```ts
     // 首条 default 请求会把 parallelModels 持久化到会话；显式传完整参与者
     // 组合，避免默认的单元素组合在刷新后重置用户的多模型选择。
     persistParallelModels: isFirstTurn ? participants : undefined,
     ```
     这里的 `participants` 是通过入参传入的讨论参与者列表，由于禁用了 `Model C`，`participants` 仅为 `[Model A, Model B]`。
  2. 在 [`frontend/features/chat/hooks/use-chat-message-submit.ts`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/hooks/use-chat-message-submit.ts#L629-L637) 中：
     ```ts
     const requestedParallelModels =
       !programmaticFanOut && plan.branchReason === "default"
         ? persistParallelModels ?? [
             platformModelName,
             ...parallelPlatformModelNamesRef.current.filter(
               (name) => name.trim() && name.trim() !== platformModelName,
             ),
           ]
         : undefined;
     ```
     由于讨论显式传入了 `persistParallelModels`（仅包含启用的参与者 `[Model A, Model B]`），空值合并操作符 `??` 优先取了左侧的残缺列表，原本在右侧能保留全量（含禁用模型）的 `parallelPlatformModelNamesRef.current` 被完全跳过。
  3. 最终在提交结束时，通过 `parallelModels: requestedParallelModels` 将不含 `Model C` 的列表提交至后端并更新本地会话缓存（[`use-chat-message-submit.ts:L814`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/hooks/use-chat-message-submit.ts#L814)），违反了“禁用≠删除”的设计约定。
* **修复建议**:
  [`use-chat-discussion.ts`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/hooks/use-chat-discussion.ts#L291) 首轮无需显式传入只含参与者的 `persistParallelModels`（直接依赖 `submitMessage` 内部基于 `parallelPlatformModelNamesRef.current` 计算的全量模型组合），或者传入完整组合。

---

### 2. 【逻辑缺陷】切换会话 / 新建会话时，禁用状态跨会话泄漏，未恢复全启用

* **问题严重度**: 中 (状态污染)
* **影响场景**: 在一个会话中禁用了某模型后，切换至其他包含该模型的会话或新建会话。
* **现象描述**:
  用户在会话 1 中将模型 `gpt-4o` 禁用。随后通过左侧侧边栏切换到会话 2（会话 2 原本组合同样包含 `gpt-4o`）。切换后，会话 2 中的 `gpt-4o` **依然处于禁用状态**。
* **原因分析**:
  1. 在 [`frontend/features/chat/hooks/use-chat-model-options.ts`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/hooks/use-chat-model-options.ts#L558-L570) 中：
     ```ts
     // 禁用集合收缩：组合变化（恢复服务端组合/移除模型）后清掉不在组合内的名字；
     // 会话切换恢复的组合默认全启用。
     React.useEffect(() => {
       const inCombo = new Set([selectedPlatformModelName, ...additionalPlatformModelNames]);
       setDisabledPlatformModelNames((current) => {
         const next = current.filter((name) => inCombo.has(name));
         if (next.length === current.length) {
           return current;
         }
         disabledModelNamesRef.current = next;
         return next;
       });
     }, [selectedPlatformModelName, additionalPlatformModelNames]);
     ```
     注释写道“会话切换恢复的组合默认全启用”，但实际逻辑仅做了集合存在性收缩过滤（`inCombo.has(name)`）。如果目标会话同样包含该模型名称，该模型不会被移出禁用列表。
  2. 切换会话的主入口 [`use-chat-model-options.ts:L710`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/hooks/use-chat-model-options.ts#L710)（`if (conversationChanged)`）以及新建会话触发点（`resetToken` effect，第 664 行）均未清空 `disabledPlatformModelNames`。
* **修复建议**:
  在 `conversationChanged` 分支和 `resetToken` effect 中显式调用：
  ```ts
  setDisabledPlatformModelNames([]);
  disabledModelNamesRef.current = [];
  ```

---

### 3. 【交互与展示 Bug】顶栏工具栏讨论调用预估次数偏高，且门槛未联动禁用态

* **问题严重度**: 低 (用户体验与界面指示不一致)
* **影响场景**: 在顶栏开启多模型讨论或附加模型部分/全部禁用时。
* **现象描述**:
  1. **预估次数虚高**: 组合 3 个模型，禁用 1 个，设置 2 轮讨论。实际只有 2 个模型参与讨论（`2 × 2 + 1 = 5` 次调用），但顶栏 pill 与 hover 提示均显示为 `7 次调用`。
  2. **开关门槛假开启**: 组合 2 个模型（主模型 + 1 个附加模型），将附加模型禁用。此时可用模型仅有 1 个，无法构成讨论。但顶栏的讨论 Switch 依然允许开启，并显示预估调用；点击发送后，由于底层的 [`app-chat-area.tsx:L297`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/components/app-chat-area.tsx#L297) 要求 `activePlatformModelNames.length >= 2`，消息静默降级为单模型普通发送，讨论根本未执行。
* **原因分析**:
  1. [`conversation-parallel-models-bar.tsx:L99-L100`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/components/sections/conversation-parallel-models-bar.tsx#L99-L100) 计算调用次数时使用的是全量 `selectedNames.length`，未过滤禁用模型：
     ```ts
     const discussionCallCount =
       Math.min(selectedNames.length, MAX_DISCUSSION_MODELS) * (discussionRounds ?? DEFAULT_DISCUSSION_ROUNDS) + 1;
     ```
  2. 第 183 行以 `{selectedNames.length >= 2 && onToggleDiscussion ? (` 作为展示门槛，而不是依据实际启用的模型数量。
* **修复建议**:
  1. 使用启用模型数计算：
     ```ts
     const activeNames = React.useMemo(
       () => selectedNames.filter((name) => !disabledNames.has(name)),
       [selectedNames, disabledNames],
     );
     const discussionCallCount =
       Math.min(activeNames.length, MAX_DISCUSSION_MODELS) * (discussionRounds ?? DEFAULT_DISCUSSION_ROUNDS) + 1;
     ```
  2. 讨论 Switch 增加禁用条件或提示，当 `activeNames.length < 2` 时禁用开关或展示门槛提示。

---

## 验证通过的功能点

* **并行 Fan-out 发送过滤**:
  [`use-chat-message-submit.ts:L1227-L1231`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/hooks/use-chat-message-submit.ts#L1227-L1231) 中准确根据禁用列表进行了过滤，禁用的模型不会发起 HTTP 流式请求，不会产生非预期调用与扣费。
* **提交队列快照一致性**:
  [`use-chat-message-submit.ts:L1097-L1106`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/hooks/use-chat-message-submit.ts#L1097-L1106) 在入队时快照排除了禁用模型，出队发送时不会唤醒已禁用模型。
* **主模型保护与状态联动**:
  * 主模型 Pill 上隐藏了禁用按钮，且 `toggleParallelModelEnabled` 拒绝主模型禁用。
  * 当移除主模型时，提升为主模型的首位附加模型自动从禁用集合中解禁（[`use-chat-model-options.ts:L504`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/hooks/use-chat-model-options.ts#L504)）。
  * 切换主模型单选或一键清空多模型时均正确清理了禁用集合。
* **UI 视觉与多语言规范**:
  * 禁用态采用虚线边框（`border-dashed border-border`）、背景透明度与文本变暗处理，视觉层级分明。
  * `zh-CN` 与 `en-US` 字典均已补齐相关 key。
* **伴随修复**:
  * [`use-chat-stop-message.ts:L132`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/features/chat/hooks/use-chat-stop-message.ts#L132) 正确补齐了 `onParallelRunsRemaining` 依赖。
  * [`streamdown-components.tsx:L534`](file:///Users/jun/Desktop/Codes/DEEIX-Chat/frontend/shared/components/markdown/streamdown-components.tsx#L534) 对未达折叠阈值的代码块排除了多余包装容器。
