import type { Theme } from "./types.js"

/** Portal green and pickle vibes */
export const picklePortal: Theme = {
  name: "Pickle Portal",
  bg: {
    primary: "#0a1628",
    secondary: "#122640",
    tertiary: "#1a3352",
    header: "#061220",
    statusBar: "#061220"
  },
  accent: {
    primary: "#97ce4c", // Portal green
    secondary: "#44d9e6", // Rick's hair cyan
    tertiary: "#e85d75", // Morty's shirt red-pink
    success: "#97ce4c", // Portal green
    warning: "#f4d35e", // Yellow
    error: "#e85d75" // Red-pink
  },
  text: {
    primary: "#e6f1ff",
    secondary: "#a3c4e7",
    muted: "#5a7a9a",
    inverse: "#0a1628"
  },
  border: {
    focused: "#97ce4c",
    unfocused: "#2a4a6a",
    accent: "#44d9e6"
  },
  selection: {
    active: "#97ce4c",
    inactive: "#2a4a6a",
    hover: "#44d9e6"
  },
  status: {
    synced: "#97ce4c",
    unsynced: "#f4d35e",
    loading: "#44d9e6",
    online: "#97ce4c",
    offline: "#e85d75"
  },
  icons: {
    synced: "◈",
    unsynced: "◇",
    folder: "⊳",
    loading: "⌀",
    bullet: "›",
    dot: "●",
    check: "✓",
    cross: "✗",
    arrow: { up: "↑", down: "↓", left: "←", right: "→" }
  }
}
