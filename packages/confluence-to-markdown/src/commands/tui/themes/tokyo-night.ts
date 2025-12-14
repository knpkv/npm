import type { Theme } from "./types.js"

export const tokyoNight: Theme = {
  name: "Tokyo Night",
  bg: {
    primary: "#1a1b26",
    secondary: "#24283b",
    tertiary: "#2f3549",
    header: "#16161e",
    statusBar: "#16161e"
  },
  accent: {
    primary: "#7aa2f7",
    secondary: "#bb9af7",
    tertiary: "#7dcfff",
    success: "#9ece6a",
    warning: "#e0af68",
    error: "#f7768e"
  },
  text: {
    primary: "#c0caf5",
    secondary: "#a9b1d6",
    muted: "#565f89",
    inverse: "#1a1b26"
  },
  border: {
    focused: "#7aa2f7",
    unfocused: "#3b4261",
    accent: "#bb9af7"
  },
  selection: {
    active: "#7aa2f7",
    inactive: "#3b4261",
    hover: "#2ac3de"
  },
  status: {
    synced: "#9ece6a",
    unsynced: "#e0af68",
    loading: "#bb9af7",
    online: "#9ece6a",
    offline: "#f7768e"
  },
  icons: {
    synced: "◈",
    unsynced: "◇",
    folder: "▷",
    loading: "◐",
    bullet: "∙",
    dot: "◉",
    check: "✓",
    cross: "✗",
    arrow: { up: "↑", down: "↓", left: "←", right: "→" }
  }
}
