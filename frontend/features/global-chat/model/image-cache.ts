import { fetchGlobalChatImageContent } from "@/shared/api/global-chat";

// 全服聊天图片 blob 缓存：fileId -> objectURL。
// 聊天图片无法用 <img src> 直连（Bearer 鉴权），需 fetch blob 后转 objectURL。
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export function getCachedImageObjectURL(fileID: string): string | null {
  return cache.get(fileID) ?? null;
}

export async function loadGlobalChatImage(accessToken: string, fileID: string): Promise<string> {
  const cached = cache.get(fileID);
  if (cached) {
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
    return objectURL;
  })();
  inflight.set(fileID, task);
  try {
    return await task;
  } finally {
    inflight.delete(fileID);
  }
}
