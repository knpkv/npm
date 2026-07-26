import { type ReactNode, type RefObject, useEffect } from "react"

/** Focus one lazily rendered immutable-diff line, waiting for its bounded renderer when necessary. */
export const DiffLineFocus = ({
  fileId,
  lineNumber,
  root
}: {
  readonly fileId: string
  readonly lineNumber: number
  readonly root: RefObject<HTMLElement | null>
}): ReactNode => {
  useEffect(() => {
    const focusLine = (): boolean => {
      const item = `[data-rly-diff-item="${CSS.escape(fileId)}"]`
      const line = root.current?.querySelector<HTMLElement>(
        `${item}[data-rly-diff-line="${String(lineNumber)}"][data-rly-diff-line-side="additions"]`
      )
      line?.focus({ preventScroll: true })
      return line !== null && line !== undefined
    }
    if (focusLine()) return
    const observer = new MutationObserver(() => {
      if (focusLine()) observer.disconnect()
    })
    if (root.current === null) return
    observer.observe(root.current, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [fileId, lineNumber, root])
  return null
}
