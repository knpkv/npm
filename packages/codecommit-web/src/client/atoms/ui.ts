import { Atom } from "@effect-atom/atom-react"

/**
 * Quick filter type
 */
export type QuickFilterType = "all" | "mine" | "account" | "author" | "scope" | "repo" | "status" | "hot"

/**
 * Quick filter state
 */
export interface QuickFilter {
  type: QuickFilterType
  value?: string
}

/**
 * Command palette open state
 */
export const commandPaletteAtom = Atom.make(false).pipe(Atom.keepAlive)

/**
 * Settings tab
 */
export type SettingsTab = "accounts" | "refresh" | "theme" | "config" | "about"
export const SettingsTabs: ReadonlyArray<SettingsTab> = ["accounts", "refresh", "theme", "config", "about"]
