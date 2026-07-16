import type { CSSProperties } from "react"

export const pageStyle: CSSProperties = {
  alignContent: "start",
  background: "var(--rly-color-canvas)",
  color: "var(--rly-color-text-1)",
  display: "grid",
  gap: "var(--rly-space-32)",
  minHeight: "100vh",
  padding: "clamp(var(--rly-space-20), 5vw, var(--rly-space-64))"
}

export const gridStyle: CSSProperties = {
  alignItems: "start",
  display: "grid",
  gap: "var(--rly-space-16)",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 14rem), 1fr))"
}

export const rowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--rly-space-16)"
}

export const stackStyle: CSSProperties = {
  alignContent: "start",
  alignItems: "start",
  display: "grid",
  gap: "var(--rly-space-16)",
  maxWidth: "48rem"
}

export const swatchStyle: CSSProperties = {
  border: "1px solid var(--rly-color-border-1)",
  borderRadius: "var(--rly-radius-control)",
  display: "grid",
  gap: "var(--rly-space-12)",
  minWidth: 0,
  padding: "var(--rly-space-16)"
}
