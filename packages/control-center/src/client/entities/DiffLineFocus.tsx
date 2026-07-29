import type { RlyDiffCodeViewHandle } from "@knpkv/rly/diff"
import { type ReactNode, type RefObject, useEffect } from "react"

/** Focus one lazily rendered immutable-diff line after the renderer scrolls it into view. */
export const DiffLineFocus = ({
  fileId,
  lineNumber,
  root,
  side,
  viewer
}: {
  readonly fileId: string
  readonly lineNumber: number
  readonly root: RefObject<HTMLElement | null>
  readonly side: "additions" | "deletions"
  readonly viewer: RefObject<RlyDiffCodeViewHandle | null>
}): ReactNode => {
  useEffect(() => {
    viewer.current?.scrollTo({
      id: fileId,
      lineNumber,
      side,
      type: "line"
    })
    const focusLine = (): boolean => {
      const item = `[data-rly-diff-item="${CSS.escape(fileId)}"]`
      const boundedLine = root.current?.querySelector<HTMLElement>(
        `${item}[data-rly-diff-line="${String(lineNumber)}"][data-rly-diff-line-side="${side}"]`
      )
      if (boundedLine !== null && boundedLine !== undefined) {
        boundedLine.focus({ preventScroll: true })
        return document.activeElement === boundedLine
      }
      for (const container of root.current?.querySelectorAll<HTMLElement>("diffs-container") ?? []) {
        const line = container.shadowRoot?.querySelector<HTMLElement>(
          `[data-code][data-${side}] [data-line="${String(lineNumber)}"]`
        )
        if (line === null || line === undefined) continue
        line.tabIndex = -1
        line.focus({ preventScroll: true })
        return container.shadowRoot?.activeElement === line
      }
      return false
    }
    focusLine()
    let attempts = 0
    const retry = window.setInterval(() => {
      attempts += 1
      if (focusLine() || attempts >= 20) window.clearInterval(retry)
    }, 50)
    return () => window.clearInterval(retry)
  }, [fileId, lineNumber, root, side, viewer])
  return null
}
