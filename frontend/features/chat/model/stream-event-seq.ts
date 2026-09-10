// 流事件断点：记录每个 run 的原始流最近收到的 NDJSON 事件 seq。
// 断线重连（resume）时以它作为 afterSeq 起点，从真实断点续传而非从 0 全量
// 回放——全量回放会重发 message_created，多模型讨论场景将触发误导性的
// 「讨论已中断」提示（实际只是瞬时断流，模型回复由 resume 正常补完）。
// 模块级存储随页面刷新清空：刷新后只能从 0 回放，此时的中断提示是正确语义
//（前端编排器确已丢失）。
const streamEventSeqCheckpoints = new Map<string, number>();

export function recordStreamEventSeq(runID: string, seq: number): void {
  const normalized = runID.trim();
  if (!normalized || seq <= 0) {
    return;
  }
  const current = streamEventSeqCheckpoints.get(normalized) ?? 0;
  if (seq > current) {
    streamEventSeqCheckpoints.set(normalized, seq);
  }
}

export function peekStreamEventSeq(runID: string): number {
  return streamEventSeqCheckpoints.get(runID.trim()) ?? 0;
}

export function clearStreamEventSeq(runID: string): void {
  streamEventSeqCheckpoints.delete(runID.trim());
}
