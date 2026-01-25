import { Atom } from "@effect-atom/atom-react"
import type { PullRequest } from "@knpkv/codecommit-core"

/**
 * TUI view type
 * @category types
 */
export type TuiView = "prs" | "settings" | "notifications" | "details"

/**
 * Current active view
 * @category atoms
 */
export const viewAtom = Atom.make<TuiView>("prs").pipe(Atom.keepAlive)

/**
 * Current filter text
 * @category atoms
 */
export const filterTextAtom = Atom.make("").pipe(Atom.keepAlive)

/**
 * Whether filter mode is active
 * @category atoms
 */
export const isFilteringAtom = Atom.make(false).pipe(Atom.keepAlive)

/**
 * Whether help modal is shown
 * @category atoms
 */
export const showHelpAtom = Atom.make(false).pipe(Atom.keepAlive)

/**
 * Currently selected PR for details view
 * @category atoms
 */
export const currentPRAtom = Atom.make<PullRequest | null>(null).pipe(Atom.keepAlive)

/**
 * Currently selected list index
 * @category atoms
 */
export const selectedIndexAtom = Atom.make(0).pipe(Atom.keepAlive)

/**
 * Currently selected PR ID (for stable selection during streaming)
 * @category atoms
 */
export const selectedPrIdAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive)

/**
 * Current theme identifier
 * @category atoms
 */
export const themeAtom = Atom.make<string>("dark").pipe(Atom.keepAlive)

/**
 * Whether exit confirmation is pending
 * @category atoms
 */
export const exitPendingAtom = Atom.make(false).pipe(Atom.keepAlive)

/**
 * Global UI error message (transient)
 * @category atoms
 */
export const uiErrorAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive)

/**
 * Whether PR creation is in progress
 * @category atoms
 */
export const creatingPrAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive)

/**
 * Quick filter type
 * @category types
 */
export type QuickFilterType = "all" | "mine" | "account" | "author" | "scope" | "date" | "repo" | "status"

/**
 * Date filter values
 */
export type DateFilterValue = "today" | "week" | "month" | "older"

/**
 * Quick filter type atom
 * @category atoms
 */
export const quickFilterTypeAtom = Atom.make<QuickFilterType>("all").pipe(Atom.keepAlive)

/**
 * Quick filter values per filter type
 * @category atoms
 */
export const quickFilterValuesAtom = Atom.make<Record<QuickFilterType, string>>({
  all: "",
  mine: "",
  account: "",
  author: "",
  scope: "",
  date: "today",
  repo: "",
  status: "approved"
}).pipe(Atom.keepAlive)

/**
 * Quick filter value (account id or author name) - derived from type
 * @category atoms
 * @deprecated Use quickFilterValuesAtom instead
 */
export const quickFilterValueAtom = Atom.make<string>("").pipe(Atom.keepAlive)

/**
 * Current user name (for "my PRs" filter)
 * @category atoms
 */
export const currentUserAtom = Atom.make<string>("").pipe(Atom.keepAlive)

/**
 * Settings filter text
 * @category atoms
 */
export const settingsFilterAtom = Atom.make<string>("").pipe(Atom.keepAlive)

/**
 * Whether settings filter mode is active
 * @category atoms
 */
export const isSettingsFilteringAtom = Atom.make(false).pipe(Atom.keepAlive)
