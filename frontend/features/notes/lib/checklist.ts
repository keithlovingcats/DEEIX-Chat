export type ChecklistStats = {
  done: number;
  total: number;
};

const CHECKLIST_PATTERN = /^[ \t]*[-*][ \t]+\[([ xX])\]/gm;

/** 统计 Markdown 内容里的任务清单勾选进度；无清单时返回 null。 */
export function countChecklist(content: string): ChecklistStats | null {
  if (!content) {
    return null;
  }
  let done = 0;
  let total = 0;
  for (const match of content.matchAll(CHECKLIST_PATTERN)) {
    total += 1;
    if (match[1].toLowerCase() === "x") {
      done += 1;
    }
  }
  return total > 0 ? { done, total } : null;
}

/** 去掉 Markdown 标记后的纯文本预览，截断到指定长度。 */
export function notePreview(content: string, maxLength = 120): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[ \t]*[-*][ \t]+\[[ xX]\][ \t]?/gm, "")
    .replace(/[#*_`>~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}…` : plain;
}

/** 标题为空时的默认建议：内容首个非空行，去掉 Markdown 前缀，截 50 字。 */
export function suggestTitle(content: string): string {
  const firstLine =
    content
      .split("\n")
      .map((line) => line.replace(/^[ \t]*[#>*\-+][ \t]*/, "").trim())
      .find((line) => line.length > 0) ?? "";
  return firstLine.slice(0, 50);
}
