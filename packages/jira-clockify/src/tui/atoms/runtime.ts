/**
 * Effect runtime bootstrapping for TUI atoms — builds layers and provides runtime to Jotai atoms.
 *
 * @internal
 */
import { Atom } from "@effect-atom/atom-react"
import { HeadlessLayer } from "../../cli/layers.js"

export const runtimeAtom = Atom.runtime(HeadlessLayer)
