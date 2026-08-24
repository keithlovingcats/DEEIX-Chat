// 展开折叠内容（代码块 / 长用户消息）时的视口稳定处理。
//
// 问题：视口贴底（距底 ≤ 阈值）时点击展开，内容长高后滚动容器会保持贴底
// （滚动锚定的 bottom-anchoring / 消息滚动器的跟底模式），视口被拉到对话
// 最底部，而不是停在用户正在阅读的消息处。
//
// 处理：
// 1. 点击展开时若视口贴底，先上移一小段退出贴底状态，让视口在内容长高后保持不动；
// 2. 展开（约 400ms）后，若消息底部在视口外，以最小位移把它滚进视口，
//    符合"滚到本条消息底部"的阅读预期（收起操作不处理，原生行为已合理）。

const STICK_TO_BOTTOM_THRESHOLD_PX = 48;
const UNSTICK_OFFSET_PX = 60;
const EXPAND_TRANSITION_SETTLE_MS = 400;

export function stabilizeViewportOnExpand(source: HTMLElement | null) {
  const message = source?.closest<HTMLElement>("[data-message-id]");
  if (!message) {
    return;
  }
  const viewport = message.closest<HTMLElement>("[data-slot='message-scroller-viewport']");
  if (viewport) {
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD_PX) {
      viewport.scrollTop -= UNSTICK_OFFSET_PX;
    }
  }
  window.setTimeout(() => {
    if (!message.isConnected) {
      return;
    }
    const rect = message.getBoundingClientRect();
    const viewportRect = viewport?.isConnected
      ? viewport.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };
    if (rect.bottom <= viewportRect.bottom) {
      return;
    }
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    message.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  }, EXPAND_TRANSITION_SETTLE_MS);
}
