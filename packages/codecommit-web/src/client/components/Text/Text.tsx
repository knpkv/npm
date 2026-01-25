import type React from "react"
import type { CSSProperties, ReactNode } from "react"
import styles from "./Text.module.css"

export interface TextProps {
  children?: ReactNode
  color?: string
  dimmed?: boolean
  bold?: boolean
  className?: string
  style?: CSSProperties
}

export const Text: React.FC<TextProps> = ({
  children,
  color,
  dimmed,
  bold,
  className,
  style = {}
}) => {
  const computedStyle: CSSProperties = {
    color: color || (dimmed ? "var(--text-muted)" : "var(--text)"),
    fontWeight: bold ? "bold" : "normal",
    ...style
  }

  return (
    <span className={`${styles.text} ${className || ""}`} style={computedStyle}>
      {children}
    </span>
  )
}
