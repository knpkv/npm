import type { Theme } from "./types.js"

export const monokai: Theme = {
  name: "Monokai Pro",
  bg: {
    primary: "#2d2a2e",
    secondary: "#353236",
    tertiary: "#403e41",
    header: "#221f22",
    statusBar: "#221f22"
  },
  accent: {
    primary: "#ffd866",
    secondary: "#ff6188",
    tertiary: "#78dce8",
    success: "#a9dc76",
    warning: "#fc9867",
    error: "#ff6188"
  },
  text: {
    primary: "#fcfcfa",
    secondary: "#c1c0c0",
    muted: "#727072",
    inverse: "#2d2a2e"
  },
  border: {
    focused: "#ffd866",
    unfocused: "#5b595c",
    accent: "#ff6188"
  },
  selection: {
    active: "#ffd866",
    inactive: "#5b595c",
    hover: "#fc9867"
  },
  status: {
    synced: "#a9dc76",
    unsynced: "#fc9867",
    loading: "#78dce8",
    online: "#a9dc76",
    offline: "#ff6188"
  },
  icons: {
    synced: "★",
    unsynced: "☆",
    folder: "»",
    loading: "⊙",
    bullet: "→",
    dot: "◉",
    check: "✓",
    cross: "✕",
    arrow: { up: "⬆", down: "⬇", left: "⬅", right: "➡" }
  }
}
