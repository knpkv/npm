import type { Theme } from "./types.js"

export const nord: Theme = {
  name: "Nord",
  bg: {
    primary: "#2e3440",
    secondary: "#3b4252",
    tertiary: "#434c5e",
    header: "#242933",
    statusBar: "#242933"
  },
  accent: {
    primary: "#88c0d0",
    secondary: "#81a1c1",
    tertiary: "#5e81ac",
    success: "#a3be8c",
    warning: "#ebcb8b",
    error: "#bf616a"
  },
  text: {
    primary: "#eceff4",
    secondary: "#d8dee9",
    muted: "#4c566a",
    inverse: "#2e3440"
  },
  border: {
    focused: "#88c0d0",
    unfocused: "#4c566a",
    accent: "#81a1c1"
  },
  selection: {
    active: "#88c0d0",
    inactive: "#4c566a",
    hover: "#5e81ac"
  },
  status: {
    synced: "#a3be8c",
    unsynced: "#ebcb8b",
    loading: "#81a1c1",
    online: "#a3be8c",
    offline: "#bf616a"
  },
  icons: {
    synced: "●",
    unsynced: "○",
    folder: "▹",
    loading: "◌",
    bullet: "·",
    dot: "•",
    check: "✔",
    cross: "✘",
    arrow: { up: "▲", down: "▼", left: "◀", right: "▶" }
  }
}
