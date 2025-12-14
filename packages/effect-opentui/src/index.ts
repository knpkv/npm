/**
 * Effect-TS wrapper for OpenTUI terminal UI library.
 */
import * as OpenTuiReact from "@opentui/react"

export * as Components from "./components/index.ts"
export * from "./Renderer.ts"
export * from "./RendererError.ts"

// Re-export useful hooks from @opentui/react
export const useKeyboard = OpenTuiReact.useKeyboard
export const useRenderer = OpenTuiReact.useRenderer
export const useTerminalDimensions = OpenTuiReact.useTerminalDimensions
