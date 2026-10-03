/**
 * Effect runtime bootstrapping for TUI atoms — builds layers and provides runtime to Jotai atoms.
 *
 * @internal
 */
import * as Atom from "effect/reactivity/Atom"
import { HeadlessLayer } from "../../cli/layers.js"

export const runtimeAtom = Atom.runtime(HeadlessLayer)
