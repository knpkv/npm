import type { Theme } from "./types.js"

/** Yellow family vibes with donuts */
export const donutTown: Theme = {
  name: "Donut Town",
  bg: {
    primary: "#1e3a5f",
    secondary: "#274c77",
    tertiary: "#2d5a8a",
    header: "#172d4d",
    statusBar: "#172d4d"
  },
  accent: {
    primary: "#fed439", // Simpson yellow
    secondary: "#6ab3f3", // Marge blue
    tertiary: "#ff7f50", // Orange
    success: "#8bc34a", // Springfield grass
    warning: "#fed439", // Duff gold
    error: "#f44336" // Red
  },
  text: {
    primary: "#ffffff",
    secondary: "#e0e0e0",
    muted: "#78909c",
    inverse: "#1e3a5f"
  },
  border: {
    focused: "#fed439",
    unfocused: "#455a64",
    accent: "#6ab3f3"
  },
  selection: {
    active: "#fed439",
    inactive: "#455a64",
    hover: "#6ab3f3"
  },
  status: {
    synced: "#8bc34a",
    unsynced: "#fed439",
    loading: "#6ab3f3",
    online: "#8bc34a",
    offline: "#f44336"
  },
  icons: {
    synced: "●",
    unsynced: "○",
    folder: "►",
    loading: "◌",
    bullet: "•",
    dot: "●",
    check: "✓",
    cross: "✗",
    arrow: { up: "↑", down: "↓", left: "←", right: "→" }
  }
}
