import { useTheme } from "../context/theme.js"

export type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral" | "outline"

interface BadgeProps {
  readonly children: React.ReactNode
  readonly variant?: BadgeVariant
  readonly minWidth?: number
}

/**
 * Styled badge component for status indicators
 * @category components
 */
export function Badge({ children, minWidth, variant = "neutral" }: BadgeProps) {
  const { theme } = useTheme()

  let bg = theme.backgroundElement
  let fg = theme.text

  switch (variant) {
    case "success":
      bg = theme.success
      fg = theme.background
      break
    case "warning":
      bg = theme.warning
      fg = theme.background
      break
    case "error":
      bg = theme.error
      fg = theme.background
      break
    case "info":
      bg = theme.primary
      fg = theme.background
      break
    case "neutral":
      bg = theme.backgroundElement
      fg = theme.textMuted
      break
    case "outline":
      bg = "transparent"
      fg = theme.textMuted
      break
  }

  const str = String(children)
  const contentWidth = str.length + 2 // 1 space padding each side
  const width = Math.max(minWidth ?? 0, contentWidth)

  return (
    <box
      style={{
        backgroundColor: bg,
        width,
        height: 1,
        justifyContent: "center",
        alignItems: "center"
      }}
    >
      <text fg={fg}>{str}</text>
    </box>
  )
}
