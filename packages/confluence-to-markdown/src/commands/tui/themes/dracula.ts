import type { Theme } from "./types.js"

export const dracula: Theme = {
  name: "Dracula",
  bg: {
    primary: "#282a36",
    secondary: "#343746",
    tertiary: "#3d4051",
    header: "#21222c",
    statusBar: "#21222c"
  },
  accent: {
    primary: "#bd93f9",
    secondary: "#ff79c6",
    tertiary: "#8be9fd",
    success: "#50fa7b",
    warning: "#f1fa8c",
    error: "#ff5555"
  },
  text: {
    primary: "#f8f8f2",
    secondary: "#bfbfbf",
    muted: "#6272a4",
    inverse: "#282a36"
  },
  border: {
    focused: "#bd93f9",
    unfocused: "#44475a",
    accent: "#ff79c6"
  },
  selection: {
    active: "#bd93f9",
    inactive: "#44475a",
    hover: "#6272a4"
  },
  status: {
    synced: "#50fa7b",
    unsynced: "#f1fa8c",
    loading: "#ff79c6",
    online: "#50fa7b",
    offline: "#ff5555"
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
