import type { Theme } from "./types.js"

export const gruvbox: Theme = {
  name: "Gruvbox",
  bg: {
    primary: "#1d2021",
    secondary: "#282828",
    tertiary: "#3c3836",
    header: "#1d2021",
    statusBar: "#1d2021"
  },
  accent: {
    primary: "#fe8019",
    secondary: "#b8bb26",
    tertiary: "#83a598",
    success: "#b8bb26",
    warning: "#fabd2f",
    error: "#fb4934"
  },
  text: {
    primary: "#ebdbb2",
    secondary: "#a89984",
    muted: "#665c54",
    inverse: "#1d2021"
  },
  border: {
    focused: "#fe8019",
    unfocused: "#504945",
    accent: "#b8bb26"
  },
  selection: {
    active: "#fe8019",
    inactive: "#504945",
    hover: "#d65d0e"
  },
  status: {
    synced: "#b8bb26",
    unsynced: "#fabd2f",
    loading: "#83a598",
    online: "#b8bb26",
    offline: "#fb4934"
  },
  icons: {
    synced: "■",
    unsynced: "□",
    folder: "⊳",
    loading: "⌛",
    bullet: "▪",
    dot: "◆",
    check: "☑",
    cross: "☒",
    arrow: { up: "↑", down: "↓", left: "←", right: "→" }
  }
}
