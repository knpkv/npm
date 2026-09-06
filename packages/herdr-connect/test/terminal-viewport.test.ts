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

class FakeTerminalViewportHost extends EventTarget implements TerminalViewportHost {
  readonly innerHeight: number | undefined
  readonly visualViewport: TerminalVisualViewport | null | undefined

  constructor(visualViewport?: TerminalVisualViewport | null, innerHeight?: number) {
    super()
    this.innerHeight = innerHeight
    this.visualViewport = visualViewport
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
})
