import { forwardRef, type CSSProperties, type ReactNode } from "react"
import styles from "./ScrollBox.module.css"

export interface ScrollBoxProps {
  children?: ReactNode
  flexGrow?: number
  width?: string | number
  height?: string | number
  className?: string
  style?: CSSProperties
}

export const ScrollBox = forwardRef<HTMLDivElement, ScrollBoxProps>(
  ({ children, flexGrow, width, height, className, style = {} }, ref) => {
    const computedStyle: CSSProperties = {
      flexGrow,
      width,
      height,
      ...style
    }

    return (
      <div
        ref={ref}
        className={`${styles.scrollBox} ${className || ""}`}
        style={computedStyle}
      >
        {children}
      </div>
    )
  }
)

ScrollBox.displayName = "ScrollBox"
