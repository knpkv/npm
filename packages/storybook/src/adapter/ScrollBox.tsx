import React from "react"
import { Box } from "./Box"

export const ScrollBox = React.forwardRef<HTMLDivElement, any>((props, ref) => {
  return (
    <Box
      {...props}
      // @ts-ignore
      ref={ref}
      style={{ ...props.style, overflow: "auto", minHeight: 0 }}
    />
  )
})

ScrollBox.displayName = "ScrollBox"
