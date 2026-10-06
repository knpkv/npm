import { type RefCallback, useCallback, useRef } from "react"

/**
 * Returns a callback ref that publishes the element's rendered block size as a custom property on
 * the document root, for sticky elements that must sit below it. The sticky app header uses it
 * (`--app-header-block-size`): its height changes with width, when it wraps onto two rows.
 */
export function usePublishedBlockSize<T extends HTMLElement = HTMLElement>(property: `--${string}`): RefCallback<T> {
  const observerRef = useRef<ResizeObserver | null>(null)

  return useCallback(
    (node: T | null) => {
      observerRef.current?.disconnect()
      observerRef.current = null
      const root = document.documentElement
      if (!node) {
        root.style.removeProperty(property)
        return
      }
      observerRef.current = new ResizeObserver((entries) => {
        const size = entries[0]?.borderBoxSize[0]?.blockSize
        if (size !== undefined) root.style.setProperty(property, `${Math.ceil(size)}px`)
      })
      observerRef.current.observe(node)
    },
    [property]
  )
}
