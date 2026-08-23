import type { GlobalChatMessage } from "@/features/global-chat/types/global-chat.types";

// 合并多来源消息（实时流 + 重连回放 + 乐观更新）：
// 按去重排序合并，pending 条目在服务端确认（相同内容）或冲突时移除。
export function mergeMessages(
  existing: GlobalChatMessage[],
  incoming: GlobalChatMessage[],
): GlobalChatMessage[] {
  if (incoming.length === 0) {
    return existing;
  }
  const byId = new Map<number, GlobalChatMessage>();
  for (const item of existing) {
    byId.set(item.id, item);
  }
  for (const item of incoming) {
    if (item.status === "confirmed") {
      byId.set(item.id, item);
    } else {
      byId.set(item.id, byId.get(item.id) ?? item);
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

// 移除与服务端确认消息重复的 pending 条目（按内容指纹匹配同作者的乐观消息）。
export function dropMatchingPending(
  messages: GlobalChatMessage[],
  confirmed: GlobalChatMessage,
): GlobalChatMessage[] {
  return messages.filter(
    (item) =>
      !(item.status === "pending" &&
        item.userId === confirmed.userId &&
        item.messageType === confirmed.messageType &&
        item.content === confirmed.content &&
        item.imageFileId === confirmed.imageFileId),
  );
}

export type GlobalChatMessageGroup = {
  dayKey: string;
  messages: GlobalChatMessage[];
};

// 按本地日期分组（升序），组内消息按 id 升序。
export function groupMessagesByDay(messages: GlobalChatMessage[]): GlobalChatMessageGroup[] {
  const groups: GlobalChatMessageGroup[] = [];
  let current: GlobalChatMessageGroup | null = null;
  for (const message of messages) {
    const dayKey = toDayKey(message.createdAt);
    if (!current || current.dayKey !== dayKey) {
      current = { dayKey, messages: [message] };
      groups.push(current);
      continue;
    }
    current.messages.push(message);
  }
  return groups;
}

function toDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDayLabel(dayKey: string, locale: string): string {
  const date = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return dayKey;
  }
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }).format(date);
}

export function formatMessageTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
}
