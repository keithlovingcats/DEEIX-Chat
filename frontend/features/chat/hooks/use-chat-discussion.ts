"use client";

import * as React from "react";

import type { PendingAttachment } from "@/features/chat/types/chat-runtime";
import type {
  DiscussionRole,
  MessageDiscussionMetaInput,
} from "@/shared/api/conversation.types";
import type { SendMessageResult } from "@/shared/api/conversation.types";

/** 多模型讨论约束（与后端 dto 校验对齐）。 */
export const MAX_DISCUSSION_MODELS = 5;
export const MAX_DISCUSSION_ROUNDS = 5;
export const DEFAULT_DISCUSSION_ROUNDS = 2;

/** transcript 中单个发言的字符截断，防止多轮累积撑爆上下文。 */
const DISCUSSION_TRANSCRIPT_TURN_CHAR_LIMIT = 8000;

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

function truncateTurnText(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= DISCUSSION_TRANSCRIPT_TURN_CHAR_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, DISCUSSION_TRANSCRIPT_TURN_CHAR_LIMIT)}…`;
}

function isTurnCompletedStatus(status: DiscussionTurnStatus): boolean {
  return status === "completed";
}

/** transcript 只收录成功发言；失败发言是运营故障而非观点，不进入后续 prompt。 */
export function buildDiscussionTranscript(turns: DiscussionTurn[]): string {
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.role !== "participant" || turn.status !== "completed" || !turn.text.trim()) {
      continue;
    }
    lines.push(`Round ${turn.round}`);
    lines.push(`- ${turn.model}: ${truncateTurnText(turn.text)}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function buildDiscussionFailureSummary(turns: DiscussionTurn[]): string {
  return turns
    .filter((turn) => turn.status === "error" || turn.status === "stopped")
    .map((turn) => `- Round ${turn.round} - ${turn.model}: failed`)
    .join("\n")
    .trim();
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
 * 把「多模型并行 fan-out」的并行循环串行化为逐轮辩论：每个发言是一次独立的
 * submitMessage（独立 run/消息/计费），轮次间靠 Promise 语义等待；transcript
 * 拼进请求 content（后端对带 discussionMeta 的 reuse 分支不回填原用户消息）。
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

  /** 停止进行中的讨论：置中止标志并按 runID 显式取消当前发言的 run。 */
  const stopDiscussion = React.useCallback(() => {
    let stopped = false;
    for (const runtime of runtimesRef.current.values()) {
      if (runtime.phase !== "running" && runtime.phase !== "summarizing") {
        continue;
      }
      runtime.abortRequested = true;
      stopped = true;
      const runningTurn = runtime.turns.find((turn) => turn.status === "running");
      if (runningTurn?.clientRunID) {
        cancelRunRef.current(runningTurn.clientRunID);
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
      const boundedRounds = Math.max(1, Math.min(rounds, MAX_DISCUSSION_ROUNDS));

      // 预排全部发言（参与者 × 轮次 + 终稿）：驱动串行循环、transcript 与中止标记；
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

      const runTurn = async (turn: DiscussionTurn, prompt: string) => {
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
          // 首条 default 请求会把 parallelModels 持久化到会话；显式传完整参与者
          // 组合，避免默认的单元素组合在刷新后重置用户的多模型选择。
          persistParallelModels: isFirstTurn ? participants : undefined,
          overridePlatformModelName: turn.model,
          discussionMeta: meta,
          onAssistantCreated: (created) => {
            turn.assistantPublicID = created.assistantPublicID;
            turn.clientRunID = created.runID;
            if (!anchor.userPublicID) {
              anchor.userPublicID = created.userPublicID;
            }
            if (!anchor.assistantPublicID) {
              anchor.assistantPublicID = created.assistantPublicID;
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

      // 首条（第 1 轮第 1 个参与者）走 default 分支建立 user 消息与锚点。
      // default 分支的 content 会落库为用户消息并渲染为用户气泡，必须用原始
      // 输入而非讨论 wrapper —— 第 1 轮「独立回答」语义由第 2 轮起的 prompt 补足。
      const firstTurn = turns[0];
      await runTurn(firstTurn, content);
      if (!anchor.assistantPublicID) {
        // 连消息锚点都没建立（请求被拒或网络失败），整场终止。
        markRemainingStopped();
        runtime.phase = "error";
        bump();
        return false;
      }

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
          await runTurn(
            turn,
            buildDiscussionFinalPrompt(
              content,
              buildDiscussionTranscript(turns),
              buildDiscussionFailureSummary(turns),
            ),
          );
        } else {
          await runTurn(
            turn,
            buildDiscussionParticipantPrompt({
              modelName: turn.model,
              round: turn.round,
              userPrompt: content,
              transcript: buildDiscussionTranscript(turns),
            }),
          );
        }
      }

      const finalTurn = turns[turns.length - 1];
      if (finalTurn.status === "completed") {
        runtime.phase = "completed";
      } else if (finalTurn.status === "stopped" || runtime.abortRequested) {
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
