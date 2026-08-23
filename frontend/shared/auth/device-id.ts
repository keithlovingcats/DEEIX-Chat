// 设备指纹：localStorage 持久化 UUID，跨登录会话稳定。
// 用于全服聊天等场景区分「本设备」与「同账号其他设备」——比 sessionID 更符合
// 设备语义（退出重登不变；同一浏览器多标签页共享；清缓存/无痕降级为新设备）。
export const DEVICE_ID_STORAGE_KEY = "deeix-chat:device-id";

// 读取（不存在则生成并写入）本设备 ID。SSR 与 localStorage 不可用（无痕禁用等）
// 场景返回空串，调用方回退按 userId 判定。
export function readDeviceId(): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing) {
      return existing;
    }
    const generated =
      typeof window.crypto?.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return "";
  }
}
