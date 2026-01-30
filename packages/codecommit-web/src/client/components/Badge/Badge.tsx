import { useTheme } from "../../theme/index.js"
import styles from "./Badge.module.css"

export type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral"

interface BadgeProps {
  readonly children: React.ReactNode
  readonly variant?: BadgeVariant
}

export function Badge({ children, variant = "neutral" }: BadgeProps) {
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
  }

  return (
    <span className={styles.badge} style={{ backgroundColor: bg, color: fg }}>
      {children}
    </span>
  )
}
