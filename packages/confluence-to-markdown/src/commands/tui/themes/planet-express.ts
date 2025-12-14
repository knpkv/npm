import type { Theme } from "./types.js"

/** Delivery to the future */
export const planetExpress: Theme = {
  name: "Planet Express",
  bg: {
    primary: "#1a1a2e",
    secondary: "#252542",
    tertiary: "#2f2f4f",
    header: "#16162a",
    statusBar: "#16162a"
  },
  accent: {
    primary: "#ff6b35", // Fry's jacket orange
    secondary: "#9d4edd", // Leela's hair purple
    tertiary: "#4cc9f0", // Robot blue
    success: "#38b000", // Slurm green
    warning: "#ffba08", // Bender gold
    error: "#e71d36" // Zoidberg red
  },
  text: {
    primary: "#f8f9fa",
    secondary: "#adb5bd",
    muted: "#6c757d",
    inverse: "#1a1a2e"
  },
  border: {
    focused: "#ff6b35",
    unfocused: "#4a4a6a",
    accent: "#9d4edd"
  },
  selection: {
    active: "#ff6b35",
    inactive: "#4a4a6a",
    hover: "#9d4edd"
  },
  status: {
    synced: "#38b000",
    unsynced: "#ffba08",
    loading: "#4cc9f0",
    online: "#38b000",
    offline: "#e71d36"
  },
  icons: {
    synced: "◉",
    unsynced: "◎",
    folder: "▶",
    loading: "⊛",
    bullet: "»",
    dot: "●",
    check: "✓",
    cross: "✗",
    arrow: { up: "↑", down: "↓", left: "←", right: "→" }
  }
}
