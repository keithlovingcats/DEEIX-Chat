"use client";

import { Check, ChevronDown, Copy, Loader2, MessageCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { ChevronDown as AnimatedChevronDown } from "@/components/animate-ui/icons/chevron-down";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { findLatestDiscussionFinalMessage, sortDiscussionGroup } from "@/features/chat/model/chat-thread";
import type { ChatAreaMessage, ChatDiscussionGroup } from "@/features/chat/types/messages";
import { cn } from "@/lib/utils";
import { useCopyAction } from "@/shared/components/copy-action";

const DISCUSSION_PANEL_ACCORDION = "discussion-panel";

type TurnView = {
  message: ChatAreaMessage;
  round: number;
  role: string;
  model: string;
  running: boolean;
  failed: boolean;
  stopped: boolean;
};

function toTurnView(message: ChatAreaMessage): TurnView {
  const meta = message.discussionMeta;
  const running = Boolean(message.isPending || message.isStreaming);
  const status = (message.status ?? "").trim().toLowerCase();
  const failed = status === "error";
  // 中止/中断的发言（用户停止、断流）既非成功也非失败，单独标记。
  const stopped = !running && !failed && status !== "" && status !== "success" && Boolean(message.content?.trim()) === false;
  return {
    message,
    round: meta?.round ?? 1,
    role: meta?.role ?? "participant",
    model: message.platformModelName?.trim() || meta?.participants?.[0] || "",
    running,
    failed,
    stopped,
  };
}

function phaseLabelKey(phase: ChatDiscussionGroup["phase"]): string {
  switch (phase) {
    case "summarizing":
      return "phaseSummarizing";
    case "completed":
      return "phaseCompleted";
    case "stopped":
      return "phaseStopped";
    case "error":
      return "phaseError";
    case "running":
      return "phaseRunning";
    default:
      return "phaseIncomplete";
  }
}

function phaseDotClass(phase: ChatDiscussionGroup["phase"]): string {
  switch (phase) {
    case "completed":
      return "bg-emerald-500";
    case "error":
      return "bg-red-500";
    case "stopped":
    case "recovered":
      return "bg-muted-foreground/50";
    default:
      return "bg-primary";
  }
}

function formatDuration(latencyMS?: number): string | null {
  if (!latencyMS || latencyMS <= 0) {
    return null;
  }
  const seconds = latencyMS / 1000;
  return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)}s`;
}

function formatTokens(outputTokens?: number): string | null {
  if (!outputTokens || outputTokens <= 0) {
    return null;
  }
  return `${outputTokens.toLocaleString()} tk`;
}

function TurnStatusBadge({ turn, t }: { turn: TurnView; t: ReturnType<typeof useTranslations> }) {
  if (turn.failed) {
    return <span className="text-[10px] font-medium text-red-500">{t("turnFailed")}</span>;
  }
  if (turn.stopped) {
    return <span className="text-[10px] font-medium text-muted-foreground">{t("turnStopped")}</span>;
  }
  if (turn.running) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary">
        <Loader2 className="size-3 animate-spin" />
        {t("turnRunning")}
      </span>
    );
  }
  return <span className="text-[10px] font-medium text-muted-foreground">{t("turnDone")}</span>;
}

function TurnCard({
  turn,
  t,
  showRound = true,
}: {
  turn: TurnView;
  t: ReturnType<typeof useTranslations>;
  showRound?: boolean;
}) {
  const tMessages = useTranslations("chat.messages");
  // 发言卡片默认收起（两行预览），点头部展开全文 —— 讨论动辄数十条发言，
  // 全展开会把全部轮次视图拉到不可用。
  const [expanded, setExpanded] = React.useState(false);
  // 与普通消息操作栏一致：每条发言可单独复制，桌面 hover 显示、移动端常显。
  const { copy, isCopied } = useCopyAction({
    messages: {
      copied: tMessages("copied"),
      failed: tMessages("copyFailed"),
      failedDescription: tMessages("copyFailedDescription"),
    },
  });
  const stats = [
    showRound ? t("turnRound", { round: turn.round }) : null,
    formatTokens(turn.message.outputTokens),
    formatDuration(turn.message.latencyMS),
  ].filter(Boolean) as string[];
  const content = turn.message.content?.trim() ?? "";
  const collapsible = content.length > 0;
  const copyKey = turn.message.publicID || turn.message.key;
  const copied = isCopied(copyKey);
  return (
    <div
      className={cn(
        "group/turn rounded-lg border-[0.5px] px-2.5 py-2 text-[11px]",
        turn.failed
          ? "border-red-500/25 bg-red-500/5"
          : turn.running
            ? "border-primary/25 bg-primary/5"
            : "border-border bg-muted/25",
      )}
    >
      <div className="flex w-full items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={expanded}
          disabled={!collapsible}
          onClick={() => setExpanded((current) => !current)}
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              turn.failed ? "bg-red-500" : turn.running ? "bg-primary" : turn.stopped ? "bg-muted-foreground/50" : "bg-emerald-500",
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground">
            {turn.role === "final" ? t("finalTurnLabel", { model: turn.model }) : turn.model}
          </span>
          <TurnStatusBadge turn={turn} t={t} />
          {collapsible ? (
            <ChevronDown
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform duration-200",
                expanded && "rotate-180",
              )}
              strokeWidth={1.8}
            />
          ) : null}
        </button>
        {content ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-screenshot-exclude="true"
                className={cn(
                  "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:text-foreground",
                  "md:pointer-events-none md:opacity-0 md:group-hover/turn:pointer-events-auto md:group-hover/turn:opacity-100 md:focus-visible:pointer-events-auto md:focus-visible:opacity-100",
                  copied && "md:pointer-events-auto md:opacity-100",
                )}
                aria-label={copied ? t("copied") : t("copy")}
                onClick={() => void copy(content, { key: copyKey })}
              >
                {copied ? (
                  <Check className="size-3 text-emerald-500" strokeWidth={1.8} />
                ) : (
                  <Copy className="size-3" strokeWidth={1.8} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{copied ? t("copied") : t("copy")}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {stats.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {stats.map((stat) => (
            <span
              key={stat}
              className="rounded-full border-[0.5px] border-border bg-background/80 px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground"
            >
              {stat}
            </span>
          ))}
        </div>
      ) : null}
      {content ? (
        <p
          className={cn(
            "mt-1.5 whitespace-pre-wrap break-words leading-4 text-muted-foreground",
            !expanded && "line-clamp-2",
          )}
        >
          {content}
        </p>
      ) : turn.running ? (
        <p className="mt-1.5 flex items-center gap-1 leading-4 text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {t("turnPreparing")}
        </p>
      ) : (
        <p className="mt-1.5 leading-4 text-muted-foreground/70">{t("turnEmpty")}</p>
      )}
    </div>
  );
}

/**
 * 多模型讨论过程面板：Accordion 折叠（流式自动展开、终态自动收起），
 * 内含「按模型」Tab 与「全部轮次」两种视图。数据全部从讨论组消息推导，
 * 运行中与刷新恢复共用同一渲染路径。
 */
export function DiscussionPanel({
  group,
  phase,
}: {
  group: ChatAreaMessage[];
  phase: ChatDiscussionGroup["phase"];
}) {
  const t = useTranslations("chat.discussion");
  const [accordionValue, setAccordionValue] = React.useState(() =>
    phase === "running" || phase === "summarizing" ? DISCUSSION_PANEL_ACCORDION : "",
  );
  const active = phase === "running" || phase === "summarizing";

  // 流式自动展开、完成自动收起一次。
  const autoCollapsedRef = React.useRef(false);
  React.useEffect(() => {
    if (active) {
      autoCollapsedRef.current = false;
      setAccordionValue(DISCUSSION_PANEL_ACCORDION);
      return;
    }
    if (!autoCollapsedRef.current) {
      autoCollapsedRef.current = true;
      setAccordionValue("");
    }
  }, [active]);

  const turns = React.useMemo(
    () => sortDiscussionGroup(group).map(toTurnView),
    [group],
  );
  // 参与者优先取 meta.participants（权威、不因中途停止/未落库的发言缺失）；
  // meta 缺失（异常数据）时回落到从已有发言推导。
  const participants = React.useMemo(() => {
    const metaParticipants = group[0]?.discussionMeta?.participants?.filter(Boolean) ?? [];
    if (metaParticipants.length > 0) {
      return metaParticipants;
    }
    const names: string[] = [];
    for (const turn of turns) {
      if (turn.role !== "participant") {
        continue;
      }
      if (!names.includes(turn.model)) {
        names.push(turn.model);
      }
    }
    return names;
  }, [group, turns]);
  // 终稿可能有多条（失败重试/换模型接替）；头部展示实际产出终稿的模型。
  const successfulFinal = findLatestDiscussionFinalMessage(group, { successfulOnly: true });
  const latestFinal = findLatestDiscussionFinalMessage(group);
  const finalTurn = turns.find((turn) => turn.message.publicID === (successfulFinal ?? latestFinal)?.publicID);
  const runningTurn = turns.find((turn) => turn.running);

  const [selectedModel, setSelectedModel] = React.useState<string>("");
  const effectiveModel = selectedModel && participants.includes(selectedModel) ? selectedModel : runningTurn?.model ?? participants[0] ?? "";
  const modelTurns = turns.filter((turn) => turn.model === effectiveModel);
  const rounds = React.useMemo(() => {
    const map = new Map<number, TurnView[]>();
    for (const turn of turns) {
      const list = map.get(turn.round) ?? [];
      list.push(turn);
      map.set(turn.round, list);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([round, items]) => ({ round, items }));
  }, [turns]);

  return (
    <Accordion
      type="single"
      collapsible
      value={accordionValue}
      onValueChange={(value) => setAccordionValue(value || "")}
      className="w-full"
    >
      <AccordionItem value={DISCUSSION_PANEL_ACCORDION} className="border-b-0">
        <AccordionTrigger
          iconPosition="none"
          className="group/discussion min-h-0 justify-between gap-1.5 py-0.5 text-left no-underline hover:no-underline"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <MessageCircle className="size-3.5 shrink-0 text-primary" />
              <Marker
                render={<span />}
                className={cn(
                  "inline-flex min-h-0 w-auto text-[13px] font-medium transition-colors",
                  !active && "text-muted-foreground group-hover/discussion:text-foreground",
                )}
              >
                <MarkerContent className={cn("min-w-0", active && "shimmer")}>
                  {t("panelTitle")}
                </MarkerContent>
              </Marker>
              <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
                <span className={cn("size-1.5 rounded-full", phaseDotClass(phase))} />
                {active ? <Loader2 className="size-3 animate-spin" /> : null}
                {t(phaseLabelKey(phase))}
              </span>
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] font-normal leading-4 text-muted-foreground/62">
              <span>{t("panelParticipantCount", { count: participants.length })}</span>
              {runningTurn ? (
                <span className="truncate text-primary">
                  {t("panelCurrentSpeaker", { model: runningTurn.model })}
                </span>
              ) : null}
              {finalTurn?.model ? (
                <span>{t("panelFinalModel", { model: finalTurn.model })}</span>
              ) : null}
            </div>
          </div>
          <AnimatedChevronDown
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover/discussion:text-foreground",
              accordionValue === DISCUSSION_PANEL_ACCORDION && "rotate-180",
            )}
          />
        </AccordionTrigger>
        <AccordionContent className="space-y-2 px-0 pb-0 pt-1.5 duration-[350ms] ease-in-out">
          <div className="flex flex-wrap items-center gap-1">
            {participants.map((model) => (
              <button
                key={model}
                type="button"
                className={cn(
                  "inline-flex h-6 max-w-44 items-center gap-1 rounded-md border-[0.5px] px-1.5 text-[10px] font-medium transition-colors",
                  model === effectiveModel
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border bg-muted/30 text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setSelectedModel(model)}
              >
                <span className="truncate">{model}</span>
                <span className="shrink-0 opacity-70">
                  {turns.filter((turn) => turn.model === model && turn.role === "participant").length}
                </span>
              </button>
            ))}
            <span className="ml-auto shrink-0 text-[10px] font-medium text-muted-foreground">
              {t("panelTurnCount", { count: turns.length })}
            </span>
          </div>

          <div className="space-y-1.5">
            {modelTurns.map((turn) => (
              <TurnCard key={turn.message.publicID || turn.message.key} turn={turn} t={t} />
            ))}
          </div>

          <div className="border-t-[0.5px] border-border pt-1.5">
            <div className="mb-1 text-[10px] font-semibold text-muted-foreground">
              {t("panelAllRounds")}
            </div>
            <div className="space-y-2">
              {rounds.map(({ round, items }) => (
                <div key={round} className="space-y-1.5">
                  <div className="text-[10px] font-medium text-muted-foreground/80">
                    {items[0]?.role === "final" ? t("finalRoundLabel") : t("turnRound", { round })}
                  </div>
                  {items.map((turn) => (
                    <TurnCard key={`all-${turn.message.publicID || turn.message.key}`} turn={turn} t={t} showRound={false} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
