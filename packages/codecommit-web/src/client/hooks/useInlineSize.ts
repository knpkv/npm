import { type RefCallback, useCallback, useRef, useState } from "react"

/**
 * Returns a callback ref and the element's current border-box inline size in CSS pixels,
 * `undefined` until the element attaches. For layout decisions that CSS container queries cannot make alone, such
 * as moving a pane into a dialog. The observer follows the ref callback lifecycle.
 */
export function useInlineSize<T extends HTMLElement = HTMLElement>(): readonly [RefCallback<T>, number | undefined] {
  const observerRef = useRef<ResizeObserver | null>(null)
  const [size, setSize] = useState<number | undefined>(undefined)

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (node === null) return
    // Measured at attach, inside the commit, so the first paint already uses the real width: a
    // layout chosen from it (Relay as column or drawer) never shifts in after the observer fires.
    setSize(Math.round(node.getBoundingClientRect().width))
    observerRef.current = new ResizeObserver((entries) => {
      const width = entries[0]?.borderBoxSize[0]?.inlineSize
      if (width !== undefined) setSize(Math.round(width))
    })
    observerRef.current.observe(node)
  }, [])

  return [ref, size]
}
