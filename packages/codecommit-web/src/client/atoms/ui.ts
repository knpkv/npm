import { Atom } from "@effect-atom/atom-react"
import type { PullRequest } from "@knpkv/codecommit-core"

/**
 * View type
 */
export type ViewType = "prs" | "details"

/**
 * Current active view
 */
export const viewAtom = Atom.make<ViewType>("prs").pipe(Atom.keepAlive)

/**
 * Filter text for PR list
 */
export const filterTextAtom = Atom.make("").pipe(Atom.keepAlive)

/**
 * Whether filter mode is active (input focused)
 */
export const isFilteringAtom = Atom.make(false).pipe(Atom.keepAlive)

/**
 * Currently selected PR index
 */
export const selectedIndexAtom = Atom.make(0).pipe(Atom.keepAlive)

/**
 * Currently selected PR for details view
 */
export const selectedPrAtom = Atom.make<PullRequest | null>(null).pipe(Atom.keepAlive)

/**
 * Theme ID
 */
export const themeAtom = Atom.make("dark").pipe(Atom.keepAlive)

/**
 * Quick filter type
 */
export type QuickFilterType = "all" | "mine" | "account" | "author" | "scope" | "repo" | "status"

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
