/**
 * UI state atoms — filter state, command palette, settings tabs.
 *
 * Defines {@link FilterState} (multi-axis filters, hot/mine/review toggles,
 * text search, date range), {@link FILTER_KEYS} (all allowed filter
 * dimensions), {@link SettingsTab} (accounts, refresh, sandbox,
 * notifications, permissions, audit, theme, config, about), and
 * atoms for command palette and active settings tab.
 *
 * @module
 */
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
  readonly review: boolean
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
export type SettingsTab =
  | "accounts"
  | "refresh"
  | "sandbox"
  | "notifications"
  | "permissions"
  | "audit"
  | "theme"
  | "config"
  | "about"
export const SettingsTabs: ReadonlyArray<SettingsTab> = [
  "accounts",
  "refresh",
  "sandbox",
  "notifications",
  "permissions",
  "audit",
  "theme",
  "config",
  "about"
]
export const settingsTabAtom = Atom.make<SettingsTab>("accounts").pipe(Atom.keepAlive)
