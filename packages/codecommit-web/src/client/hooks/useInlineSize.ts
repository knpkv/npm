import { type RefCallback, useCallback, useRef, useState } from "react"

/**
 * Returns a callback ref and the element's current inline size in CSS pixels, `undefined` until
 * the first measurement. For layout decisions that CSS container queries cannot make alone, such
 * as moving a pane into a dialog. The observer follows the ref callback lifecycle.
 */
export function useInlineSize<T extends HTMLElement = HTMLElement>(): readonly [RefCallback<T>, number | undefined] {
  const observerRef = useRef<ResizeObserver | null>(null)
  const [size, setSize] = useState<number | undefined>(undefined)

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (node === null) return
    observerRef.current = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width !== undefined) setSize(Math.round(width))
    })
    observerRef.current.observe(node)
  }, [])

  return [ref, size]
}
