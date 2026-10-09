import { type RefCallback, useCallback, useRef } from "react"

/**
 * A callback ref that publishes the element's rendered block size as a custom property on the document
 * root: the sticky header (Relay's panel starts below it) and the phone navigation docked at the bottom
 * (Relay's panel ends above it).
 */
export const usePublishedBlockSize = <Element extends HTMLElement = HTMLElement>(
  property: `--${string}`
): RefCallback<Element> => {
  const observer = useRef<ResizeObserver | null>(null)
  return useCallback(
    (node: Element | null) => {
      observer.current?.disconnect()
      observer.current = null
      const root = document.documentElement
      if (node === null) {
        root.style.removeProperty(property)
        return
      }
      observer.current = new ResizeObserver((entries) => {
        const size = entries[0]?.borderBoxSize[0]?.blockSize
        if (size !== undefined) root.style.setProperty(property, `${String(Math.ceil(size))}px`)
      })
      observer.current.observe(node)
    },
    [property]
  )
}
