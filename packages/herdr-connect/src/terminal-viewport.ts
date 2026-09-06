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
  readonly document?: {
    readonly body: { readonly style: Pick<CSSStyleDeclaration, "cssText" | "setProperty"> }
    readonly documentElement: { readonly style: Pick<CSSStyleDeclaration, "cssText" | "setProperty"> }
  }
  readonly innerHeight?: number
  readonly scrollX?: number
  readonly scrollY?: number
  readonly visualViewport?: TerminalVisualViewport | null
  readonly scrollTo?: (x: number, y: number) => void
}

export type TerminalViewportCleanup = () => void

export interface TerminalViewportBindingState {
  readonly connectionRequested: boolean
  readonly focusRejected: boolean
  readonly terminalConnected: boolean
}

/** Keeps geometry installed for every state that can render the fixed terminal. */
export const terminalViewportBindingActive = ({
  connectionRequested,
  focusRejected,
  terminalConnected
}: TerminalViewportBindingState): boolean => connectionRequested || focusRejected || terminalConnected

const viewportHeightProperty = "--connect-visual-viewport-height"
const viewportOffsetProperty = "--connect-visual-viewport-offset"

interface TerminalDocumentLock {
  count: number
  readonly restore: () => void
}

const terminalDocumentLocks = new WeakMap<object, TerminalDocumentLock>()

const bindTerminalDocumentRelease = (
  host: TerminalViewportHost,
  lock: TerminalDocumentLock
): TerminalViewportCleanup => {
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    host.removeEventListener("pagehide", releaseOnPageHide)
    lock.count -= 1
    if (lock.count === 0) lock.restore()
  }
  const releaseOnPageHide = (event: Event): void => {
    if ("persisted" in event && event.persisted === true) return
    release()
  }
  try {
    host.addEventListener("pagehide", releaseOnPageHide)
  } catch (error) {
    lock.count -= 1
    if (lock.count === 0) lock.restore()
    throw error
  }
  return release
}

const acquireTerminalDocumentLock = (host: TerminalViewportHost): TerminalViewportCleanup => {
  const document = host.document
  if (document === undefined) return () => undefined
  const active = terminalDocumentLocks.get(document)
  if (active !== undefined) {
    active.count += 1
    return bindTerminalDocumentRelease(host, active)
  }

  const bodyStyle = document.body.style.cssText
  const documentStyle = document.documentElement.style.cssText
  const scrollX = host.scrollX ?? 0
  const scrollY = host.scrollY ?? 0
  let restoring = false
  const retainScroll = (): void => {
    if (restoring || (host.scrollX === scrollX && host.scrollY === scrollY)) return
    restoring = true
    host.scrollTo?.(scrollX, scrollY)
    restoring = false
  }
  const restore = (): void => {
    host.removeEventListener("scroll", retainScroll, true)
    terminalDocumentLocks.delete(document)
    document.documentElement.style.cssText = documentStyle
    document.body.style.cssText = bodyStyle
    host.scrollTo?.(scrollX, scrollY)
  }
  const lock: TerminalDocumentLock = { count: 1, restore }
  terminalDocumentLocks.set(document, lock)

  try {
    document.documentElement.style.setProperty("overflow", "hidden")
    document.body.style.setProperty("overflow", "hidden")
    host.addEventListener("scroll", retainScroll, true)
  } catch (error) {
    restore()
    throw error
  }

  return bindTerminalDocumentRelease(host, lock)
}

/** Locks document scroll and fits the terminal to the visual viewport until cleanup. */
export const bindTerminalViewport = (
  target: TerminalViewportTarget,
  host: TerminalViewportHost,
  topBoundary?: TerminalViewportBoundary,
  lockDocument = true
): TerminalViewportCleanup => {
  const releaseDocumentLock = lockDocument ? acquireTerminalDocumentLock(host) : () => undefined
  const viewport = host.visualViewport
  if ((viewport === undefined || viewport === null) && topBoundary === undefined) return releaseDocumentLock
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
  const releaseGeometry = (): void => {
    viewport?.removeEventListener("resize", update)
    viewport?.removeEventListener("scroll", update)
    if (topBoundary !== undefined) {
      host.removeEventListener("resize", update)
      host.removeEventListener("scroll", update, true)
      for (const ancestor of scrollAncestors) ancestor.removeEventListener("scroll", update, true)
    }
  }

  try {
    viewport?.addEventListener("resize", update)
    viewport?.addEventListener("scroll", update)
    if (topBoundary !== undefined) {
      host.addEventListener("resize", update)
      host.addEventListener("scroll", update, true)
      for (const ancestor of scrollAncestors) ancestor.addEventListener("scroll", update, true)
    }
    update()
  } catch (error) {
    releaseGeometry()
    releaseDocumentLock()
    throw error
  }

  let released = false
  return () => {
    if (released) return
    released = true
    try {
      releaseGeometry()
      target.style.removeProperty(viewportHeightProperty)
      target.style.removeProperty(viewportOffsetProperty)
    } finally {
      releaseDocumentLock()
    }
  }
}
