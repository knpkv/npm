export interface TerminalViewportTarget {
  readonly style: Pick<CSSStyleDeclaration, "removeProperty" | "setProperty">
}

export interface TerminalViewportScrollAncestor extends EventTarget {
  readonly parentElement?: TerminalViewportScrollAncestor | null
}

export interface TerminalViewportBoundary {
  readonly getBoundingClientRect: () => Pick<DOMRect, "top">
  readonly parentElement?: TerminalViewportScrollAncestor | null
}

export interface TerminalVisualViewport extends EventTarget {
  readonly height: number
  readonly offsetTop: number
}

export interface TerminalViewportHost extends EventTarget {
  readonly innerHeight?: number
  readonly visualViewport?: TerminalVisualViewport | null
}

export type TerminalViewportCleanup = () => void

const viewportHeightProperty = "--connect-visual-viewport-height"
const viewportOffsetProperty = "--connect-visual-viewport-offset"

export const bindTerminalViewport = (
  target: TerminalViewportTarget,
  host: TerminalViewportHost,
  topBoundary?: TerminalViewportBoundary
): TerminalViewportCleanup => {
  const viewport = host.visualViewport
  if ((viewport === undefined || viewport === null) && topBoundary === undefined) return () => undefined
  const scrollAncestors: Array<TerminalViewportScrollAncestor> = []
  let scrollAncestor = topBoundary?.parentElement ?? null
  while (scrollAncestor !== null) {
    scrollAncestors.push(scrollAncestor)
    scrollAncestor = scrollAncestor.parentElement ?? null
  }

  const update = (): void => {
    const viewportTop = Math.max(0, viewport?.offsetTop ?? 0)
    const viewportHeight = Math.max(0, viewport?.height ?? host.innerHeight ?? 0)
    const viewportBottom = viewportTop + viewportHeight
    const boundaryTop = Math.max(viewportTop, topBoundary?.getBoundingClientRect().top ?? viewportTop)
    target.style.setProperty(viewportHeightProperty, `${String(Math.max(0, viewportBottom - boundaryTop))}px`)
    target.style.setProperty(viewportOffsetProperty, `${String(boundaryTop)}px`)
  }

  viewport?.addEventListener("resize", update)
  viewport?.addEventListener("scroll", update)
  if (topBoundary !== undefined) {
    host.addEventListener("resize", update)
    host.addEventListener("scroll", update, true)
    for (const ancestor of scrollAncestors) ancestor.addEventListener("scroll", update, true)
  }
  update()

  return () => {
    viewport?.removeEventListener("resize", update)
    viewport?.removeEventListener("scroll", update)
    if (topBoundary !== undefined) {
      host.removeEventListener("resize", update)
      host.removeEventListener("scroll", update, true)
      for (const ancestor of scrollAncestors) ancestor.removeEventListener("scroll", update, true)
    }
    target.style.removeProperty(viewportHeightProperty)
    target.style.removeProperty(viewportOffsetProperty)
  }
}
