/**
 * Theme exports.
 */
import { cyberpunk } from "./cyberpunk.js"
import { donutTown } from "./donut-town.js"
import { dracula } from "./dracula.js"
import { gruvbox } from "./gruvbox.js"
import { monokai } from "./monokai.js"
import { nord } from "./nord.js"
import { picklePortal } from "./pickle-portal.js"
import { planetExpress } from "./planet-express.js"
import { solarized } from "./solarized.js"
import { tokyoNight } from "./tokyo-night.js"
import { treeFort } from "./tree-fort.js"

export type { Theme } from "./types.js"

export { cyberpunk } from "./cyberpunk.js"
export { donutTown } from "./donut-town.js"
export { dracula } from "./dracula.js"
export { gruvbox } from "./gruvbox.js"
export { monokai } from "./monokai.js"
export { nord } from "./nord.js"
export { picklePortal } from "./pickle-portal.js"
export { planetExpress } from "./planet-express.js"
export { solarized } from "./solarized.js"
export { tokyoNight } from "./tokyo-night.js"
export { treeFort } from "./tree-fort.js"

export const themes = {
  cyberpunk,
  dracula,
  nord,
  monokai,
  gruvbox,
  solarized,
  tokyoNight,
  planetExpress,
  treeFort,
  donutTown,
  picklePortal
} as const

export type ThemeName = keyof typeof themes

export const themeNames = Object.keys(themes) as ReadonlyArray<ThemeName>

export const defaultTheme: ThemeName = "cyberpunk"
