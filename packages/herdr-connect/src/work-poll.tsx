import { useAtomMount } from "@effect/atom-react"
import type * as Atom from "effect/unstable/reactivity/Atom"

/** Keeps a Work snapshot polling atom mounted for the lifetime of its owner. */
export function WorkPollMount<A>({ atom }: { readonly atom: Atom.Atom<A> }): null {
  useAtomMount(atom)
  return null
}
