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
  return [...byId.values()].sort(compareMessages);
}

// 排序：confirmed 按自增 id 升序；pending（负数虚拟 id）排在所有 confirmed
// 之后——否则负数 id 会让乐观消息闪现在列表最顶端。两条 pending 之间按虚拟
// id 降序（id 递减分配，降序即发送顺序）。
function compareMessages(a: GlobalChatMessage, b: GlobalChatMessage): number {
  const aPending = a.status === "pending";
  const bPending = b.status === "pending";
  if (aPending !== bPending) {
    return aPending ? 1 : -1;
  }
  if (aPending) {
    return b.id - a.id;
  }
  return a.id - b.id;
}

// 移除与服务端确认消息对应的一条 pending（单次消除：连发相同内容或多设备
// 并发时只消最早一条，其余 pending 等各自的确认到达）。图片 pending 未携带
// fileId，按作者 + 类型匹配；文本按内容指纹。
export function dropMatchingPending(
  messages: GlobalChatMessage[],
  confirmed: GlobalChatMessage,
): GlobalChatMessage[] {
  const index = messages.findIndex(
    (item) =>
      item.status === "pending" &&
      item.userId === confirmed.userId &&
      item.messageType === confirmed.messageType &&
      (item.messageType === "image" || item.content === confirmed.content),
  );
  if (index < 0) {
    return messages;
  }
  return messages.filter((_, position) => position !== index);
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
