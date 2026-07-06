import { useTerminalDimensions } from "@opentui/react"
import type { DisplayMode } from "../atoms/ui.js"

/** Live terminal width in columns, tracking resizes (was previously hardcoded to 80). */
export function useTerminalSize() {
  return useTerminalDimensions().width
}

export function useDisplayMode(): DisplayMode {
  const cols = useTerminalSize()
  if (cols < 40) return "minimal"
  if (cols < 80) return "compact"
  return "full"
}
