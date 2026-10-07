import { type RefCallback, useCallback, useState } from "react"

/** Below this container width a side-by-side diff leaves each code column too narrow to read. */
export const RLY_SPLIT_DIFF_MIN_WIDTH = 720

/**
 * Whether the element is laid out narrower than `width`, kept current with a ResizeObserver from the
 * element's own window. It measures in the commit phase, before paint, so a layout chosen from it
 * never shifts. An element not laid out yet (width 0, or no layout engine) counts as wide.
 */
export const useNarrowerThan = <E extends Element>(width: number): readonly [boolean, RefCallback<E>] => {
  const [narrow, setNarrow] = useState(false)
  const ref = useCallback(
    (element: E | null) => {
      if (element === null) return
      const measure = (): void => {
        const measured = element.getBoundingClientRect().width
        setNarrow(measured > 0 && measured < width)
      }
      measure()
      const view = element.ownerDocument.defaultView
      if (view === null || !("ResizeObserver" in view)) return
      const observer = new view.ResizeObserver(measure)
      observer.observe(element)
      return () => observer.disconnect()
    },
    [width]
  )
  return [narrow, ref]
}
