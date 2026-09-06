import { describe, expect, it } from "@effect/vitest"
import {
  bindTerminalViewport,
  terminalViewportBindingActive,
  type TerminalViewportHost,
  type TerminalVisualViewport
} from "../src/terminal-viewport.js"

class FakeStyle implements Pick<CSSStyleDeclaration, "removeProperty" | "setProperty"> {
  readonly values = new Map<string, string>()

  removeProperty(name: string): string {
    const previous = this.values.get(name) ?? ""
    this.values.delete(name)
    return previous
  }

  setProperty(name: string, value: string): void {
    this.values.set(name, value)
  }
}

class FakeVisualViewport extends EventTarget implements TerminalVisualViewport {
  height: number
  offsetTop: number

  constructor({ height, offsetTop }: { readonly height: number; readonly offsetTop: number }) {
    super()
    this.height = height
    this.offsetTop = offsetTop
  }

  moveTo({ height, offsetTop }: { readonly height: number; readonly offsetTop: number }): void {
    this.height = height
    this.offsetTop = offsetTop
  }
}

class TrackedVisualViewport extends FakeVisualViewport {
  listenerCount = 0

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    super.addEventListener(type, callback, options)
    this.listenerCount += 1
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean
  ): void {
    super.removeEventListener(type, callback, options)
    this.listenerCount -= 1
  }
}

class FakeDocumentStyle implements Pick<CSSStyleDeclaration, "cssText" | "setProperty"> {
  constructor(public cssText: string) {}

  setProperty(name: string, value: string): void {
    this.cssText = `${this.cssText} ${name}: ${value};`.trim()
  }
}

class FakeClassList implements Pick<DOMTokenList, "add" | "contains" | "remove"> {
  readonly values = new Set<string>()

  add(...tokens: Array<string>): void {
    for (const token of tokens) this.values.add(token)
  }

  contains(token: string): boolean {
    return this.values.has(token)
  }

  remove(...tokens: Array<string>): void {
    for (const token of tokens) this.values.delete(token)
  }
}

class FakeTerminalViewportHost extends EventTarget implements TerminalViewportHost {
  readonly innerHeight: number | undefined
  readonly visualViewport: TerminalVisualViewport | null | undefined

  constructor(visualViewport?: TerminalVisualViewport | null, innerHeight?: number) {
    super()
    this.innerHeight = innerHeight
    this.visualViewport = visualViewport
  }
}

class FakeDocumentHost extends FakeTerminalViewportHost {
  readonly bodyStyle = new FakeDocumentStyle("overflow: visible; touch-action: pan-x;")
  readonly bodyClassList = new FakeClassList()
  readonly documentStyle = new FakeDocumentStyle("color: canvastext;")
  readonly documentClassList = new FakeClassList()
  readonly document = {
    body: { classList: this.bodyClassList, style: this.bodyStyle },
    documentElement: { classList: this.documentClassList, style: this.documentStyle }
  }
  scrollX = 3
  scrollY = 137

  scrollTo(x: number, y: number): void {
    this.scrollX = x
    this.scrollY = y
  }

  moveScrollTo(x: number, y: number): void {
    this.scrollX = x
    this.scrollY = y
    this.dispatchEvent(new Event("scroll"))
  }
}

const viewportHeightProperty = "--connect-visual-viewport-height"
const viewportOffsetProperty = "--connect-visual-viewport-offset"

describe("terminal visual viewport", () => {
  it("retains geometry while focus rejection keeps the terminal visible", () => {
    expect(
      terminalViewportBindingActive({ connectionRequested: false, focusRejected: true, terminalConnected: false })
    ).toBe(true)
    expect(
      terminalViewportBindingActive({ connectionRequested: false, focusRejected: false, terminalConnected: false })
    ).toBe(false)
  })

  it("keeps an embedded terminal between Fleet navigation and the keyboard", () => {
    const style = new FakeStyle()
    const viewport = new FakeVisualViewport({ height: 338, offsetTop: 162 })
    const host = new FakeTerminalViewportHost(viewport)
    const scrollAncestor = new EventTarget()
    let boundaryTop = 252
    const boundary = { getBoundingClientRect: () => ({ top: boundaryTop }), parentElement: scrollAncestor }
    const cleanup = bindTerminalViewport({ style }, host, boundary)

    expect(style.values).toEqual(
      new Map([
        [viewportHeightProperty, "248px"],
        [viewportOffsetProperty, "252px"]
      ])
    )

    viewport.moveTo({ height: 500, offsetTop: 0 })
    viewport.dispatchEvent(new Event("resize"))
    expect(style.values.get(viewportHeightProperty)).toBe("248px")
    expect(style.values.get(viewportOffsetProperty)).toBe("252px")

    boundaryTop = 200
    scrollAncestor.dispatchEvent(new Event("scroll"))
    expect(style.values.get(viewportHeightProperty)).toBe("300px")
    expect(style.values.get(viewportOffsetProperty)).toBe("200px")

    cleanup()
  })

  it("tracks keyboard height, Safari offset, rotation, and keyboard close", () => {
    const style = new FakeStyle()
    const viewport = new FakeVisualViewport({ height: 844, offsetTop: 0 })
    const cleanup = bindTerminalViewport({ style }, new FakeTerminalViewportHost(viewport))

    expect(style.values).toEqual(
      new Map([
        [viewportHeightProperty, "844px"],
        [viewportOffsetProperty, "0px"]
      ])
    )

    viewport.moveTo({ height: 493, offsetTop: 51 })
    viewport.dispatchEvent(new Event("resize"))
    expect(style.values.get(viewportHeightProperty)).toBe("493px")
    expect(style.values.get(viewportOffsetProperty)).toBe("51px")

    viewport.moveTo({ height: 390, offsetTop: 18 })
    viewport.dispatchEvent(new Event("resize"))
    expect(style.values.get(viewportHeightProperty)).toBe("390px")
    expect(style.values.get(viewportOffsetProperty)).toBe("18px")

    viewport.moveTo({ height: 390, offsetTop: 32 })
    viewport.dispatchEvent(new Event("scroll"))
    expect(style.values.get(viewportOffsetProperty)).toBe("32px")

    viewport.moveTo({ height: 844, offsetTop: 0 })
    viewport.dispatchEvent(new Event("resize"))
    expect(style.values.get(viewportHeightProperty)).toBe("844px")
    expect(style.values.get(viewportOffsetProperty)).toBe("0px")

    cleanup()
  })

  it("removes listeners and inline geometry on cleanup", () => {
    const style = new FakeStyle()
    const viewport = new FakeVisualViewport({ height: 493, offsetTop: 51 })
    const cleanup = bindTerminalViewport({ style }, new FakeTerminalViewportHost(viewport))

    cleanup()
    expect(style.values).toEqual(new Map())

    viewport.moveTo({ height: 300, offsetTop: 80 })
    viewport.dispatchEvent(new Event("resize"))
    viewport.dispatchEvent(new Event("scroll"))
    expect(style.values).toEqual(new Map())
  })

  it("measures the embedded boundary when visualViewport is absent", () => {
    const style = new FakeStyle()
    let boundaryTop = 252
    const boundary = { getBoundingClientRect: () => ({ top: boundaryTop }) }
    const host = new FakeTerminalViewportHost(undefined, 844)
    const cleanup = bindTerminalViewport({ style }, host, boundary)

    expect(style.values).toEqual(
      new Map([
        [viewportHeightProperty, "592px"],
        [viewportOffsetProperty, "252px"]
      ])
    )

    boundaryTop = 200
    host.dispatchEvent(new Event("scroll"))
    expect(style.values.get(viewportHeightProperty)).toBe("644px")
    expect(style.values.get(viewportOffsetProperty)).toBe("200px")

    cleanup()
    expect(style.values).toEqual(new Map())
  })

  it("keeps one document lock across remount overlap and restores the exact prior state", () => {
    const host = new FakeDocumentHost(new FakeVisualViewport({ height: 500, offsetTop: 0 }))
    const firstCleanup = bindTerminalViewport({ style: new FakeStyle() }, host)
    const secondCleanup = bindTerminalViewport({ style: new FakeStyle() }, host)

    expect(host.documentClassList.contains("connect-terminal-document-lock")).toBe(true)
    expect(host.bodyClassList.contains("connect-terminal-document-lock")).toBe(true)
    host.moveScrollTo(9, 309)
    expect({ x: host.scrollX, y: host.scrollY }).toEqual({ x: 3, y: 137 })

    firstCleanup()
    firstCleanup()
    expect(host.documentClassList.contains("connect-terminal-document-lock")).toBe(true)
    secondCleanup()

    expect(host.documentClassList.contains("connect-terminal-document-lock")).toBe(false)
    expect(host.bodyClassList.contains("connect-terminal-document-lock")).toBe(false)
    expect(host.documentStyle.cssText).toBe("color: canvastext;")
    expect(host.bodyStyle.cssText).toBe("overflow: visible; touch-action: pan-x;")
    expect({ x: host.scrollX, y: host.scrollY }).toEqual({ x: 3, y: 137 })
  })

  it("preserves inline declarations written by another owner while the terminal is locked", () => {
    const host = new FakeDocumentHost(new FakeVisualViewport({ height: 500, offsetTop: 0 }))
    const cleanup = bindTerminalViewport({ style: new FakeStyle() }, host)

    expect(host.documentStyle.cssText).toBe("color: canvastext;")
    expect(host.bodyStyle.cssText).toBe("overflow: visible; touch-action: pan-x;")
    host.documentStyle.setProperty("overflow", "hidden")
    host.bodyStyle.setProperty("overscroll-behavior", "none")
    cleanup()

    expect(host.documentStyle.cssText).toContain("overflow: hidden;")
    expect(host.bodyStyle.cssText).toContain("overscroll-behavior: none;")
  })

  it("restores the document during navigation", () => {
    const host = new FakeDocumentHost(new FakeVisualViewport({ height: 500, offsetTop: 0 }))
    const cleanup = bindTerminalViewport({ style: new FakeStyle() }, host)

    host.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: true }))
    expect(host.documentClassList.contains("connect-terminal-document-lock")).toBe(true)
    expect(host.bodyClassList.contains("connect-terminal-document-lock")).toBe(true)

    host.dispatchEvent(new Event("pagehide"))

    expect(host.documentClassList.contains("connect-terminal-document-lock")).toBe(false)
    expect(host.bodyClassList.contains("connect-terminal-document-lock")).toBe(false)
    expect(host.documentStyle.cssText).toBe("color: canvastext;")
    expect(host.bodyStyle.cssText).toBe("overflow: visible; touch-action: pan-x;")
    cleanup()
  })

  it("preloads hidden terminal geometry without locking the directory", () => {
    const host = new FakeDocumentHost(new FakeVisualViewport({ height: 500, offsetTop: 0 }))
    const style = new FakeStyle()
    const cleanup = bindTerminalViewport({ style }, host, undefined, false)

    expect(style.values.get(viewportHeightProperty)).toBe("500px")
    expect(host.documentClassList.contains("connect-terminal-document-lock")).toBe(false)
    expect(host.bodyClassList.contains("connect-terminal-document-lock")).toBe(false)
    expect(host.documentStyle.cssText).toBe("color: canvastext;")
    expect(host.bodyStyle.cssText).toBe("overflow: visible; touch-action: pan-x;")
    cleanup()
  })

  it("rolls back document and viewport listeners when geometry setup fails", () => {
    const viewport = new TrackedVisualViewport({ height: 500, offsetTop: 0 })
    const host = new FakeDocumentHost(viewport)
    const target = {
      style: {
        removeProperty: () => "",
        setProperty: () => {
          throw new TypeError("fixture geometry failure")
        }
      }
    }

    expect(() => bindTerminalViewport(target, host)).toThrow("fixture geometry failure")
    expect(viewport.listenerCount).toBe(0)
    expect(host.documentClassList.contains("connect-terminal-document-lock")).toBe(false)
    expect(host.bodyClassList.contains("connect-terminal-document-lock")).toBe(false)
    expect(host.documentStyle.cssText).toBe("color: canvastext;")
    expect(host.bodyStyle.cssText).toBe("overflow: visible; touch-action: pan-x;")
  })
})
