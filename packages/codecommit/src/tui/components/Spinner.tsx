import { useEffect, useState } from "react"
import { SPINNER_FRAMES } from "../Constants.js"
import { useTheme } from "../context/theme.js"

interface SpinnerProps {
  readonly active: boolean
  readonly label?: string
}

/**
 * Animated spinner component
 * @category components
 */
export function Spinner({ active, label = "Loading..." }: SpinnerProps) {
  const { theme } = useTheme()
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!active) return

    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length)
    }, 80)

    return () => clearInterval(interval)
  }, [active])

  if (!active) return null

  return (
    <text fg={theme.textAccent}>
      {SPINNER_FRAMES[frame]} {label}
    </text>
  )
}
