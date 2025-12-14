import type { Theme } from "./types.js"

/** Tree fort vibes */
export const treeFort: Theme = {
  name: "Tree Fort",
  bg: {
    primary: "#1b2838",
    secondary: "#2a3f5f",
    tertiary: "#3a5080",
    header: "#152030",
    statusBar: "#152030"
  },
  accent: {
    primary: "#00b4d8", // Finn's shirt blue
    secondary: "#ffd60a", // Jake yellow
    tertiary: "#ff69b4", // Princess Bubblegum pink
    success: "#7cb518", // Grass green
    warning: "#ffd60a", // Golden
    error: "#ff006e" // Marceline red
  },
  text: {
    primary: "#ffffff",
    secondary: "#c8d6e5",
    muted: "#576574",
    inverse: "#1b2838"
  },
  border: {
    focused: "#00b4d8",
    unfocused: "#4a5568",
    accent: "#ffd60a"
  },
  selection: {
    active: "#00b4d8",
    inactive: "#4a5568",
    hover: "#ffd60a"
  },
  status: {
    synced: "#7cb518",
    unsynced: "#ffd60a",
    loading: "#ff69b4",
    online: "#7cb518",
    offline: "#ff006e"
  },
  icons: {
    synced: "★",
    unsynced: "☆",
    folder: "♦",
    loading: "✧",
    bullet: "♪",
    dot: "●",
    check: "✔",
    cross: "✖",
    arrow: { up: "▲", down: "▼", left: "◀", right: "▶" }
  }
}
