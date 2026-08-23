"use client"

import * as React from "react"

// IME 组合态守卫：输入法按 Enter 确认候选词时不应触发提交。
// composingRef 兜底 Safari 等 compositionend 早于/晚于 keydown 的时序差异；
// key === "Process" 与 keyCode === 229 覆盖部分浏览器（尤其 Android IME）
// 在组合期间上报的 keydown 形态。
export function useImeCompositionGuard() {
  const composingRef = React.useRef(false)

  const compositionProps = React.useMemo(
    () => ({
      onCompositionStart: () => {
        composingRef.current = true
      },
      onCompositionEnd: () => {
        composingRef.current = false
      },
    }),
    [],
  )

  const isComposing = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    return (
      event.nativeEvent.isComposing ||
      composingRef.current ||
      event.key === "Process" ||
      event.keyCode === 229
    )
  }, [])

  return { compositionProps, isComposing }
}
