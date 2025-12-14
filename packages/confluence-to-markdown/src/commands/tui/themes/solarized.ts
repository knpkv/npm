import type { Theme } from "./types.js"

/** Classic Solarized dark */
export const solarized: Theme = {
  name: "Solarized",
  bg: {
    primary: "#002b36",
    secondary: "#073642",
    tertiary: "#094452",
    header: "#001f27",
    statusBar: "#001f27"
  },
  accent: {
    primary: "#268bd2",
    secondary: "#2aa198",
    tertiary: "#d33682",
    success: "#859900",
    warning: "#b58900",
    error: "#dc322f"
  },
  text: {
    primary: "#fdf6e3",
    secondary: "#93a1a1",
    muted: "#586e75",
    inverse: "#002b36"
  },
  border: {
    focused: "#268bd2",
    unfocused: "#073642",
    accent: "#2aa198"
  },
  selection: {
    active: "#268bd2",
    inactive: "#073642",
    hover: "#2aa198"
  },
  status: {
    synced: "#859900",
    unsynced: "#b58900",
    loading: "#268bd2",
    online: "#859900",
    offline: "#dc322f"
  },
  icons: {
    synced: "●",
    unsynced: "○",
    folder: "▸",
    loading: "◌",
    bullet: "›",
    dot: "●",
    check: "✓",
    cross: "✗",
    arrow: { up: "↑", down: "↓", left: "←", right: "→" }
  }
}
