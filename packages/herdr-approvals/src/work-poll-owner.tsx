import { useAtomMount } from "@effect/atom-react"
import type * as Atom from "effect/unstable/reactivity/Atom"

/** Keeps the dashboard Work projection and its refresh driver mounted across tab switches. */
export function DashboardWorkPollOwner<A, B>({
  atom,
  poll
}: {
  readonly atom: Atom.Atom<A>
  readonly poll: Atom.Atom<B>
}): null {
  useAtomMount(atom)
  useAtomMount(poll)
  return null
}
