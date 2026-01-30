import type { Preview } from "@storybook/react"
import React from "react"

// Shim require, module, exports for browser compatibility with some CJS modules
if (typeof window !== "undefined") {
  if (!(window as any).require) (window as any).require = () => ({})
  if (!(window as any).module) (window as any).module = { exports: {} }
  if (!(window as any).exports) (window as any).exports = (window as any).module.exports
}

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: "dark",
      values: [
        { name: "dark", value: "#282c34" }, // Slightly lighter dark background for the "desk"
        { name: "light", value: "#ffffff" }
      ]
    },
    layout: "centered" // Center the terminal window
  },
  decorators: [
    (Story) => (
      <div
        style={{
          color: "#fff",
          fontFamily: "monospace",
          height: "600px", // Fixed height
          width: "900px", // Fixed width
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#1e1e1e", // Terminal background
          borderRadius: "8px",
          boxShadow: "0 20px 50px rgba(0,0,0,0.5)",
          overflow: "hidden",
          border: "1px solid #333",
          position: "relative"
        }}
      >
        {/* Title Bar Simulation */}
        <div
          style={{
            height: "28px",
            backgroundColor: "#2d2d2d",
            borderBottom: "1px solid #333",
            display: "flex",
            alignItems: "center",
            paddingLeft: "10px",
            gap: "8px"
          }}
        >
          <div style={{ width: "12px", height: "12px", borderRadius: "50%", backgroundColor: "#ff5f56" }}></div>
          <div style={{ width: "12px", height: "12px", borderRadius: "50%", backgroundColor: "#ffbd2e" }}></div>
          <div style={{ width: "12px", height: "12px", borderRadius: "50%", backgroundColor: "#27c93f" }}></div>
          <div
            style={{
              marginLeft: "auto",
              marginRight: "auto",
              fontSize: "12px",
              color: "#999",
              fontFamily: "system-ui, sans-serif"
            }}
          >
            ghostty — codecommit-tui
          </div>
          <div style={{ width: "60px" }}></div> {/* Spacer to center title */}
        </div>

        {/* Terminal Content */}
        <div
          style={{
            flex: 1,
            padding: "8px",
            overflow: "auto",
            position: "relative"
          }}
        >
          <Story />
        </div>
      </div>
    )
  ]
}

export default preview
