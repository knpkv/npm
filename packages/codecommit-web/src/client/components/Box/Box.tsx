import type React from "react"
import type { CSSProperties, ReactNode } from "react"
import styles from "./Box.module.css"

export interface BoxProps {
  children?: ReactNode
  flexDirection?: "row" | "column"
  flexGrow?: number
  flexWrap?: "wrap" | "nowrap"
  justifyContent?: CSSProperties["justifyContent"]
  alignItems?: CSSProperties["alignItems"]
  width?: string | number
  height?: string | number
  padding?: number
  paddingX?: number
  paddingY?: number
  gap?: number
  backgroundColor?: string
  border?: ("top" | "bottom" | "left" | "right")[]
  borderColor?: string
  onClick?: () => void
  className?: string
  style?: CSSProperties
}

export const Box: React.FC<BoxProps> = ({
  children,
  flexDirection = "row",
  flexGrow,
  flexWrap,
  justifyContent,
  alignItems,
  width,
  height,
  padding,
  paddingX,
  paddingY,
  gap,
  backgroundColor,
  border,
  borderColor = "var(--border-color)",
  onClick,
  className,
  style = {}
}) => {
  const borderStyles: CSSProperties = {}
  if (border) {
    if (border.includes("top")) borderStyles.borderTop = `1px solid ${borderColor}`
    if (border.includes("bottom")) borderStyles.borderBottom = `1px solid ${borderColor}`
    if (border.includes("left")) borderStyles.borderLeft = `2px solid ${borderColor}`
    if (border.includes("right")) borderStyles.borderRight = `1px solid ${borderColor}`
  }

  const computedStyle: CSSProperties = {
    flexDirection,
    flexGrow,
    flexWrap,
    justifyContent,
    alignItems,
    width,
    height,
    padding: padding !== undefined ? `${padding * 8}px` : undefined,
    paddingLeft: paddingX !== undefined ? `${paddingX * 8}px` : undefined,
    paddingRight: paddingX !== undefined ? `${paddingX * 8}px` : undefined,
    paddingTop: paddingY !== undefined ? `${paddingY * 4}px` : undefined,
    paddingBottom: paddingY !== undefined ? `${paddingY * 4}px` : undefined,
    gap: gap !== undefined ? `${gap * 8}px` : undefined,
    backgroundColor,
    ...borderStyles,
    ...style
  }

  return (
    <div
      className={`${styles.box} ${className || ""}`}
      style={computedStyle}
      onClick={onClick}
    >
      {children}
    </div>
  )
}
