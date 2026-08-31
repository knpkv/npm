export interface TerminalViewportTarget {
  readonly style: Pick<CSSStyleDeclaration, "removeProperty" | "setProperty">
}

export interface TerminalVisualViewport extends EventTarget {
  readonly height: number
  readonly offsetTop: number
}

export interface TerminalViewportHost {
  readonly visualViewport?: TerminalVisualViewport | null
}

const viewportHeightProperty = "--connect-visual-viewport-height"
const viewportOffsetProperty = "--connect-visual-viewport-offset"

export const bindTerminalViewport = (
  target: TerminalViewportTarget,
  host: TerminalViewportHost
): () => void => {
  const viewport = host.visualViewport
  if (viewport === undefined || viewport === null) return () => undefined

  const update = (): void => {
    target.style.setProperty(viewportHeightProperty, `${String(Math.max(0, viewport.height))}px`)
    target.style.setProperty(viewportOffsetProperty, `${String(Math.max(0, viewport.offsetTop))}px`)
  }

  viewport.addEventListener("resize", update)
  viewport.addEventListener("scroll", update)
  update()

  return () => {
    viewport.removeEventListener("resize", update)
    viewport.removeEventListener("scroll", update)
    target.style.removeProperty(viewportHeightProperty)
    target.style.removeProperty(viewportOffsetProperty)
  }
}
