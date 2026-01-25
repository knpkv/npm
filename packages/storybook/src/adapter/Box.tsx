import React from "react"
import type { CSSProperties } from "react"

// Props matching TUI Box props approximately
interface BoxProps {
  flexDirection?: "row" | "column"
  flexGrow?: number
  width?: number | string
  height?: number | string
  padding?: number
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  margin?: number
  marginLeft?: number
  marginRight?: number
  marginTop?: number
  marginBottom?: number
  border?: "single" | "double" | "round" | string[] | boolean
  borderColor?: string
  style?: CSSProperties
  children?: React.ReactNode
  bg?: string
  className?: string
  [key: string]: any
}

export const Box: React.FC<BoxProps> = ({
  flexDirection,
  flexGrow,
  width,
  height,
  padding,
  paddingLeft,
  paddingRight,
  paddingTop,
  paddingBottom,
  margin,
  marginLeft,
  marginRight,
  marginTop,
  marginBottom,
  border,
  borderColor,
  style,
  children,
  bg,
  className,
  ...rest
}) => {
  const cssStyle: CSSProperties = {
    display: "flex",
    flexDirection: flexDirection || "row",
    flexGrow: flexGrow,
    width: typeof width === "number" ? `${width}ch` : width,
    height: typeof height === "number" ? `${height}em` : height,
    padding: padding ? `${padding}ch` : undefined,
    paddingLeft: paddingLeft ? `${paddingLeft}ch` : undefined,
    paddingRight: paddingRight ? `${paddingRight}ch` : undefined,
    paddingTop: paddingTop ? `${paddingTop}em` : undefined,
    paddingBottom: paddingBottom ? `${paddingBottom}em` : undefined,
    margin: margin ? `${margin}ch` : undefined,
    marginLeft: marginLeft ? `${marginLeft}ch` : undefined,
    marginRight: marginRight ? `${marginRight}ch` : undefined,
    marginTop: marginTop ? `${marginTop}em` : undefined,
    marginBottom: marginBottom ? `${marginBottom}em` : undefined,
    backgroundColor: bg,
    border: border
      ? typeof border === "string" && border !== ("none" as string)
        ? `1px solid ${borderColor || "white"}`
        : undefined
      : undefined,
    boxSizing: "border-box",
    position: "relative",
    ...style
  }

  // Handle Box style prop specifically for TUI compatibility
  if (style) {
    if (style.backgroundColor) cssStyle.backgroundColor = style.backgroundColor
    if (style.width !== undefined) cssStyle.width = typeof style.width === "number" ? `${style.width}ch` : style.width
    if (style.height !== undefined)
      cssStyle.height = typeof style.height === "number" ? `${style.height}em` : style.height
    if (style.justifyContent) cssStyle.justifyContent = style.justifyContent
    if (style.alignItems) cssStyle.alignItems = style.alignItems
  }

  // Border radius simulation for 'round'
  if (border === "round") {
    cssStyle.borderRadius = "5px"
  }

  // Double border
  if (border === "double") {
    cssStyle.borderStyle = "double"
    cssStyle.borderWidth = "3px"
  }

  return (
    <div style={cssStyle} className={className} {...rest}>
      {children}
    </div>
  )
}
