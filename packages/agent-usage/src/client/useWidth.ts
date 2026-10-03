import { type RefObject, useEffect, useState } from "react"

/** The rendered width of an element, kept current as it resizes. */
export const useWidth = (ref: RefObject<HTMLElement | null>, fallback: number): number => {
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width
      if (measured !== undefined && measured > 0) setWidth(measured)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}
