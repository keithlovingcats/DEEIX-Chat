import { fetchGlobalChatImageContent } from "@/shared/api/global-chat";

// 全服聊天图片 blob 缓存：fileId -> objectURL。
// 聊天图片无法用 <img src> 直连（Bearer 鉴权），需 fetch blob 后转 objectURL。
// LRU 上限：超出后 revoke 并淘汰最早条目，避免长会话 objectURL 无界增长；
// 被淘汰图片再次渲染时会重新拉取。
const MAX_CACHE_ENTRIES = 200;

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export function getCachedImageObjectURL(fileID: string): string | null {
  return cache.get(fileID) ?? null;
}

export async function loadGlobalChatImage(accessToken: string, fileID: string): Promise<string> {
  const cached = cache.get(fileID);
  if (cached) {
    touch(fileID);
    return cached;
  }
  const pending = inflight.get(fileID);
  if (pending) {
    return pending;
  }
  const task = (async () => {
    const result = await fetchGlobalChatImageContent(accessToken, fileID);
    const objectURL = URL.createObjectURL(result.blob);
    cache.set(fileID, objectURL);
    evictIfNeeded();
    return objectURL;
  })();
  inflight.set(fileID, task);
  try {
    return await task;
  } finally {
    inflight.delete(fileID);
  }
}

// Map 迭代顺序即插入顺序：删除再写入实现 LRU touch。
function touch(fileID: string) {
  const value = cache.get(fileID);
  if (value == null) {
    return;
  }
  cache.delete(fileID);
  cache.set(fileID, value);
}

function evictIfNeeded() {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      return;
    }
    const [key, url] = [oldest.value, cache.get(oldest.value)!];
    cache.delete(key);
    URL.revokeObjectURL(url);
  }
}
