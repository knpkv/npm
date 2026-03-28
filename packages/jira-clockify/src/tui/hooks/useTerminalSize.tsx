/**
 * Hook that tracks terminal column width via Node stdout.
 *
 * Uses `node:process` import instead of the global — keeps the dependency explicit
 * and avoids bare `process` globals. This is a TUI boundary: React hooks require
 * synchronous access to terminal dimensions, which Effect's Terminal service can't
 * provide without breaking the React render contract.
 *
 * @internal
 */
import nodeProcess from "node:process"
import { useEffect, useState } from "react"
import type { DisplayMode } from "../atoms/ui.js"

export function useTerminalSize() {
  const [cols, setCols] = useState(nodeProcess.stdout.columns ?? 80)

  useEffect(() => {
    const handler = () => setCols(nodeProcess.stdout.columns ?? 80)
    nodeProcess.stdout.on("resize", handler)
    return () => {
      nodeProcess.stdout.off("resize", handler)
    }
  }, [])

  return cols
}

export function useDisplayMode(): DisplayMode {
  const cols = useTerminalSize()
  if (cols < 40) return "minimal"
  if (cols < 80) return "compact"
  return "full"
}
