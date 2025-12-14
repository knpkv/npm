/**
 * Effect-TS wrapper for OpenTUI terminal UI library.
 */

export * as Components from "./components/index.ts"
export * from "./Renderer.ts"
export * from "./RendererError.ts"

// Re-export useful hooks from @opentui/react
export { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
