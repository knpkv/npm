/**
 * Jotai atoms for UI state — filter text, active view, theme.
 *
 * @internal
 */
import * as Atom from "effect/unstable/reactivity/Atom"

export type DisplayMode = "minimal" | "compact" | "full"

export const selectedIndexAtom = Atom.make(0).pipe(Atom.keepAlive)
export const filterTextAtom = Atom.make("").pipe(Atom.keepAlive)
export const isFilteringAtom = Atom.make(false).pipe(Atom.keepAlive)
