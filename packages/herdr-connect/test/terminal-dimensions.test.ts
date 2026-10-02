import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { TerminalClientCommand } from "../src/model.js"
import { clampTerminalDimensions, terminalResizeCommand } from "../src/terminal-dimensions.js"

// The wire shape before server validation: any integer sizes the browser might send.
interface WireResizeCommand {
  readonly type: "terminal.resize"
  readonly cols: number
  readonly rows: number
  readonly cell_width_px: number
  readonly cell_height_px: number
}

const decodeOnServer = (command: WireResizeCommand) =>
  Schema.decodeUnknownResult(TerminalClientCommand)(JSON.parse(JSON.stringify(command)))

describe("terminal dimensions", () => {
  it("raises sizes below the server minimum", () => {
    expect(clampTerminalDimensions({ cols: 2, rows: 1 })).toEqual({ cols: 20, rows: 5 })
  })

  it("lowers sizes above the server maximum", () => {
    expect(clampTerminalDimensions({ cols: 900, rows: 500 })).toEqual({ cols: 400, rows: 200 })
  })

  it("keeps in-range sizes unchanged", () => {
    expect(clampTerminalDimensions({ cols: 48, rows: 14 })).toEqual({ cols: 48, rows: 14 })
  })

  it("documents that an unclamped keyboard-height fit is rejected by the server", () => {
    const raw: WireResizeCommand = { type: "terminal.resize", cols: 48, rows: 3, cell_width_px: 0, cell_height_px: 0 }
    expect(Result.isFailure(decodeOnServer(raw))).toBe(true)
  })

  it("sends only resize commands the server accepts for every FitAddon size", () => {
    // ghostty-web FitAddon proposes cols >= 2 and rows >= 1 with no upper bound.
    for (let cols = 2; cols <= 600; cols += 7) {
      for (let rows = 1; rows <= 300; rows += 3) {
        const decoded = decodeOnServer(terminalResizeCommand({ cols, rows }))
        expect(Result.isSuccess(decoded), `${String(cols)}x${String(rows)}`).toBe(true)
      }
    }
  })
})
