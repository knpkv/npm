import type { Theme } from "./types.js"

export const cyberpunk: Theme = {
  name: "Cyberpunk",
  bg: {
    primary: "#0d1117",
    secondary: "#161b22",
    tertiary: "#21262d",
    header: "#1a1b26",
    statusBar: "#0d1117"
  },
  accent: {
    primary: "#00d4ff",
    secondary: "#a855f7",
    tertiary: "#f472b6",
    success: "#00ff9f",
    warning: "#fbbf24",
    error: "#ff6b6b"
  },
  text: {
    primary: "#e6edf3",
    secondary: "#8b949e",
    muted: "#484f58",
    inverse: "#0d1117"
  },
  border: {
    focused: "#00d4ff",
    unfocused: "#30363d",
    accent: "#a855f7"
  },
  selection: {
    active: "#00d4ff",
    inactive: "#30363d",
    hover: "#1f6feb"
  },
  status: {
    synced: "#00ff9f",
    unsynced: "#fbbf24",
    loading: "#a855f7",
    online: "#00ff9f",
    offline: "#ff6b6b"
  },
  icons: {
    synced: "◆",
    unsynced: "◇",
    folder: "▸",
    loading: "⟳",
    bullet: "›",
    dot: "●",
    check: "✓",
    cross: "✗",
    arrow: { up: "↑", down: "↓", left: "←", right: "→" }
  }
}
