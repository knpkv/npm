import { describe, expect, it } from "@effect/vitest"
import { bindTerminalViewport, type TerminalVisualViewport } from "../src/terminal-viewport.js"

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

const viewportHeightProperty = "--connect-visual-viewport-height"
const viewportOffsetProperty = "--connect-visual-viewport-offset"

describe("terminal visual viewport", () => {
  it("tracks keyboard height, Safari offset, rotation, and keyboard close", () => {
    const style = new FakeStyle()
    const viewport = new FakeVisualViewport({ height: 844, offsetTop: 0 })
    const cleanup = bindTerminalViewport({ style }, { visualViewport: viewport })

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
    const cleanup = bindTerminalViewport({ style }, { visualViewport: viewport })

    cleanup()
    expect(style.values).toEqual(new Map())

    viewport.moveTo({ height: 300, offsetTop: 80 })
    viewport.dispatchEvent(new Event("resize"))
    viewport.dispatchEvent(new Event("scroll"))
    expect(style.values).toEqual(new Map())
  })

  it("leaves CSS dynamic viewport sizing in charge when visualViewport is absent", () => {
    const style = new FakeStyle()
    const cleanup = bindTerminalViewport({ style }, {})

    expect(style.values).toEqual(new Map())
    cleanup()
    expect(style.values).toEqual(new Map())
  })
})
