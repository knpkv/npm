import { Atom } from "@effect-atom/atom-react"

/**
 * Filter text for PR list
 */
export const filterTextAtom = Atom.make("").pipe(Atom.keepAlive)

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
 * Current quick filter
 */
export const quickFilterAtom = Atom.make<QuickFilter>({ type: "all" }).pipe(Atom.keepAlive)

/**
 * Command palette open state
 */
export const commandPaletteAtom = Atom.make(false).pipe(Atom.keepAlive)

/**
 * Settings tab
 */
export type SettingsTab = "accounts" | "refresh" | "sandbox" | "theme" | "config" | "about"
export const SettingsTabs: ReadonlyArray<SettingsTab> = ["accounts", "refresh", "sandbox", "theme", "config", "about"]
export const settingsTabAtom = Atom.make<SettingsTab>("accounts").pipe(Atom.keepAlive)
