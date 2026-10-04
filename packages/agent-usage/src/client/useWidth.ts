import { useCallback, useEffect, useState } from "react"

/**
 * The rendered width of an element, kept current as it resizes. Returns a callback ref, so the
 * observation follows the element when it mounts later or is replaced.
 */
export const useWidth = (fallback: number): readonly [width: number, ref: (element: HTMLElement | null) => void] => {
  const [width, setWidth] = useState(fallback)
  const [element, setElement] = useState<HTMLElement | null>(null)
  const ref = useCallback((next: HTMLElement | null) => setElement(next), [])
  useEffect(() => {
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width
      if (measured !== undefined && measured > 0) setWidth(measured)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [width, ref]
}
