import React from "react"
import type { CSSProperties } from "react"

interface TextProps {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  underline?: boolean
  style?: CSSProperties
  children?: React.ReactNode
  [key: string]: any
}

export const Text: React.FC<TextProps> = ({ fg, bg, bold, dim, underline, style, children, ...rest }) => {
  const cssStyle: CSSProperties = {
    color: fg,
    backgroundColor: bg,
    fontWeight: bold ? "bold" : "normal",
    opacity: dim ? 0.6 : 1,
    textDecoration: underline ? "underline" : "none",
    whiteSpace: "pre", // Preserve whitespace
    fontFamily: "monospace",
    ...style
  }

  return (
    <span style={cssStyle} {...rest}>
      {children}
    </span>
  )
}
