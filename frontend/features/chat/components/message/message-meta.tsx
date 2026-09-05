"use client";

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Brain,
  CircleDollarSign,
  ClockArrowUp,
  ClockCheck,
  Cpu,
  DatabaseSearch,
  DatabaseZap,
  FilePenLine,
  Forward,
  LoaderCircle,
  TicketSlash,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { Brush } from "@/components/animate-ui/icons/brush";
import { Check } from "@/components/animate-ui/icons/check";
import { ChevronLeft } from "@/components/animate-ui/icons/chevron-left";
import { ChevronRight } from "@/components/animate-ui/icons/chevron-right";
import { Copy } from "@/components/animate-ui/icons/copy";
import { GitFork } from "@/components/animate-ui/icons/git-fork";
import { Heart } from "@/components/animate-ui/icons/heart";
import { RotateCcw } from "@/components/animate-ui/icons/rotate-ccw";
import { ThumbsDown } from "@/components/animate-ui/icons/thumbs-down";
import { ThumbsUp } from "@/components/animate-ui/icons/thumbs-up";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChatElapsedDurationMS } from "@/features/chat/hooks/use-chat-elapsed-duration";
import { type BillingSnapshot, parseBillingSnapshot } from "@/features/chat/model/billing-snapshot";
import {
  durationBetweenMS,
  firstDurationMS,
  formatDurationMS,
} from "@/features/chat/model/duration";
import { resolvePersistedPublicID } from "@/features/chat/model/message-submit";
import type { ChatBillingCost, ChatMessageBranchNavigator, ChatMessageBranchSibling } from "@/features/chat/types/messages";
import { useLocalizedErrorMessage } from "@/i18n/use-localized-error";
import { cn } from "@/lib/utils";
import { upsertUserMemory } from "@/shared/api/memory";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";
import { ModelIcon } from "@/shared/components/model-icon";
import { usePointerInteraction } from "@/shared/hooks/use-pointer-interaction";
import type { BillingDisplayCurrency, BillingDisplayLabels, BillingDisplayOptions } from "@/shared/lib/billing-display";
import {
  billingRateMultiplierNote,
  cacheWriteBillingLabel,
  cacheWriteBillingNote,
  formatBillingDisplayCompactAmountFromUSD,
  formatBillingDisplayPreciseAmountFromUSD,
  formatBillingDisplayUnitPriceFromUSD,
} from "@/shared/lib/billing-display";
import { resolveModelIconURL, resolveModelIdentity } from "@/shared/lib/model-identity";

const META_ACTION_BUTTON_CLASSNAME =
  "text-muted-foreground [&_svg:not([class*='size-'])]:size-3.5";

export type ChatMetaMessage = {
  publicID: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  editedAt?: string | null;
  isPending?: boolean;
  isStreaming?: boolean;
  branchNavigator?: ChatMessageBranchNavigator;
  platformModelName?: string;
  // Token usage for assistant messages.
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  latencyMS?: number;
  billingCost?: ChatBillingCost;
};

export type AssistantReaction = "up" | "down" | null;

type MessageTimestampLabel = {
  label: string;
  title: string;
};

type MessageTimestampValues = {
  year: number;
  month: number;
  day: number;
  time: string;
};

type MessageTimestampFormatter = (
  key: "todayTime" | "thisYearDateTime" | "fullDateTime",
  values: MessageTimestampValues,
) => string;

function formatMessageTimestamp(value: string | undefined, formatLabel: MessageTimestampFormatter): MessageTimestampLabel | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const now = new Date();
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const isToday =
    year === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    day === now.getDate();
  const isCurrentYear = year === now.getFullYear();
  const timeLabel = [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  const values = { year, month, day, time: timeLabel };
  const title = formatLabel("fullDateTime", values);

  if (isToday) {
    return { label: formatLabel("todayTime", values), title };
  }

  return {
    label: formatLabel(isCurrentYear ? "thisYearDateTime" : "fullDateTime", values),
    title,
  };
}

function MessageTimestamp({ timestamp }: { timestamp: MessageTimestampLabel | null }) {
  if (!timestamp) {
    return null;
  }

  return (
    <span className="inline-flex h-6 shrink-0 items-center leading-none tabular-nums" title={timestamp.title}>
      {timestamp.label}
    </span>
  );
}

function BranchSwitcher({
  item,
  onCycle,
  navigationSiblings,
  onSelectBranch,
}: {
  item: ChatMetaMessage;
  onCycle: (parentPublicID: string | null, direction: "previous" | "next") => void;
  /** 限定导航范围的消息列表（多模型 tab 场景 = 同模型版本）；提供且含当前消息时按列表内移动。 */
  navigationSiblings?: { publicID: string }[];
  onSelectBranch?: (parentPublicID: string | null, childPublicID: string) => void;
}) {
  const t = useTranslations("chat.messages");
  const navigator = item.branchNavigator;
  if (!navigator) {
    return null;
  }

  // 限定范围导航：多模型 tab 下底部切换器只切换同模型版本，不跨模型。
  const scoped = navigationSiblings?.length ? navigationSiblings : null;
  const scopedIndex = scoped ? scoped.findIndex((sibling) => sibling.publicID === item.publicID) : -1;
  if (scoped && scopedIndex < 0) {
    return null;
  }
  if (scoped && onSelectBranch) {
    const total = scoped.length;
    const select = (direction: "previous" | "next") => {
      const target = scoped[direction === "previous" ? scopedIndex - 1 : scopedIndex + 1];
      if (target) {
        onSelectBranch(navigator.parentPublicID ?? null, target.publicID);
      }
    };
    return (
      <div className="inline-flex items-center" data-screenshot-exclude="true">
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35"
          aria-label={t("previousBranch")}
          disabled={scopedIndex <= 0}
          onClick={() => select("previous")}
        >
          <ChevronLeft size={14} strokeWidth={1.8} animateOnHover="default" />
        </button>
        <span className="min-w-7 text-center tabular-nums text-xs font-medium tracking-[0.01em] text-muted-foreground">
          {scopedIndex + 1}/{total}
        </span>
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35"
          aria-label={t("nextBranch")}
          disabled={scopedIndex >= total - 1}
          onClick={() => select("next")}
        >
          <ChevronRight size={14} strokeWidth={1.8} animateOnHover="default" />
        </button>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center" data-screenshot-exclude="true">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={META_ACTION_BUTTON_CLASSNAME}
            aria-label={t("previousBranch")}
            disabled={!navigator.canPrevious}
            onClick={() => onCycle(navigator.parentPublicID ?? null, "previous")}
          >
            <ChevronLeft strokeWidth={1.8} animateOnHover="default" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t("previousBranch")}</TooltipContent>
      </Tooltip>
      <span className="min-w-7 text-center tabular-nums text-xs font-medium tracking-[0.01em] text-muted-foreground">
        {navigator.index}/{navigator.total}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={META_ACTION_BUTTON_CLASSNAME}
            aria-label={t("nextBranch")}
            disabled={!navigator.canNext}
            onClick={() => onCycle(navigator.parentPublicID ?? null, "next")}
          >
            <ChevronRight strokeWidth={1.8} animateOnHover="default" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t("nextBranch")}</TooltipContent>
      </Tooltip>
    </div>
  );
}

type ModelBranchTabGroup = {
  /** 分组键：模型名；无模型名的消息各自独立成组（用序号保证唯一）。 */
  key: string;
  /** tab 显示名（模型名或 #序号）。 */
  label: string;
  /** 组内消息（创建顺序），末尾为最新版本。 */
  siblings: ChatMessageBranchSibling[];
  /** 点击 tab 时应选中的消息（组内当前展示的，或最新一条）。 */
  activePublicID: string;
  /** 组内是否含当前展示消息。 */
  active: boolean;
};

function buildModelBranchTabGroups(
  siblings: ChatMessageBranchSibling[],
  currentPublicID: string,
): ModelBranchTabGroup[] {
  const groups: ModelBranchTabGroup[] = [];
  const groupsByKey = new Map<string, ModelBranchTabGroup>();
  siblings.forEach((sibling, index) => {
    const modelName = sibling.platformModelName?.trim() || "";
    const key = modelName || `#${index + 1}`;
    let group = groupsByKey.get(key);
    if (!group) {
      group = { key, label: key, siblings: [], activePublicID: sibling.publicID, active: false };
      groupsByKey.set(key, group);
      groups.push(group);
    }
    group.siblings.push(sibling);
  });
  for (const group of groups) {
    group.active = group.siblings.some((sibling) => sibling.publicID === currentPublicID);
    // 点击 tab 切到该模型当前展示的消息；无展示态（首次点入）时取最新版本。
    group.activePublicID =
      group.siblings.find((sibling) => sibling.publicID === currentPublicID)?.publicID ??
      group.siblings[group.siblings.length - 1].publicID;
  }
  return groups;
}

export function ModelBranchTabs({
  item,
  onSelectBranch,
}: {
  item: ChatMetaMessage;
  onSelectBranch: (parentPublicID: string | null, childPublicID: string) => void;
}) {
  const t = useTranslations("chat.messages");
  const siblings = item.branchNavigator?.siblings;
  if (!siblings || siblings.length <= 1) {
    return null;
  }
  // tab 按模型聚合：同模型的多次重试归并为一个 tab，重试在当前 tab 内重新生成。
  const groups = buildModelBranchTabGroups(siblings, item.publicID);
  if (groups.length <= 1) {
    return null;
  }

  return (
    <div
      className="mb-2 inline-flex max-w-full flex-wrap items-center gap-1 self-start rounded-xl border border-border/70 bg-muted/30 p-1"
      data-screenshot-exclude="true"
      role="tablist"
      aria-label={t("modelBranches")}
    >
      {groups.map((group) => {
        const activeSibling =
          group.siblings.find((sibling) => sibling.publicID === group.activePublicID) ??
          group.siblings[group.siblings.length - 1];
        const generating = group.siblings.some(
          (sibling) => sibling.isPending || sibling.isStreaming || sibling.status?.trim().toLowerCase() === "pending",
        );
        const failed = activeSibling.status?.trim().toLowerCase() === "error";
        const hasBranches = group.siblings.some((sibling) => sibling.hasBranches);
        return (
          <button
            key={group.key}
            type="button"
            role="tab"
            aria-selected={group.active}
            title={group.label}
            className={cn(
              "relative inline-flex h-8 max-w-48 items-center gap-1.5 rounded-lg px-2.5 text-[12px] leading-none transition-all",
              group.active
                ? "border border-foreground/20 bg-background font-semibold text-foreground shadow-sm ring-2 ring-foreground/20"
                : "border border-transparent bg-transparent font-medium text-muted-foreground hover:bg-background/90 hover:text-foreground",
              !group.active && generating && "animate-pulse",
              !group.active && failed && "text-destructive/80 hover:text-destructive",
            )}
            onClick={() => {
              if (!group.active) {
                onSelectBranch(item.branchNavigator?.parentPublicID ?? null, group.activePublicID);
              }
            }}
          >
            <ModelIcon
              iconUrl={resolveModelIconURL(
                resolveModelIdentity({ code: activeSibling.platformModelName ?? "" }).modelIcon,
              )}
              label={group.label}
            />
            <span className="truncate">{group.label}</span>
            {group.active ? (
              <span
                className="absolute inset-x-2 -bottom-[5px] h-0.5 rounded-full bg-foreground"
                aria-hidden="true"
              />
            ) : null}
            {hasBranches ? (
              <span
                className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-sky-500 ring-2 ring-background"
                aria-hidden="true"
                title={t("modelHasBranches")}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function MetaContainer({
  align,
  mobileStack = false,
  alwaysVisible = false,
  children,
}: React.PropsWithChildren<{
  align: "start" | "end";
  mobileStack?: boolean;
  alwaysVisible?: boolean;
}>) {
  const { hasTouchInput } = usePointerInteraction();
  const actionsVisible = alwaysVisible || hasTouchInput;

  return (
    <div
      data-hover-actions={!actionsVisible ? "true" : undefined}
      className={[
        "chat-message-meta mt-1.5 flex gap-1 text-xs text-muted-foreground opacity-100 transition-opacity duration-150",
        actionsVisible ? "md:pointer-events-auto md:opacity-100" : "md:pointer-events-none md:opacity-0",
        mobileStack ? "flex-col items-start md:flex-row md:items-center" : "items-center",
        align === "end" ? "justify-end" : "justify-start",
        !actionsVisible && align === "end"
          ? "md:group-hover/user-message:pointer-events-auto md:group-hover/user-message:opacity-100 md:group-focus-within/user-message:pointer-events-auto md:group-focus-within/user-message:opacity-100"
          : "",
        !actionsVisible && align === "start"
          ? "md:group-hover/assistant-message:pointer-events-auto md:group-hover/assistant-message:opacity-100 md:group-focus-within/assistant-message:pointer-events-auto md:group-focus-within/assistant-message:opacity-100"
          : "",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

function MetaIconButton({
  label,
  disabled,
  onClick,
  className,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-screenshot-exclude="true"
          className={cn(META_ACTION_BUTTON_CLASSNAME, className)}
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function ForkMessageButton({
  disabled = false,
  label,
  onFork,
}: {
  disabled?: boolean;
  label: string;
  onFork: () => Promise<void> | void;
}) {
  const inFlightRef = React.useRef(false);
  const [inFlight, setInFlight] = React.useState(false);

  const handleFork = React.useCallback(async () => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setInFlight(true);
    try {
      await onFork();
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }, [onFork]);

  return (
    <MetaIconButton
      label={label}
      disabled={disabled || inFlight}
      onClick={() => void handleFork()}
    >
      <GitFork strokeWidth={1.8} animateOnHover="default" />
    </MetaIconButton>
  );
}

export function UserMessageMeta({
  item,
  showRetry,
  retrying = false,
  onCycleBranch,
  onRetry,
  onEdit,
  onCopy,
  onDelete,
  deleting = false,
  copySucceeded = false,
  readOnly = false,
  alwaysVisible = false,
  showBranchNavigator = true,
}: {
  item: ChatMetaMessage;
  showRetry: boolean;
  /** 该消息的重试 run 进行中：按钮禁用并转圈，防止连点堆积并行任务。 */
  retrying?: boolean;
  onCycleBranch: (parentPublicID: string | null, direction: "previous" | "next") => void;
  onRetry: () => void;
  onEdit: () => void;
  onCopy: () => void;
  /** 物理删除本条提问（其下回复子树级联删除）：仅在确认对话框确认后触发。 */
  onDelete?: () => void;
  /** 删除请求进行中：按钮禁用并转圈。 */
  deleting?: boolean;
  copySucceeded?: boolean;
  readOnly?: boolean;
  alwaysVisible?: boolean;
  showBranchNavigator?: boolean;
}) {
  const t = useTranslations("chat.messages");
  const timeT = useTranslations("common.time");
  const timestamp = formatMessageTimestamp(item.createdAt, (key, values) => timeT(key, values));
  const hasPersistedMessage = Boolean(resolvePersistedPublicID(item.publicID));
  const messagePending = Boolean(item.isPending || item.status?.trim().toLowerCase() === "pending");
  const canShowBranchNavigator = Boolean(showBranchNavigator && item.branchNavigator);
  const canDelete = Boolean(!readOnly && !messagePending && hasPersistedMessage && onDelete);

  return (
    <MetaContainer align="end" alwaysVisible={alwaysVisible}>
      <MessageTimestamp timestamp={timestamp} />
      {!readOnly ? (
        <div className="flex items-center">
          {showRetry && hasPersistedMessage ? (
            <MetaIconButton
              label={t("retryMessage")}
              disabled={messagePending || retrying}
              onClick={onRetry}
            >
{retrying ? (
                <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.8} />
              ) : (
                <RotateCcw strokeWidth={1.8} animateOnHover="default" />
              )}
            </MetaIconButton>
          ) : null}
          <MetaIconButton
            label={t("editMessage")}
            disabled={messagePending || !hasPersistedMessage}
            onClick={onEdit}
          >
            <Brush strokeWidth={1.8} animateOnHover="default" />
          </MetaIconButton>
          <MetaIconButton
            label={t("copyMessage")}
            disabled={messagePending}
            onClick={onCopy}
          >
            {copySucceeded ? (
              <Check strokeWidth={1.8} animate="default" />
            ) : (
              <Copy strokeWidth={1.8} animateOnHover="default" />
            )}
          </MetaIconButton>
          {canDelete && onDelete ? (
            <MetaIconButton
              label={t("deleteQuestion")}
              className="hover:text-destructive"
              disabled={deleting}
              onClick={onDelete}
            >
              {deleting ? (
                <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.8} />
              ) : (
                <Trash2 strokeWidth={1.8} />
              )}
            </MetaIconButton>
          ) : null}
        </div>
      ) : null}
      {canShowBranchNavigator ? <BranchSwitcher item={item} onCycle={onCycleBranch} /> : null}
    </MetaContainer>
  );
}

function TokenBadge({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  reasoningTokens,
}: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}) {
  const t = useTranslations("chat.meta");
  const inputValue = inputTokens ?? 0;
  const outputValue = outputTokens ?? 0;
  const cacheReadValue = cacheReadTokens ?? 0;
  const cacheWriteValue = cacheWriteTokens ?? 0;
  const reasoningValue = reasoningTokens ?? 0;
  const hasUsage = inputValue > 0 || outputValue > 0 || cacheReadValue > 0 || cacheWriteValue > 0 || reasoningValue > 0;
  if (!hasUsage) {
    return null;
  }

  return (
    <span className="ml-0.5 inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] leading-3.5 font-mono text-muted-foreground/70 bg-muted/30 select-none whitespace-nowrap">
      <TokenMetric label={t("inputTokens")} value={inputValue} icon={<ArrowUpFromLine className="size-3" strokeWidth={1.4} />} />
      <TokenMetric label={t("cacheReadTokens")} value={cacheReadValue} icon={<DatabaseSearch className="size-3" strokeWidth={1.4} />} />
      <TokenMetric label={t("reasoningTokens")} value={reasoningValue} icon={<Brain className="size-3" strokeWidth={1.4} />} />
      <TokenMetric label={t("outputTokens")} value={outputValue} icon={<ArrowDownToLine className="size-3" strokeWidth={1.4} />} />
      <TokenMetric label={t("cacheWriteTokens")} value={cacheWriteValue} icon={<DatabaseZap className="size-3" strokeWidth={1.4} />} />
    </span>
  );
}

function TokenMetric({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-0.5" aria-label={label}>
          {icon}
          {value.toLocaleString()}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function LatencyBadge({ item }: { item: ChatMetaMessage }) {
  const t = useTranslations("chat.meta");
  const isLive = Boolean(item.isPending || item.isStreaming);
  const liveLatencyMS = useChatElapsedDurationMS(isLive, item.createdAt);
  const calculatedLatencyMS = durationBetweenMS(item.createdAt, item.updatedAt);
  const latencyMS = isLive
    ? firstDurationMS(liveLatencyMS, calculatedLatencyMS, item.latencyMS)
    : firstDurationMS(item.latencyMS, calculatedLatencyMS);
  const label = formatDurationMS(latencyMS);
  if (!label) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="ml-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-3.5 font-mono text-muted-foreground/70 bg-muted/30 select-none whitespace-nowrap"
          aria-label={isLive ? t("generationDuration") : t("totalDuration")}
        >
          {isLive ? (
            <ClockArrowUp className="size-3" strokeWidth={1.4} />
          ) : (
            <ClockCheck className="size-3" strokeWidth={1.4} />
          )}
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{isLive ? t("generationDuration") : t("totalDuration")}</TooltipContent>
    </Tooltip>
  );
}

function EditedBadge() {
  const t = useTranslations("chat.messages");
  const label = t("replyEditedDisclaimer");
  const tooltip = t("replyEditedTooltip");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="ml-0.5 inline-flex items-center gap-1 rounded bg-muted/30 px-1.5 py-0.5 text-[10px] leading-3.5 text-muted-foreground/70 select-none whitespace-nowrap"
          aria-label={tooltip}
        >
          <FilePenLine className="size-3" strokeWidth={1.4} />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function ModelBadge({ label }: { label: string }) {
  const t = useTranslations("chat.meta");
  const normalized = label.trim();
  if (!normalized) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="ml-0.5 inline-flex max-w-48 items-center gap-1 rounded bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] leading-3.5 text-muted-foreground/70 select-none whitespace-nowrap"
          aria-label={t("model")}
        >
          <Cpu className="size-3 shrink-0" strokeWidth={1.4} />
          <span className="truncate">{normalized}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{normalized}</TooltipContent>
    </Tooltip>
  );
}

function readBillingNumber(snapshot: BillingSnapshot, key: keyof BillingSnapshot): number {
  const value = snapshot[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nanousdToUSD(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value / 1_000_000_000;
}

function formatBillingCost(value: number, billingDisplay: BillingDisplayOptions): string {
  return formatBillingDisplayCompactAmountFromUSD(value, billingDisplay);
}

function formatTooltipBillingCost(value: number, billingDisplay: BillingDisplayOptions): string {
  return formatBillingDisplayPreciseAmountFromUSD(value, billingDisplay);
}

function formatTooltipUnitPrice(value: number, billingDisplay: BillingDisplayOptions): string {
  return formatBillingDisplayUnitPriceFromUSD(value, billingDisplay);
}

function calcTokenBilledNanousd(tokens: number, rateNanousd: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(rateNanousd) || tokens <= 0 || rateNanousd <= 0) {
    return 0;
  }
  return Math.round((tokens * rateNanousd) / 1_000_000);
}

type BillingTooltipLine =
  | { type: "row"; left: string; right: string }
  | { type: "divider" }
  | { type: "tiered-table"; rangeLabel: string; rows: BillingTieredTableRow[]; totalAmount: string };

type BillingTieredTableRow = {
  item: string;
  tokens: string;
  unitPrice: string;
  amount: string;
};

type BillingMetaLabels = {
  display: BillingDisplayLabels;
  input: string;
  output: string;
  cacheRead: string;
  rateNote: string;
  cacheNote: string;
  total: string;
  freeModelNoBilling: string;
  perCall: string;
  perSecond: string;
  callUnit: string;
  secondUnit: string;
  tieredRange: (from: string, upTo: string | null) => string;
};

function useBillingMetaLabels(): BillingMetaLabels {
  const t = useTranslations("chat.meta.billing");
  return React.useMemo(
    () => ({
      display: {
        cacheWrite: t("cacheWrite"),
        cacheWrite5m: t("cacheWrite5m"),
        cacheWrite1h: t("cacheWrite1h"),
        cacheWrite5m1h: t("cacheWrite5m1h"),
        claudeCacheWriteMixedNote: (multiplier) => t("claudeCacheWriteMixedNote", { multiplier }),
        claudeCacheWriteNote: (timeout, multiplier) => t("claudeCacheWriteNote", { timeout, multiplier }),
        claudeFastModeNote: (multiplier) => t("claudeFastModeNote", { multiplier }),
        openaiServiceTierNote: (tier, multiplier) => t("openaiServiceTierNote", { tier, multiplier }),
        cacheWritePricingLabel: t("cacheWritePricingLabel"),
        cacheWritePricingNote: t("cacheWritePricingNote"),
      },
      input: t("input"),
      output: t("output"),
      cacheRead: t("cacheRead"),
      rateNote: t("rateNote"),
      cacheNote: t("cacheNote"),
      total: t("total"),
      freeModelNoBilling: t("freeModelNoBilling"),
      perCall: t("perCall"),
      perSecond: t("perSecond"),
      callUnit: t("callUnit"),
      secondUnit: t("secondUnit"),
      tieredRange: (from, upTo) => upTo ? t("tieredRangeBounded", { from, upTo }) : t("tieredRangeOpen", { from }),
    }),
    [t],
  );
}

function formatBillingFormulaLine(label: string, tokens: number, rateNanousd: number, billedNanousd: number, billingDisplay: BillingDisplayOptions): BillingTooltipLine {
  return {
    type: "row",
    left: label,
    right: `${tokens.toLocaleString("en-US")} tokens * ${formatTooltipUnitPrice(nanousdToUSD(rateNanousd), billingDisplay)} / 1M = ${formatTooltipBillingCost(nanousdToUSD(billedNanousd), billingDisplay)}`,
  };
}

function formatTokenQuantity(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value.toLocaleString("en-US");
}

function formatTieredRangeLabel(fromTokens: number | null | undefined, upToTokens: number | null | undefined, labels: BillingMetaLabels): string {
  const from = Number.isFinite(fromTokens ?? NaN) && (fromTokens ?? 0) > 0 ? fromTokens ?? 0 : 0;
  const upTo = Number.isFinite(upToTokens ?? NaN) && (upToTokens ?? 0) > 0 ? upToTokens ?? 0 : null;
  return labels.tieredRange(formatTokenQuantity(from), upTo ? formatTokenQuantity(upTo) : null);
}

function formatTieredTableRow(item: string, tokens: number, rateNanousd: number, billedNanousd: number, billingDisplay: BillingDisplayOptions): BillingTieredTableRow {
  const safeTokens = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  const safeBilled = Number.isFinite(billedNanousd) && billedNanousd > 0 ? billedNanousd : 0;
  return {
    item,
    tokens: formatTokenQuantity(safeTokens),
    unitPrice: `${formatTooltipUnitPrice(nanousdToUSD(rateNanousd), billingDisplay)} / 1M`,
    amount: formatTooltipBillingCost(nanousdToUSD(safeBilled), billingDisplay),
  };
}

function formatCountLine(label: string, count: number, unit: string, rateNanousd: number, billedNanousd: number, billingDisplay: BillingDisplayOptions): BillingTooltipLine {
  const safeCount = Number.isFinite(count) && count > 0 ? count : 0;
  return {
    type: "row",
    left: label,
    right: `${safeCount.toLocaleString("en-US")} ${unit} * ${formatTooltipUnitPrice(nanousdToUSD(rateNanousd), billingDisplay)} / ${unit} = ${formatTooltipBillingCost(nanousdToUSD(billedNanousd), billingDisplay)}`,
  };
}

function formatTotalLine(amount: string, labels: BillingMetaLabels): BillingTooltipLine {
  return { type: "row", left: labels.total, right: amount };
}

type BillingServiceItemEntry = {
  label: string;
  callCount: number;
  rateNanousd: number;
  billedNanousd: number;
};

// billingServiceItemEntries 提取快照中的服务项（如 MCP 工具按次计费），保证明细行与总额对得上。
function billingServiceItemEntries(snapshot: BillingSnapshot): BillingServiceItemEntry[] {
  const items = Array.isArray(snapshot.service_items) ? snapshot.service_items : [];
  const entries: BillingServiceItemEntry[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const billed = typeof item.billed_nanousd === "number" && Number.isFinite(item.billed_nanousd) ? item.billed_nanousd : 0;
    if (billed <= 0) continue;
    const label = (item.service_name ?? "").trim() || (item.service_code ?? "").trim();
    if (!label) continue;
    const callCount = typeof item.call_count === "number" && Number.isFinite(item.call_count) && item.call_count > 0 ? item.call_count : 1;
    const rate = typeof item.call_nanousd_per_call === "number" && Number.isFinite(item.call_nanousd_per_call) && item.call_nanousd_per_call > 0 ? item.call_nanousd_per_call : Math.round(billed / callCount);
    entries.push({ label, callCount, rateNanousd: rate, billedNanousd: billed });
  }
  return entries;
}

function billingServiceItemLines(entries: BillingServiceItemEntry[], labels: BillingMetaLabels, billingDisplay: BillingDisplayOptions): BillingTooltipLine[] {
  return entries.map((entry) => formatCountLine(entry.label, entry.callCount, labels.callUnit, entry.rateNanousd, entry.billedNanousd, billingDisplay));
}

function billingServiceItemTableRows(entries: BillingServiceItemEntry[], labels: BillingMetaLabels, billingDisplay: BillingDisplayOptions): BillingTieredTableRow[] {
  return entries.map((entry) => ({
    item: entry.label,
    tokens: `${entry.callCount.toLocaleString("en-US")} ${labels.callUnit}`,
    unitPrice: `${formatTooltipUnitPrice(nanousdToUSD(entry.rateNanousd), billingDisplay)} / ${labels.callUnit}`,
    amount: formatTooltipBillingCost(nanousdToUSD(entry.billedNanousd), billingDisplay),
  }));
}

function billingTooltipLines(item: ChatMetaMessage, labels: BillingMetaLabels, billingDisplay: BillingDisplayOptions): BillingTooltipLine[] {
  const cost = item.billingCost;
  if (!cost) {
    return [];
  }
  const snapshot = parseBillingSnapshot(cost.pricingSnapshotJSON);
  const pricingMode = snapshot.pricing_mode === "call" || snapshot.pricing_mode === "duration" || snapshot.pricing_mode === "tiered" ? snapshot.pricing_mode : "token";
  const serviceEntries = billingServiceItemEntries(snapshot);
  const serviceLines = billingServiceItemLines(serviceEntries, labels, billingDisplay);
  // 工具服务项与模型计费之间用分隔线隔开。
  const serviceSection: BillingTooltipLine[] = serviceLines.length > 0 ? [{ type: "divider" }, ...serviceLines] : [];
  // 免费模型也可能因 MCP 等服务项产生费用，只有整单为 0 才按免费展示。
  const freeOfCharge = snapshot.is_free_model === true && !(cost.billedNanousd > 0);
  const totalLine = freeOfCharge
    ? formatTotalLine(`${formatTooltipBillingCost(0, billingDisplay)} (${labels.freeModelNoBilling})`, labels)
    : formatTotalLine(formatTooltipBillingCost(nanousdToUSD(cost.billedNanousd), billingDisplay), labels);

  if (pricingMode === "call") {
    const rate = readBillingNumber(snapshot, "call_nanousd_per_call");
    const billed = readBillingNumber(snapshot, "call_billed_nanousd") || rate;
    return [formatCountLine(labels.perCall, 1, labels.callUnit, rate, billed, billingDisplay), ...serviceSection, { type: "divider" }, totalLine];
  }

  if (pricingMode === "duration") {
    const rate = readBillingNumber(snapshot, "duration_nanousd_per_second");
    const billed = readBillingNumber(snapshot, "duration_billed_nanousd");
    return [formatCountLine(labels.perSecond, 1, labels.secondUnit, rate, billed, billingDisplay), ...serviceSection, { type: "divider" }, totalLine];
  }

  const inputRate = readBillingNumber(snapshot, "input_nanousd_per_m_tokens");
  const outputRate = readBillingNumber(snapshot, "output_nanousd_per_m_tokens");
  const cacheReadRate = readBillingNumber(snapshot, "cache_read_nanousd_per_m_tokens");
  const cacheWriteRate = readBillingNumber(snapshot, "cache_write_nanousd_per_m_tokens");
  const inputTokens = item.inputTokens ?? 0;
  const cacheReadTokens = item.cacheReadTokens ?? 0;
  const cacheWriteTokens = item.cacheWriteTokens ?? 0;
  const outputTokens = item.outputTokens ?? 0;
  const reasoningTokens = item.reasoningTokens ?? 0;
  const billedOutputTokens = outputTokens + reasoningTokens;
  const cacheWriteLabel = cacheWriteBillingLabel(snapshot, labels.display);
  const cacheWriteNote = cacheWriteBillingNote(snapshot, labels.display);
  const rateMultiplierNote = billingRateMultiplierNote(snapshot, labels.display);

  if (pricingMode === "tiered") {
    const tieredRows = [
      formatTieredTableRow(labels.input, inputTokens, inputRate, readBillingNumber(snapshot, "input_billed_nanousd"), billingDisplay),
      formatTieredTableRow(labels.output, billedOutputTokens, outputRate, readBillingNumber(snapshot, "output_billed_nanousd"), billingDisplay),
      formatTieredTableRow(labels.cacheRead, cacheReadTokens, cacheReadRate, readBillingNumber(snapshot, "cache_read_billed_nanousd"), billingDisplay),
      formatTieredTableRow(cacheWriteLabel, cacheWriteTokens, cacheWriteRate, readBillingNumber(snapshot, "cache_write_billed_nanousd"), billingDisplay),
      ...billingServiceItemTableRows(serviceEntries, labels, billingDisplay),
    ];
    const lines: BillingTooltipLine[] = [];
    if (rateMultiplierNote || cacheWriteNote) {
      if (rateMultiplierNote) {
        lines.push({ type: "row", left: labels.rateNote, right: rateMultiplierNote });
      }
      if (cacheWriteNote) {
        lines.push({ type: "row", left: labels.cacheNote, right: cacheWriteNote });
      }
      lines.push({ type: "divider" });
    }
    if (tieredRows.length > 0) {
      lines.push({
        type: "tiered-table",
        rangeLabel: formatTieredRangeLabel(snapshot.tiered_from_tokens, snapshot.tiered_up_to_tokens, labels),
        rows: tieredRows,
        totalAmount: freeOfCharge ? `${formatTooltipBillingCost(0, billingDisplay)} (${labels.freeModelNoBilling})` : formatTooltipBillingCost(nanousdToUSD(cost.billedNanousd), billingDisplay),
      });
      return lines;
    }
  }

  const lines: BillingTooltipLine[] = [
    formatBillingFormulaLine(labels.input, inputTokens, inputRate, readBillingNumber(snapshot, "input_billed_nanousd") || calcTokenBilledNanousd(inputTokens, inputRate), billingDisplay),
    formatBillingFormulaLine(labels.output, billedOutputTokens, outputRate, readBillingNumber(snapshot, "output_billed_nanousd") || calcTokenBilledNanousd(billedOutputTokens, outputRate), billingDisplay),
    formatBillingFormulaLine(labels.cacheRead, cacheReadTokens, cacheReadRate, readBillingNumber(snapshot, "cache_read_billed_nanousd") || calcTokenBilledNanousd(cacheReadTokens, cacheReadRate), billingDisplay),
    formatBillingFormulaLine(cacheWriteLabel, cacheWriteTokens, cacheWriteRate, readBillingNumber(snapshot, "cache_write_billed_nanousd") || calcTokenBilledNanousd(cacheWriteTokens, cacheWriteRate), billingDisplay),
    ...serviceSection,
    { type: "divider" },
    totalLine,
  ];
  const noteLines: BillingTooltipLine[] = [];
  if (rateMultiplierNote) {
    noteLines.push({ type: "row", left: labels.rateNote, right: rateMultiplierNote });
  }
  if (cacheWriteNote) {
    noteLines.push({ type: "row", left: labels.cacheNote, right: cacheWriteNote });
  }
  if (noteLines.length > 0) {
    lines.splice(4, 0, ...noteLines);
  }
  return lines;
}

function BillingCostBadge({ item, billingDisplay }: { item: ChatMetaMessage; billingDisplay: BillingDisplayOptions }) {
  const t = useTranslations("chat.meta");
  const labels = useBillingMetaLabels();
  const cost = item.billingCost;
  if (!cost || cost.billingMode === "self") {
    return null;
  }
  const lines = billingTooltipLines(item, labels, billingDisplay);
  if (lines.length === 0) {
    return null;
  }
  const freeModel = parseBillingSnapshot(cost.pricingSnapshotJSON).is_free_model === true && !(cost.billedNanousd > 0);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={t("billingCost")}
          className="ml-0.5 inline-flex cursor-default items-center gap-1 rounded bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] leading-3.5 text-muted-foreground/70 select-none whitespace-nowrap outline-none focus-visible:bg-muted/50 focus-visible:ring-0"
        >
          {freeModel ? (
            <TicketSlash className="size-3" strokeWidth={1.4} />
          ) : (
            <CircleDollarSign className="size-3" strokeWidth={1.4} />
          )}
          {formatBillingCost(nanousdToUSD(cost.billedNanousd), billingDisplay)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-[min(92vw,44rem)]">
        <div className="min-w-72 space-y-1 text-left text-[11px] leading-relaxed">
          {lines.map((line, index) =>
            line.type === "divider" ? (
              <div key={`divider-${index}`} className="my-1 h-px bg-background/20" />
            ) : line.type === "tiered-table" ? (
              <TieredBillingTable key={`tiered-table-${index}`} line={line} />
            ) : (
              <div key={`${line.left}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-8">
                <span className="min-w-0 text-left">{line.left}</span>
                <span className="whitespace-nowrap text-right tabular-nums">{line.right}</span>
              </div>
            ),
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function TieredBillingTable({ line }: { line: Extract<BillingTooltipLine, { type: "tiered-table" }> }) {
  const t = useTranslations("chat.meta.billing.table");
  return (
    <div className="max-w-[min(92vw,34rem)] overflow-x-auto">
      <div className="mb-1 text-[10px] font-medium text-background/80">{line.rangeLabel}</div>
      <table className="w-full border-collapse text-left tabular-nums">
        <thead>
          <tr className="border-b border-background/20 text-[10px] text-background/65">
            <th className="whitespace-nowrap px-2 pb-1 font-medium first:pl-0" aria-label={t("item")} />
            <th className="whitespace-nowrap px-2 pb-1 text-right font-medium">{t("usage")}</th>
            <th className="whitespace-nowrap px-2 pb-1 text-right font-medium">{t("unitPrice")}</th>
            <th className="whitespace-nowrap px-2 pb-1 text-right font-medium last:pr-0">{t("amount")}</th>
          </tr>
        </thead>
        <tbody>
          {line.rows.map((row, rowIndex) => (
            <tr key={`${row.item}-${rowIndex}`} className="border-b border-background/10 last:border-0">
              <td className="whitespace-nowrap px-2 py-1 first:pl-0">{row.item}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right">{row.tokens}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right">{row.unitPrice}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right last:pr-0">{row.amount}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-background/20">
            <td className="px-2 pt-1.5 font-medium first:pl-0" colSpan={3}>{t("total")}</td>
            <td className="whitespace-nowrap px-2 pt-1.5 text-right font-medium last:pr-0">{line.totalAmount}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function QuickMemoryPin({ disabled }: { disabled?: boolean }) {
  const t = useTranslations("chat.messages");
  const resolveErrorMessage = useLocalizedErrorMessage();
  const [open, setOpen] = React.useState(false);
  const [key, setKey] = React.useState("");
  const [value, setValue] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const handleSave = React.useCallback(async () => {
    const trimmedKey = key.trim();
    const trimmedValue = value.trim();
    if (!trimmedKey || !trimmedValue) return;
    setSaving(true);
    try {
      const token = await resolveAccessToken();
      if (!token) {
        toast.error(t("authTokenMissing"));
        return;
      }
      await upsertUserMemory(token, trimmedKey, trimmedValue, "preference");
      toast.success(t("memorySaved"), { description: t("memorySavedDescription") });
      setKey("");
      setValue("");
      setOpen(false);
    } catch (error) {
      toast.error(t("memorySaveFailed"), { description: resolveErrorMessage(error) });
    } finally {
      setSaving(false);
    }
  }, [key, resolveErrorMessage, t, value]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSave();
      }
    },
    [handleSave],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-screenshot-exclude="true"
              className={META_ACTION_BUTTON_CLASSNAME}
              aria-label={t("rememberPreference")}
              disabled={disabled}
            >
              <Heart strokeWidth={1.8} animateOnHover="default" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t("rememberPreference")}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-64 p-3">
        <p className="mb-2 text-[12px] font-medium text-foreground">{t("rememberPreference")}</p>
        <div className="space-y-2">
          <Input
            placeholder={t("memoryNamePlaceholder")}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <Input
            placeholder={t("memoryValuePlaceholder")}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <Button
            size="sm"
            className="h-7 w-full text-[12px]"
            disabled={!key.trim() || !value.trim() || saving}
            onClick={() => void handleSave()}
          >
            {saving ? t("savingPreference") : t("savePreference")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function AssistantMessageMeta({
  item,
  busy,
  reaction,
  retrying = false,
  onCycleBranch,
  onSelectBranch,
  onRetry,
  onContinue,
  onEdit,
  onCopy,
  onFork,
  onDelete,
  deleting = false,
  copySucceeded = false,
  onReact,
  showModelInfo = true,
  showLatency = true,
  showTokenUsage = true,
  showBillingCost = false,
  billingDisplayCurrency = "USD",
  billingDisplayUsdToCnyRate = null,
  readOnly = false,
  alwaysVisible = false,
  showBranchNavigator = true,
}: {
  item: ChatMetaMessage;
  busy: boolean;
  reaction: AssistantReaction;
  /** 该消息的重试 run 进行中：按钮禁用并转圈，防止连点堆积并行任务。 */
  retrying?: boolean;
  onCycleBranch: (parentPublicID: string | null, direction: "previous" | "next") => void;
  onSelectBranch?: (parentPublicID: string | null, childPublicID: string) => void;
  onRetry: () => void;
  onContinue?: () => void;
  onEdit?: () => void;
  onCopy: () => void;
  onFork?: () => Promise<void> | void;
  /** 物理删除本条回复（含追问子树）：仅在确认对话框确认后触发。 */
  onDelete?: () => void;
  /** 删除请求进行中：按钮禁用并转圈。 */
  deleting?: boolean;
  copySucceeded?: boolean;
  onReact: (value: AssistantReaction) => void;
  showModelInfo?: boolean;
  showLatency?: boolean;
  showTokenUsage?: boolean;
  showBillingCost?: boolean;
  billingDisplayCurrency?: BillingDisplayCurrency;
  billingDisplayUsdToCnyRate?: number | null;
  readOnly?: boolean;
  alwaysVisible?: boolean;
  showBranchNavigator?: boolean;
}) {
  const t = useTranslations("chat.messages");
  const timeT = useTranslations("common.time");
  const isLive = Boolean(item.isPending || item.isStreaming);
  const timestamp = formatMessageTimestamp(
    isLive ? item.createdAt : item.updatedAt || item.createdAt,
    (key, values) => timeT(key, values),
  );
  const messagePending = Boolean(isLive || item.status?.trim().toLowerCase() === "pending");
  const hasPersistedMessage = Boolean(resolvePersistedPublicID(item.publicID));
  const canRetry = !readOnly && !messagePending && hasPersistedMessage;
  const canEdit = Boolean(canRetry && !busy && onEdit);
  const canContinue = Boolean(canRetry && !busy && item.status === "interrupted");
  const canFork = Boolean(canRetry && onFork);
  const canDelete = Boolean(canRetry && !busy && onDelete);
  // 多模型并行时顶部已有按模型聚合的 tab 条；底部切换器仅在无 tab，
  // 或同模型组内存在多个重试版本（tab 已归并）时展示，用于版本间导航。
  const hasModelTabs = (item.branchNavigator?.siblings?.length ?? 0) > 1;
  const modelVersionCount = item.branchNavigator?.modelSiblings?.length ?? 1;
  const canShowBranchNavigator = Boolean(
    showBranchNavigator && item.branchNavigator && (!hasModelTabs || modelVersionCount > 1),
  );
  const hasTokenUsage = Boolean(
    (item.inputTokens ?? 0) > 0 ||
    (item.outputTokens ?? 0) > 0 ||
    (item.cacheReadTokens ?? 0) > 0 ||
    (item.cacheWriteTokens ?? 0) > 0 ||
    (item.reasoningTokens ?? 0) > 0,
  );
  const hasLatencyBadge = Boolean(
    showLatency &&
    (
      isLive ||
      (item.latencyMS && item.latencyMS > 0) ||
      durationBetweenMS(item.createdAt, item.updatedAt) !== undefined
    ),
  );
  const hasDetailBadges = Boolean(
    (showModelInfo && item.platformModelName?.trim()) ||
    (showTokenUsage && hasTokenUsage) ||
    hasLatencyBadge ||
    item.editedAt ||
    (showBillingCost && item.billingCost && item.billingCost.billingMode !== "self"),
  );
  const billingDisplay = React.useMemo<BillingDisplayOptions>(
    () => ({
      currency: billingDisplayCurrency,
      usdToCnyRate: billingDisplayUsdToCnyRate,
    }),
    [billingDisplayCurrency, billingDisplayUsdToCnyRate],
  );
  const hasActionRow = Boolean(timestamp || !readOnly || canShowBranchNavigator);

  return (
    <MetaContainer align="start" alwaysVisible={alwaysVisible}>
      <div className="flex min-w-0 max-w-full flex-col items-start gap-1.5 pt-0.5">
        {hasDetailBadges ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
            {showModelInfo ? <ModelBadge label={item.platformModelName?.trim() || ""} /> : null}
            {showTokenUsage ? (
              <TokenBadge
                inputTokens={item.inputTokens}
                outputTokens={item.outputTokens}
                cacheReadTokens={item.cacheReadTokens}
                cacheWriteTokens={item.cacheWriteTokens}
                reasoningTokens={item.reasoningTokens}
              />
            ) : null}
            {hasLatencyBadge ? <LatencyBadge item={item} /> : null}
            {item.editedAt ? <EditedBadge /> : null}
            {showBillingCost ? <BillingCostBadge item={item} billingDisplay={billingDisplay} /> : null}
          </div>
        ) : null}
        {hasActionRow ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
            {!readOnly ? (
              <>
                <MetaIconButton
                  label={t("copyReply")}
                  disabled={!item.publicID}
                  onClick={onCopy}
                >
                  {copySucceeded ? (
                    <Check strokeWidth={1.8} animate="default" />
                  ) : (
                    <Copy strokeWidth={1.8} animateOnHover="default" />
                  )}
                </MetaIconButton>
                {canEdit ? (
                  <MetaIconButton
                    label={t("editReply")}
                    onClick={onEdit}
                  >
                    <Brush strokeWidth={1.8} animateOnHover="default" />
                  </MetaIconButton>
                ) : null}
                <MetaIconButton
                  label={t("likeReply")}
                  className={reaction === "up" ? "text-foreground" : undefined}
                  disabled={messagePending}
                  onClick={() => onReact(reaction === "up" ? null : "up")}
                >
                  <ThumbsUp strokeWidth={1.8} animateOnHover="default" />
                </MetaIconButton>
                <MetaIconButton
                  label={t("dislikeReply")}
                  className={reaction === "down" ? "text-foreground" : undefined}
                  disabled={messagePending}
                  onClick={() => onReact(reaction === "down" ? null : "down")}
                >
                  <ThumbsDown strokeWidth={1.8} animateOnHover="default" />
                </MetaIconButton>
                {canRetry ? (
                  <MetaIconButton
                    label={t("retryReply")}
                    disabled={retrying}
                    onClick={onRetry}
                  >
{retrying ? (
                      <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.8} />
                    ) : (
                      <RotateCcw strokeWidth={1.8} animateOnHover="default" />
                    )}
                  </MetaIconButton>
                ) : null}
                {canContinue && onContinue ? (
                  <MetaIconButton
                    label={t("continueReply")}
                    onClick={onContinue}
                  >
                    <Forward strokeWidth={1.8} />
                  </MetaIconButton>
                ) : null}
                {canFork && onFork ? (
                  <ForkMessageButton
                    label={t("forkMessage")}
                    onFork={onFork}
                  />
                ) : null}
                <QuickMemoryPin disabled={messagePending} />
                {canDelete && onDelete ? (
                  <MetaIconButton
                    label={t("deleteReply")}
                    className="hover:text-destructive"
                    disabled={deleting}
                    onClick={onDelete}
                  >
                    {deleting ? (
                      <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.8} />
                    ) : (
                      <Trash2 strokeWidth={1.8} />
                    )}
                  </MetaIconButton>
                ) : null}
              </>
            ) : null}
            {canShowBranchNavigator ? (
              <BranchSwitcher
                item={item}
                onCycle={onCycleBranch}
                navigationSiblings={hasModelTabs && modelVersionCount > 1 && onSelectBranch ? item.branchNavigator?.modelSiblings : undefined}
                onSelectBranch={onSelectBranch}
              />
            ) : null}
            <MessageTimestamp timestamp={timestamp} />
          </div>
        ) : null}
      </div>
    </MetaContainer>
  );
}
