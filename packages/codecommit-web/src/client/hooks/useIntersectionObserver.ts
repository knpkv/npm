import { type RefObject, useCallback, useRef } from "react"

/**
 * Returns a callback ref that fires `onIntersect` when the element enters the viewport.
 * No useEffect — the observer is managed via the ref callback lifecycle.
 */
export function useIntersectionObserver<T extends HTMLElement = HTMLElement>(
  onIntersect: () => void,
  options?: IntersectionObserverInit
): RefObject<T | null> {
  const observerRef = useRef<IntersectionObserver | null>(null)
  const callbackRef = useRef(onIntersect)
  callbackRef.current = onIntersect

  const ref = useCallback(
    (node: T | null) => {
      observerRef.current?.disconnect()
      observerRef.current = null

      if (!node) return

      observerRef.current = new IntersectionObserver((entries) => {
        if (entries[0]?.isIntersecting) {
          callbackRef.current()
        }
      }, options)
      observerRef.current.observe(node)
    },
    [JSON.stringify(options)]
  )

  return ref as unknown as RefObject<T | null>
}
