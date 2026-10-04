/**
 * Page state: what the viewer chose, and the three reads that follow from it. They are refreshed
 * when the live-updates socket says they changed (see `useLiveUpdates`), never on a timer.
 *
 * The measure and the selected Booking only change how a report is drawn, so they live apart from
 * the range and agent filter that decide what is fetched.
 *
 * @module
 */
import { Clock, Effect } from "effect"
import { Atom } from "effect/reactivity"
import type { AgentFilter } from "../shared/contracts.js"
import { fetchLimits, fetchStatus, fetchUsage } from "./api.js"
import type { Measure } from "./chartModel.js"
import { type Preset, rangeOf } from "./range.js"

export const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

export const presetAtom = Atom.make<Preset>("7d")
export const agentAtom = Atom.make<AgentFilter>("all")
export const measureAtom = Atom.make<Measure>("cost")
export const selectedAtom = Atom.make<string | null>(null)

/** The range the current preset covers, recomputed on every refresh so "today" moves on. */
const currentRange = (preset: Preset) => Effect.map(Clock.currentTimeMillis, (now) => rangeOf(preset, now, timeZone))

export const usageAtom = Atom.make((get) => {
  const preset = get(presetAtom)
  const agent = get(agentAtom)
  return currentRange(preset).pipe(
    // The preset travels with its report: a failed refresh keeps showing the last report, which must
    // keep naming the range it covers rather than the one just picked.
    Effect.flatMap((range) =>
      Effect.map(fetchUsage({ ...range, agent, timeZone }), (report) => ({ preset, range, report }))
    )
  )
})

export const limitsAtom = Atom.make((get) =>
  currentRange(get(presetAtom)).pipe(
    Effect.flatMap((range) => Effect.map(fetchLimits(range), (limits) => ({ range, limits })))
  )
)

export const statusAtom = Atom.make(fetchStatus)
