import type { RlyDiffCodeViewHandle } from "@knpkv/rly/diff"
import { type ReactNode, type RefObject, useEffect } from "react"

/**
 * Own focus across lazy renderer replacements until the user takes focus or the request unmounts.
 * Failed attempts are mutation-driven; this component never polls an absent line.
 */
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
  readonly viewer: RlyDiffCodeViewHandle | null
}): ReactNode => {
  useEffect(() => {
    const rootElement = root.current
    if (rootElement === null || viewer === null) return

    let completed = false
    let focusFrame: number | undefined
    let applyingFocus = false
    const shadowObservers = new Map<ShadowRoot, MutationObserver>()
    const disconnect = (): void => {
      completed = true
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
      rootObserver.disconnect()
      for (const observer of shadowObservers.values()) observer.disconnect()
      shadowObservers.clear()
      rootElement.ownerDocument.removeEventListener("focusin", relinquishFocus, true)
      rootElement.ownerDocument.removeEventListener("keydown", relinquishFocus, true)
      rootElement.ownerDocument.removeEventListener("pointerdown", relinquishFocus, true)
    }
    const relinquishFocus = (): void => {
      if (!applyingFocus) disconnect()
    }
    const observeRendererRoots = (): void => {
      for (const [shadowRoot, observer] of shadowObservers) {
        if (rootElement.contains(shadowRoot.host)) continue
        observer.disconnect()
        shadowObservers.delete(shadowRoot)
      }
      for (const container of rootElement.querySelectorAll<HTMLElement>("diffs-container")) {
        const shadowRoot = container.shadowRoot
        if (shadowRoot === null || shadowObservers.has(shadowRoot)) continue
        const observer = new MutationObserver(scheduleFocus)
        observer.observe(shadowRoot, { childList: true, subtree: true })
        shadowObservers.set(shadowRoot, observer)
      }
    }
    const scheduleFocus = (): void => {
      if (completed || focusFrame !== undefined) return
      focusFrame = requestAnimationFrame(() => {
        focusFrame = undefined
        attemptFocus()
      })
    }
    const attemptFocus = (): void => {
      if (completed) return
      observeRendererRoots()
      const target: Parameters<RlyDiffCodeViewHandle["focusLine"]>[0] = {
        id: fileId,
        lineNumber,
        side,
        type: "line"
      }
      applyingFocus = true
      try {
        viewer.scrollTo(target)
        viewer.focusLine(target)
      } finally {
        applyingFocus = false
      }
    }
    const rootObserver = new MutationObserver(scheduleFocus)
    rootObserver.observe(rootElement, { childList: true, subtree: true })
    rootElement.ownerDocument.addEventListener("focusin", relinquishFocus, true)
    rootElement.ownerDocument.addEventListener("keydown", relinquishFocus, true)
    rootElement.ownerDocument.addEventListener("pointerdown", relinquishFocus, true)
    void customElements.whenDefined("diffs-container").then(scheduleFocus)
    attemptFocus()

    return disconnect
  }, [fileId, lineNumber, root, side, viewer])
  return null
}
