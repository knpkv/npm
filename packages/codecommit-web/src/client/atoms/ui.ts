import { Atom } from "@effect-atom/atom-react"

/**
 * Multi-filter key — each maps to a PR field
 */
export type FilterKey = "account" | "author" | "approver" | "commenter" | "scope" | "repo" | "status" | "size"

/**
 * Single filter entry (one per key allowed)
 */
export interface FilterEntry {
  readonly key: FilterKey
  readonly value: string
}

/**
 * Full filter state — derived from URL search params
 */
export interface FilterState {
  readonly filters: ReadonlyArray<FilterEntry>
  readonly hot: boolean
  readonly mine: boolean
  readonly mineScope?: string
  readonly q: string
  readonly from?: string
  readonly to?: string
}

export const FILTER_KEYS: ReadonlyArray<FilterKey> = [
  "account",
  "author",
  "approver",
  "commenter",
  "scope",
  "repo",
  "status",
  "size"
]

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
