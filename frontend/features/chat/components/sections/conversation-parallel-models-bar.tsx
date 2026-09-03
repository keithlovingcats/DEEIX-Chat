"use client";

import { Ban, Check, MessageCircle, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_DISCUSSION_ROUNDS, MAX_DISCUSSION_MODELS, MAX_DISCUSSION_ROUNDS } from "@/features/chat/hooks/use-chat-discussion";
import { MAX_PARALLEL_MODELS } from "@/features/chat/hooks/use-chat-model-options";
import type { ChatModelOption } from "@/features/chat/types/chat-runtime";
import { cn } from "@/lib/utils";
import { ModelIcon } from "@/shared/components/model-icon";
import { resolveModelIconURL, resolveModelIdentity } from "@/shared/lib/model-identity";
import { resolveModelPresentationGroup } from "@/shared/lib/model-presentation";

const ADD_MENU_MAX_HEIGHT = 320;

function resolveModelGroups(modelOptions: ChatModelOption[]) {
  const groupMap = new Map<string, { label: string; icon: string; items: ChatModelOption[] }>();
  for (const item of modelOptions) {
    const presentation = resolveModelPresentationGroup(item);
    const group = groupMap.get(presentation.key);
    if (group) {
      group.items.push(item);
      continue;
    }
    groupMap.set(presentation.key, {
      label: presentation.label,
      icon: presentation.icon,
      items: [item],
    });
  }
  return Array.from(groupMap.entries()).map(([key, group]) => ({ key, ...group }));
}

/**
 * 对话区域顶部的当前并行模型条：每个选中模型一个 pill（可移除），
 * 末尾 + 按钮展开模型下拉，可继续加减模型。仅多模型（>1）时显示。
 */
export function ConversationParallelModelsBar({
  modelOptions,
  selectedPlatformModelNames,
  disabledPlatformModelNames,
  loading,
  disabled,
  onToggleParallelModel,
  onToggleParallelModelEnabled,
  onModelCatalogRefresh,
  discussionEnabled,
  onToggleDiscussion,
  discussionRounds,
  onChangeDiscussionRounds,
  className,
}: {
  modelOptions: ChatModelOption[];
  selectedPlatformModelNames: string[];
  /** jun 定制（多模型禁用）：临时退出 fan-out/讨论的附加模型名单（主模型不可禁用）。 */
  disabledPlatformModelNames?: string[];
  loading?: boolean;
  disabled?: boolean;
  onToggleParallelModel?: (platformModelName: string) => boolean;
  /** 启用/禁用附加模型；返回 false 表示不可禁用（主模型）。 */
  onToggleParallelModelEnabled?: (platformModelName: string) => boolean;
  onModelCatalogRefresh?: () => void | Promise<void>;
  /** 多模型讨论：启用后发送改为串行辩论（≥2 个模型才可开）。 */
  discussionEnabled?: boolean;
  onToggleDiscussion?: (enabled: boolean) => void;
  discussionRounds?: number;
  onChangeDiscussionRounds?: (rounds: number) => void;
  className?: string;
}) {
  const t = useTranslations("chat.modelPicker");
  const [open, setOpen] = React.useState(false);
  const [roundsOpen, setRoundsOpen] = React.useState(false);
  const selectedNames = React.useMemo(
    () => Array.from(new Set(selectedPlatformModelNames.map((name) => name.trim()).filter(Boolean))),
    [selectedPlatformModelNames],
  );
  const disabledNames = React.useMemo(
    () => new Set((disabledPlatformModelNames ?? []).map((name) => name.trim()).filter(Boolean)),
    [disabledPlatformModelNames],
  );
  const [activeGroupKey, setActiveGroupKey] = React.useState("");
  const modelGroups = React.useMemo(() => resolveModelGroups(modelOptions), [modelOptions]);
  const activeGroup = React.useMemo(
    () => modelGroups.find((group) => group.key === activeGroupKey) ?? modelGroups[0] ?? null,
    [activeGroupKey, modelGroups],
  );

  // 与输入框选择器一致：只要有选中模型就展示（新会话默认 1 个也显示），空态才隐藏。
  if (selectedNames.length === 0 && !(loading && modelOptions.length === 0)) {
    return null;
  }

  // 讨论预估调用次数：参与者 × 轮次 + 1 次终稿（不含终稿失败重试）。
  const discussionCallCount =
    Math.min(selectedNames.length, MAX_DISCUSSION_MODELS) * (discussionRounds ?? DEFAULT_DISCUSSION_ROUNDS) + 1;

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen && onModelCatalogRefresh) {
      void Promise.resolve(onModelCatalogRefresh()).catch(() => undefined);
    }
    setOpen(nextOpen);
  };

  const toggleModel = (platformModelName: string) => {
    if (!onToggleParallelModel) {
      return;
    }
    const accepted = onToggleParallelModel(platformModelName);
    if (!accepted) {
      // 与输入框选择器一致：触达并行上限或移除最后一个模型时提示原因。
      toast.error(t("parallelModelLimit"), {
        description: t("parallelModelLimitDescription", { count: MAX_PARALLEL_MODELS }),
      });
    }
  };

  return (
    <div
      className={cn("flex min-w-0 items-center gap-1.5", className)}
      data-screenshot-exclude="true"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {loading && modelOptions.length === 0
          ? [0, 1].map((index) => <Skeleton key={index} className="h-6 w-20 rounded-full bg-muted/40" />)
          : selectedNames.map((name, index) => {
              const option = modelOptions.find((item) => item.platformModelName === name);
              const iconURL = option
                ? resolveModelIconURL(
                    resolveModelIdentity({ code: option.platformModelName, vendor: option.vendor, icon: option.icon }).modelIcon,
                  )
                : resolveModelIconURL(resolveModelIdentity({ code: name }).modelIcon);
              // 首位是主模型（发送模型），不可禁用；其余附加模型可临时退出对话。
              const isPrimary = index === 0;
              const modelDisabled = disabledNames.has(name);
              return (
                <span
                  key={name}
                  title={modelDisabled ? `${name} · ${t("parallelModelDisabledHint")}` : name}
                  className={cn(
                    "inline-flex h-6 max-w-44 items-center gap-1 rounded-full border-[0.5px] pl-1.5 pr-1 text-[11px] font-medium transition-opacity",
                    modelDisabled
                      ? "border-dashed border-border bg-muted/20 text-muted-foreground/70"
                      : "border-border bg-muted/40 text-foreground",
                  )}
                >
                  <ModelIcon iconUrl={iconURL} label={name} />
                  <span className="truncate">{name}</span>
                  {!isPrimary && onToggleParallelModelEnabled ? (
                    <button
                      type="button"
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted disabled:opacity-40",
                        modelDisabled
                          ? "text-primary/80 hover:text-primary"
                          : "text-muted-foreground/70 hover:text-foreground",
                      )}
                      aria-label={modelDisabled ? t("enableParallelModel") : t("disableParallelModel")}
                      title={modelDisabled ? t("enableParallelModel") : t("disableParallelModel")}
                      disabled={disabled}
                      onClick={() => onToggleParallelModelEnabled(name)}
                    >
                      <Ban className="size-3" strokeWidth={2} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                    aria-label={t("removeParallelModel")}
                    disabled={disabled}
                    onClick={() => toggleModel(name)}
                  >
                    <X className="size-3" strokeWidth={2} />
                  </button>
                </span>
              );
            })}
      </div>
      {selectedNames.length >= 2 && onToggleDiscussion ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-full border-[0.5px] border-border pl-2 pr-1 text-[11px] font-medium transition-colors",
              discussionEnabled
                ? "bg-primary/10 text-primary"
                : "bg-muted/40 text-muted-foreground",
            )}
            title={t("discussionCallsHint", { count: discussionCallCount })}
          >
            <MessageCircle className="size-3" strokeWidth={2} />
            <span className="truncate">{t("discussionToggle")}</span>
            <Switch
              size="sm"
              checked={Boolean(discussionEnabled)}
              disabled={disabled}
              onCheckedChange={(checked) => onToggleDiscussion(checked)}
              aria-label={t("discussionToggle")}
            />
          </span>
          {discussionEnabled && onChangeDiscussionRounds ? (
            <Popover open={roundsOpen} onOpenChange={setRoundsOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-6 items-center rounded-full border-[0.5px] border-border bg-muted/40 px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
                  disabled={disabled}
                >
                  {t("discussionRoundsCount", { count: discussionRounds ?? 2 })}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" side="bottom" sideOffset={6} className="w-40 rounded-xl border-[0.5px] border-border bg-popover p-1.5 shadow-xs">
                {Array.from({ length: MAX_DISCUSSION_ROUNDS }, (_, index) => index + 1).map((rounds) => (
                  <button
                    key={rounds}
                    type="button"
                    className={cn(
                      "flex h-7 w-full items-center justify-between rounded-md px-2 text-left text-[11px] font-medium outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                      rounds === discussionRounds ? "text-foreground" : "text-muted-foreground",
                    )}
                    onClick={() => {
                      onChangeDiscussionRounds(rounds);
                      setRoundsOpen(false);
                    }}
                  >
                    <span>{t("discussionRoundsCount", { count: rounds })}</span>
                    {rounds === discussionRounds ? <Check className="size-3 text-current" strokeWidth={1.7} /> : null}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          ) : null}
          {/* 调用规模常显提示：20 模型 × 5 轮达 100+ 次串行调用，不能只
              藏在开关的 hover title 里，调轮数时要一目了然。 */}
          {discussionEnabled ? (
            <span
              className="inline-flex h-6 shrink-0 items-center rounded-full bg-muted/40 px-2 text-[11px] font-medium tabular-nums text-muted-foreground"
              title={t("discussionCallsHint", { count: discussionCallCount })}
            >
              {t("discussionCallCount", { count: discussionCallCount })}
            </span>
          ) : null}
        </div>
      ) : null}
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border-[0.5px] border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/40 hover:bg-muted/50 hover:text-foreground disabled:opacity-40"
            aria-label={t("addParallelModel")}
            title={t("addParallelModel")}
            disabled={disabled}
          >
            <Plus className="size-3.5" strokeWidth={2} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          collisionPadding={16}
          className="w-64 overflow-hidden rounded-xl border-[0.5px] border-border bg-popover p-1.5 shadow-xs"
        >
          <div className="flex h-7 shrink-0 items-center justify-between gap-2 px-1.5 pb-1">
            <span className="text-[11px] font-medium text-foreground">{t("parallelGroup")}</span>
            <span className="text-[10px] font-medium text-muted-foreground">
              {t("parallelCount", { count: selectedNames.length })}
            </span>
          </div>
          <div className="min-h-0 overflow-y-auto" style={{ maxHeight: ADD_MENU_MAX_HEIGHT }}>
            {modelGroups.length === 0 ? (
              <div className="px-2 py-3 text-[11px] leading-4 text-muted-foreground">{t("empty")}</div>
            ) : (
              modelGroups.map((group) => {
                const groupIconURL = resolveModelIconURL(group.icon);
                const expanded = activeGroup?.key === group.key;
                return (
                  <div key={group.key} className="mb-0.5">
                    <button
                      type="button"
                      className={cn(
                        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[11px] font-medium outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                        expanded ? "text-foreground" : "text-muted-foreground",
                      )}
                      onClick={() => setActiveGroupKey(expanded ? "" : group.key)}
                    >
                      <ModelIcon iconUrl={groupIconURL} label={group.label} />
                      <span className="min-w-0 flex-1 truncate">{group.label}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/80">
                        {group.items.length}
                      </span>
                    </button>
                    {expanded
                      ? group.items.map((item) => {
                          const selected = selectedNames.includes(item.platformModelName);
                          const itemIconURL = resolveModelIconURL(
                            resolveModelIdentity({ code: item.platformModelName, vendor: item.vendor, icon: item.icon }).modelIcon,
                          );
                          return (
                            <button
                              key={item.platformModelName}
                              type="button"
                              className={cn(
                                "flex h-7 w-full items-center gap-2 rounded-md pl-4 pr-2 text-left text-[11px] font-medium outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                                selected ? "text-foreground" : "text-muted-foreground",
                              )}
                              onClick={() => toggleModel(item.platformModelName)}
                            >
                              <ModelIcon iconUrl={itemIconURL} label={item.platformModelName} />
                              <span className="min-w-0 flex-1 truncate">{item.platformModelName}</span>
                              <span className="flex size-3.5 shrink-0 items-center justify-center">
                                {selected ? <Check className="size-3 text-current" strokeWidth={1.7} /> : null}
                              </span>
                            </button>
                          );
                        })
                      : null}
                  </div>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
