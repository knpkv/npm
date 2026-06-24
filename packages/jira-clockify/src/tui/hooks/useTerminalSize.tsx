import type { DisplayMode } from "../atoms/ui.js"

export function useTerminalSize() {
  return 80
}

export function useDisplayMode(): DisplayMode {
  const cols = useTerminalSize()
  if (cols < 40) return "minimal"
  if (cols < 80) return "compact"
  return "full"
}
