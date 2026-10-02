import type { TerminalClientCommand } from "./model.js"

interface TerminalDimensionBounds {
  readonly minimum: number
  readonly maximum: number
}

/** Server-accepted terminal sizes; `model.ts` builds its schemas from these. */
export const terminalColumnBounds: TerminalDimensionBounds = { minimum: 20, maximum: 400 }
export const terminalRowBounds: TerminalDimensionBounds = { minimum: 5, maximum: 200 }

export interface TerminalDimensions {
  readonly cols: number
  readonly rows: number
}

type TerminalResizeCommand = Extract<TerminalClientCommand, { readonly type: "terminal.resize" }>

const clamp = (value: number, bounds: TerminalDimensionBounds): number =>
  Math.min(bounds.maximum, Math.max(bounds.minimum, value))

/**
 * Fits FitAddon output into the server bounds before it leaves the browser.
 * The server closes the socket on an out-of-range size, and a mobile keyboard can shrink
 * the terminal below the minimum row count.
 */
export const clampTerminalDimensions = ({ cols, rows }: TerminalDimensions): TerminalDimensions => ({
  cols: clamp(cols, terminalColumnBounds),
  rows: clamp(rows, terminalRowBounds)
})

/** Builds the resize command the client sends for a fitted terminal size. */
export const terminalResizeCommand = (dimensions: TerminalDimensions): TerminalResizeCommand => {
  const { cols, rows } = clampTerminalDimensions(dimensions)
  return { type: "terminal.resize", cols, rows, cell_width_px: 0, cell_height_px: 0 }
}
