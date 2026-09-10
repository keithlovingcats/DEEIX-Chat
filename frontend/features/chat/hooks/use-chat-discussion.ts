"use client";

import * as React from "react";

import type { PendingAttachment } from "@/features/chat/types/chat-runtime";
import type {
  DiscussionRole,
  MessageDiscussionMetaInput,SendMessageResult 
} from "@/shared/api/conversation.types";

/** 多模型讨论约束（与后端 dto 校验、模型多选上限 MAX_PARALLEL_MODELS 对齐）。 */
export const MAX_DISCUSSION_MODELS = 20;
export const MAX_DISCUSSION_ROUNDS = 5;
/** 最少 2 轮：1 轮只有盲测独立回答 + 终稿合成，无互审环节，不构成「讨论」。 */
export const MIN_DISCUSSION_ROUNDS = 2;
export const DEFAULT_DISCUSSION_ROUNDS = 2;
/** 终稿容错的总尝试上限：候选最多 20 个、每人 2 次，最坏 ~40 次；
 * 上游整体故障时提前止损，避免长时间收不了尾。 */
const MAX_DISCUSSION_FINAL_ATTEMPTS = 5;

export type DiscussionTurnStatus = "pending" | "running" | "completed" | "error" | "stopped";
export type DiscussionPhase = "running" | "summarizing" | "completed" | "stopped" | "error";

export interface DiscussionTurn {
  model: string;
  round: number;
  role: DiscussionRole;
  index: number;
  status: DiscussionTurnStatus;
  clientRunID?: string;
  assistantPublicID?: string;
  text: string;
  errorMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMS?: number;
}

export interface DiscussionRuntime {
  discussionID: string;
  participants: string[];
  rounds: number;
  phase: DiscussionPhase;
  turns: DiscussionTurn[];
  abortRequested: boolean;
}

/** 讨论编排可用的 submitMessage 子集（由 useChatMessageSubmit 提供的扩展参数）。 */
type DiscussionSubmitMessage = (params: {
  content: string;
  currentAttachments: PendingAttachment[];
  resetComposer: boolean;
  parentMessagePublicID?: string | null;
  sourceMessagePublicID?: string | null;
  branchReason?: "default" | "retry" | "edit";
  programmaticFanOut?: boolean;
  overridePlatformModelName?: string;
  discussionMeta?: MessageDiscussionMetaInput;
  persistParallelModels?: string[];
  onAssistantCreated?: (anchor: { userPublicID: string; assistantPublicID: string; runID: string }) => void;
  onStreamSettled?: (result: { ok: boolean; aborted: boolean; clientRunID: string; completed?: SendMessageResult }) => void;
}) => Promise<boolean>;

function createDiscussionID(): string {
  const randomID =
    typeof window.crypto?.randomUUID === "function"
      ? window.crypto.randomUUID().replaceAll("-", "")
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `disc_${randomID}`.slice(0, 64);
}

function isTurnCompletedStatus(status: DiscussionTurnStatus): boolean {
  return status === "completed";
}

/**
 * transcript 只收录成功发言；失败发言是运营故障而非观点，不进入后续 prompt。
 * filter.maxRound 限定只收录该轮次及以前的发言（轮次快照）：第 N 轮发言只审阅
 * 第 N-1 轮及以前的确定内容，消除轮内序列特权（后发言者提前看到同轮先发言者
 * 的互审，单向信息泄露）。不传 filter 与全量行为完全等价（终稿合成用全量）。
 */
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

/**
 * transcript 与失败摘要只收录 participant 发言：终稿自身的多次尝试
 * （失败重试/换模型接替）是运营故障而非讨论观点，不进后续 prompt。
 */
export function buildDiscussionFailureSummary(turns: DiscussionTurn[]): string {
  return turns
    .filter((turn) => turn.role === "participant" && (turn.status === "error" || turn.status === "stopped"))
    .map((turn) => `- Round ${turn.round} - ${turn.model}: failed`)
    .join("\n")
    .trim();
}

/** 最新一条成功终稿；失败重试/换模型接替会留下多条同 index 的 final，不能取数组末尾。 */
export function findLatestCompletedFinalTurn(turns: DiscussionTurn[]): DiscussionTurn | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.role === "final" && turn.status === "completed") {
      return turn;
    }
  }
  return undefined;
}

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
      "No previous successful viewpoints are available yet. Continue from the user's question directly, " +
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

export function buildDiscussionFinalPrompt(
  userPrompt: string,
  transcript: string,
  failureSummary: string,
): string {
  const successfulContext = transcript || "No successful participant turns are available.";
  const failedContext = failureSummary || "No failed participant turns were reported.";
  return (
    "Several models were asked to discuss the user's question. Produce the final answer for the user.\n" +
    "Use only the successful discussion transcript as source material. Failed turns are operational failures, not viewpoints or evidence.\n" +
    "If failed turns are listed, briefly disclose that the final answer is based on the successful contributions only. " +
    "If no successful participant turns are available, answer directly from the user's question and state that the discussion could not be synthesized from participant viewpoints.\n\n" +
    `User question:\n${userPrompt}\n\n` +
    `Discussion transcript:\n${successfulContext}\n\n` +
    `Failed discussion turns (not evidence):\n${failedContext}`
  );
}

export interface DiscussionSendParams {
  content: string;
  currentAttachments: PendingAttachment[];
  parentMessagePublicID: string | null;
  participants: string[];
  rounds: number;
}

export type DiscussionSendFn = (params: DiscussionSendParams) => Promise<boolean>;

/**
 * useChatDiscussion 多模型讨论编排器。
 * 逐轮辩论、轮内并行：每个发言是一次独立的 submitMessage（独立 run/消息/计费），
 * 轮与轮之间 barrier 等待（快照固定），同轮发言并行 fan-out（信息结构上本就互不
 * 可见，并行只压缩墙钟时间）；讨论 prompt 拼进请求 content，后端对带
 * discussionMeta 的 reuse 分支以 content 覆盖链尾 user 文本送入生成上下文。
 * 第 1 轮全员盲测（裸原始问题，锚点 message_created 一到即 fan-out），第 2 轮
 * 起凭上一轮快照互审，终稿凭全量 transcript 合成。
 */
export function useChatDiscussion({
  submitMessage,
  cancelRun,
}: {
  submitMessage: DiscussionSubmitMessage;
  /** 按显式 runID 取消单个 run（讨论 turn 的 run 不是可见叶子，onStopMessage 取消不到）。 */
  cancelRun: (runID: string) => void;
}) {
  const runtimesRef = React.useRef<Map<string, DiscussionRuntime>>(new Map());
  const [revision, setRevision] = React.useState(0);
  const cancelRunRef = React.useRef(cancelRun);
  cancelRunRef.current = cancelRun;

  const bump = React.useCallback(() => {
    setRevision((current) => current + 1);
  }, []);

  /** 运行态权威相位表；渲染层优先取 runtime.phase，无 runtime（刷新恢复）才从消息推导。 */
  const getDiscussionRuntimes = React.useCallback(() => runtimesRef.current, []);

  /** 停止进行中的讨论：置中止标志并按 runID 显式取消全部进行中发言的 run
   *（轮内并行后同时存在多条 running，逐一取消）。 */
  const stopDiscussion = React.useCallback(() => {
    let stopped = false;
    for (const runtime of runtimesRef.current.values()) {
      if (runtime.phase !== "running" && runtime.phase !== "summarizing") {
        continue;
      }
      runtime.abortRequested = true;
      stopped = true;
      for (const turn of runtime.turns) {
        if (turn.status === "running" && turn.clientRunID) {
          cancelRunRef.current(turn.clientRunID);
        }
      }
    }
    if (stopped) {
      bump();
    }
    return stopped;
  }, [bump]);

  const sendWithDiscussion = React.useCallback(
    async ({
      content,
      currentAttachments,
      parentMessagePublicID,
      participants,
      rounds,
    }: {
      content: string;
      currentAttachments: PendingAttachment[];
      parentMessagePublicID: string | null;
      participants: string[];
      rounds: number;
    }): Promise<boolean> => {
      if (participants.length < 2 || participants.length > MAX_DISCUSSION_MODELS) {
        return false;
      }
      const discussionID = createDiscussionID();
      const boundedRounds = Math.max(MIN_DISCUSSION_ROUNDS, Math.min(rounds, MAX_DISCUSSION_ROUNDS));

      // 预排全部发言（参与者 × 轮次 + 终稿）：驱动逐轮执行、transcript 与中止标记；
      // 面板渲染从消息树推导，不直接消费这里的 pending 占位。
      const turns: DiscussionTurn[] = [];
      let index = 0;
      for (let round = 1; round <= boundedRounds; round += 1) {
        for (const model of participants) {
          index += 1;
          turns.push({
            model,
            round,
            role: "participant",
            index,
            status: "pending",
            text: "",
          });
        }
      }
      index += 1;
      turns.push({
        model: participants[0],
        round: boundedRounds + 1,
        role: "final",
        index,
        status: "pending",
        text: "",
      });

      const runtime: DiscussionRuntime = {
        discussionID,
        participants,
        rounds: boundedRounds,
        phase: "running",
        turns,
        abortRequested: false,
      };
      runtimesRef.current.set(discussionID, runtime);
      bump();

      const anchor = { userPublicID: "", assistantPublicID: "" };
      // 锚点就绪信号：Turn 1 的 message_created（消息落库即发）携带 user/assistant
      // publicID，后续发言只依赖锚点而非 Turn 1 生成完成，据此可提前并行 fan-out。
      let signalAnchorReady!: () => void;
      const anchorReady = new Promise<void>((resolve) => {
        signalAnchorReady = resolve;
      });

      const runTurn = async (turn: DiscussionTurn, prompt: string) => {
        if (runtime.abortRequested) {
          turn.status = "stopped";
          bump();
          return false;
        }
        turn.status = "running";
        bump();
        const meta: MessageDiscussionMetaInput = {
          discussionID,
          round: turn.round,
          role: turn.role,
          index: turn.index,
          participants,
          rounds: boundedRounds,
        };
        const isFirstTurn = !anchor.assistantPublicID;
        const ok = await submitMessage({
          content: prompt,
          currentAttachments,
          resetComposer: isFirstTurn,
          parentMessagePublicID: isFirstTurn ? parentMessagePublicID : anchor.userPublicID,
          sourceMessagePublicID: isFirstTurn ? undefined : anchor.assistantPublicID,
          branchReason: isFirstTurn ? "default" : "retry",
          programmaticFanOut: !isFirstTurn,
          // 首条 default 请求会把 parallelModels 持久化到会话。不显式传参与者组合：
          // submitMessage 内部会按全量选中组合（含被禁用的附加模型）持久化，
          // 禁用是会话内临时退出而非从组合删除；显式传 participants 会把禁用
          // 模型从持久化组合中擦除（participants 仅含启用的发言者）。
          overridePlatformModelName: turn.model,
          discussionMeta: meta,
          onAssistantCreated: (created) => {
            turn.assistantPublicID = created.assistantPublicID;
            turn.clientRunID = created.runID;
            if (runtime.abortRequested) {
              cancelRunRef.current(created.runID);
            }
            if (!anchor.userPublicID) {
              anchor.userPublicID = created.userPublicID;
            }
            if (!anchor.assistantPublicID) {
              anchor.assistantPublicID = created.assistantPublicID;
              signalAnchorReady();
            }
            bump();
          },
          onStreamSettled: (result) => {
            if (result.ok && result.completed) {
              const assistant = result.completed.assistantMessage;
              turn.text = assistant.content ?? "";
              const succeeded = (assistant.status || "success") === "success";
              turn.status = succeeded ? "completed" : "error";
              turn.errorMessage = succeeded
                ? undefined
                : assistant.errorMessage?.trim() || "generation failed";
              turn.inputTokens = assistant.inputTokens;
              turn.outputTokens = assistant.outputTokens;
              turn.latencyMS = assistant.latencyMS;
            } else {
              turn.status = result.aborted ? "stopped" : "error";
              turn.errorMessage = result.aborted ? undefined : "generation failed";
            }
            bump();
          },
        });
        // 守卫拒绝路径不会触发 onStreamSettled，用返回值兜底收口。
        if (!ok && turn.status === "running") {
          turn.status = "error";
          turn.errorMessage = "submission rejected";
          bump();
        }
        // 回调里的赋值不参与控制流分析，经谓词函数比较避免窄化误报。
        return isTurnCompletedStatus(turn.status);
      };

      const markRemainingStopped = () => {
        for (const turn of turns) {
          if (turn.status === "pending" || turn.status === "running") {
            turn.status = "stopped";
          }
        }
      };

      // 终稿容错：总结模型失败先同模型重试一次，仍失败则按参与顺序换
      // 「本次讨论中有成功发言」的参与者接替（每个候选同样一次重试机会），
      // 全部候选耗尽或达到总尝试上限（MAX_DISCUSSION_FINAL_ATTEMPTS）才判
      // error——终稿是整场讨论的价值收口，不因单个模型不可用而作废。
      // 失败尝试作为独立 turn 保留在 turns 中（讨论面板可见红色卡片），
      // 替补发言复用同一 index：同一发言槽位的再次尝试，面板排序与后端
      // 校验均不受影响。
      const runFinalWithFallback = async (finalTurn: DiscussionTurn): Promise<void> => {
        const transcript = buildDiscussionTranscript(turns);
        const successfulModels = new Set(
          turns
            .filter((item) => item.role === "participant" && item.status === "completed")
            .map((item) => item.model),
        );
        const candidates = [
          finalTurn.model,
          ...participants.filter((model) => model !== finalTurn.model && successfulModels.has(model)),
        ];

        let attempts = 0;
        let current = finalTurn;
        for (const candidate of candidates) {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            if (attempts >= MAX_DISCUSSION_FINAL_ATTEMPTS) {
              // 未开跑的占位不能留 pending，否则收尾会把整场讨论误判为 error/stopped 含糊态。
              if (current.status === "pending") {
                current.status = "error";
                current.errorMessage = "final attempt limit reached";
              }
              return;
            }
            attempts += 1;
            if (attempt > 0 || candidate !== finalTurn.model) {
              current = {
                model: candidate,
                round: finalTurn.round,
                role: "final",
                index: finalTurn.index,
                status: "pending",
                text: "",
              };
              turns.push(current);
            }
            runtime.phase = "summarizing";
            bump();
            const ok = await runTurn(
              current,
              buildDiscussionFinalPrompt(content, transcript, buildDiscussionFailureSummary(turns)),
            );
            if (ok) {
              return;
            }
            // 用户中止：不再消耗重试/替补候选，交由收尾逻辑判 stopped。
            if (current.status === "stopped" || runtime.abortRequested) {
              return;
            }
          }
        }
      };

      // ── Round 1（盲测）：首条走 default 分支建立 user 消息与锚点（content 落库
      // 为用户气泡，必须用原始输入）；message_created 一到即并行发出其余盲测发言，
      // 与多模型并行对话的 fan-out 同模式。race 兜底：Turn 1 失败收尾而锚点未建立
      // （请求被拒/网络失败）时不得死等，整场终止。
      const firstRun = runTurn(turns[0], content);
      await Promise.race([anchorReady, firstRun]);
      if (!anchor.assistantPublicID) {
        markRemainingStopped();
        runtime.phase = runtime.abortRequested ? "stopped" : "error";
        bump();
        return false;
      }
      if (runtime.abortRequested) {
        markRemainingStopped();
        runtime.phase = "stopped";
        bump();
        return true;
      }
      // 第 1 轮盲测隔离：全员透传原始问题，与首条 turn 完全同构——零 wrapper
      // 元话语污染、零语言漂移，消除首模型锚定。带 meta 的 retry 分支后端
      // 以 content 覆盖链尾 user 文本，裸 content 即独立重答原问题。
      const round1RemainingTurns = turns.filter(
        (item) => item.role === "participant" && item.round === 1 && item !== turns[0],
      );
      await Promise.all([
        firstRun,
        ...round1RemainingTurns.map((turn) => runTurn(turn, content)),
      ]);

      // ── Round 2..N（互审）：轮间 barrier（快照固定），轮内并行——同轮发言本就
      // 凭 maxRound 快照互不可见，并行不改变信息结构，只压缩墙钟时间。
      for (let round = 2; round <= boundedRounds; round += 1) {
        if (runtime.abortRequested) {
          markRemainingStopped();
          runtime.phase = "stopped";
          bump();
          return true;
        }
        // 第 N 轮只审阅第 N-1 轮及以前的确定快照，消除轮内序列特权（后发言者
        // 单向提前看到同轮互审）；对撞延迟到下一轮与终稿。前序全失败的兜底
        // （快照为空串）由 buildDiscussionParticipantPrompt 的 !transcript 分支承接。
        const transcript = buildDiscussionTranscript(turns, { maxRound: round - 1 });
        const roundTurns = turns.filter((item) => item.role === "participant" && item.round === round);
        await Promise.all(
          roundTurns.map((turn) =>
            runTurn(
              turn,
              buildDiscussionParticipantPrompt({
                modelName: turn.model,
                round: turn.round,
                userPrompt: content,
                transcript,
              }),
            ),
          ),
        );
      }

      // ── 终稿：凭全量 transcript 合成（runFinalWithFallback 内部取全量，不带快照过滤）。
      if (runtime.abortRequested) {
        markRemainingStopped();
        runtime.phase = "stopped";
        bump();
        return true;
      }
      const finalTurn = turns.find((turn) => turn.role === "final");
      if (finalTurn) {
        runtime.phase = "summarizing";
        bump();
        await runFinalWithFallback(finalTurn);
      }

      // 终稿可能有多条同 index 尝试：成功以最新 completed 为准，不能看数组末尾
      // （末尾可能是失败/未开跑的替补）。用户中止优先于 error。
      if (findLatestCompletedFinalTurn(turns)) {
        runtime.phase = "completed";
      } else if (runtime.abortRequested || turns.some((turn) => turn.role === "final" && turn.status === "stopped")) {
        runtime.phase = "stopped";
      } else {
        runtime.phase = "error";
      }
      bump();
      return runtime.phase === "completed";
    },
    [bump, submitMessage],
  );

  return {
    sendWithDiscussion,
    stopDiscussion,
    getDiscussionRuntimes,
    discussionRevision: revision,
  };
}
