import { useAtomMount } from "@effect/atom-react"
import type * as Atom from "effect/unstable/reactivity/Atom"

/** Keeps dashboard Work polling mounted while FleetShell switches tabs. */
export function DashboardWorkPollOwner<A>({ atom }: { readonly atom: Atom.Atom<A> }): null {
  useAtomMount(atom)
  return null
}
