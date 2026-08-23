// 聊天室头像占位配色：自己的消息固定主题主色（与右侧气泡一致），
// 他人按 userId 稳定哈希取色——同一发言人颜色恒定，明暗主题各自适配对比度。
const AVATAR_COLOR_CLASSES = [
  "bg-rose-600 text-white dark:bg-rose-400 dark:text-rose-950",
  "bg-orange-600 text-white dark:bg-orange-400 dark:text-orange-950",
  "bg-amber-600 text-white dark:bg-amber-400 dark:text-amber-950",
  "bg-emerald-600 text-white dark:bg-emerald-400 dark:text-emerald-950",
  "bg-teal-600 text-white dark:bg-teal-400 dark:text-teal-950",
  "bg-sky-600 text-white dark:bg-sky-400 dark:text-sky-950",
  "bg-violet-600 text-white dark:bg-violet-400 dark:text-violet-950",
  "bg-fuchsia-600 text-white dark:bg-fuchsia-400 dark:text-fuchsia-950",
] as const;

// FNV-1a（算法形状同 shared/lib/avatar.ts 的 hashString），对 userId 字符串散列。
function hashUserId(userId: number): number {
  let hash = 2166136261;
  const input = String(userId);
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function getAvatarFallbackClassName(userId: number, isOwn: boolean): string {
  if (isOwn) {
    return "bg-primary text-primary-foreground";
  }
  return AVATAR_COLOR_CLASSES[hashUserId(userId) % AVATAR_COLOR_CLASSES.length];
}
