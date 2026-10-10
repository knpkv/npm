/**
 * The agents this device keeps pinned: an ordered set, pin order first, remembered across polls and reloads.
 *
 * **Mental model**
 *
 * - **A pin outlives its agent's absence.** A pin names an agent by `connectAgentKey` and keeps its name and
 *   when Connect last saw it, so an agent that leaves the directory and comes back is still pinned, and while
 *   it's gone the pin still shows, as "not seen since". Nothing is pruned for being absent; only unpinning
 *   removes a pin.
 * - **Bounded, and full is said out loud.** At most {@link MAX_PINS}; pinning one more is refused with
 *   {@link PinLimitReached}, never by silently dropping an older pin.
 * - **Pure.** Every change takes a list and returns a new one; the client stores what comes back.
 *
 * @module
 */
import { Data, Result, Schema } from "effect"

/** How many agents one device can keep pinned. */
export const MAX_PINS = 8

/** One pinned agent, as remembered on this device. */
export const Pin = Schema.Struct({
  /** The agent's `connectAgentKey`: host and stable ID. */
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(513)),
  host: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  /** Its name when last seen, to label the pin while the agent is away. */
  name: Schema.String.check(Schema.isMaxLength(256)),
  /** When Connect last saw it in the directory, epoch milliseconds, to the minute. */
  seenAt: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
})
export type Pin = typeof Pin.Type

/** Every pin, in the order they were pinned. Keys are unique. */
export const Pins = Schema.Array(Pin).check(Schema.isMaxLength(MAX_PINS))
export type Pins = typeof Pins.Type

/** What a device stores: the pins under a version, so a later shape can be told apart and carried over. */
export const StoredPins = Schema.Struct({ v: Schema.Literal(1), pins: Pins })
export type StoredPins = typeof StoredPins.Type

/** Pinning refused: the device already keeps {@link MAX_PINS}. */
export class PinLimitReached extends Data.TaggedError("PinLimitReached")<{ readonly limit: number }> {}

/** What a pin needs from an agent in the directory. */
export interface PinnableAgent {
  readonly host: string
  readonly id: string
  readonly key: string
  readonly name: string
}

/** Rounded to the minute: "not seen since" never needs more, and a stable value spares a write each poll. */
const minute = (at: number): number => Math.floor(at / 60_000) * 60_000

/** Pins `agent` at the end; already pinned leaves the order as it is. */
export const pin = (pins: Pins, agent: PinnableAgent, now: number): Result.Result<Pins, PinLimitReached> => {
  if (pins.some((existing) => existing.key === agent.key)) return Result.succeed(pins)
  if (pins.length >= MAX_PINS) return Result.fail(new PinLimitReached({ limit: MAX_PINS }))
  return Result.succeed([
    ...pins,
    { host: agent.host, id: agent.id, key: agent.key, name: agent.name, seenAt: minute(now) }
  ])
}

/** Removes the pin for `key`; the rest keep their order. */
export const unpin = (pins: Pins, key: string): Pins => pins.filter((existing) => existing.key !== key)

/**
 * Records which pinned agents this poll saw: their names and the minute. Returns the same list when nothing
 * changed, so the caller can skip a write.
 */
export const observePins = (pins: Pins, present: ReadonlyArray<PinnableAgent>, now: number): Pins => {
  const byKey = new Map(present.map((agent) => [agent.key, agent]))
  let changed = false
  const next = pins.map((existing) => {
    const agent = byKey.get(existing.key)
    if (agent === undefined) return existing
    const seenAt = minute(now)
    if (existing.seenAt === seenAt && existing.name === agent.name) return existing
    changed = true
    return { ...existing, name: agent.name, seenAt }
  })
  return changed ? next : pins
}

/** A pin with the agent it names this poll, or `undefined` while that agent is away. */
export interface PinView<A> {
  readonly pin: Pin
  readonly agent: A | undefined
}

/** Pins split for display: chips first, the rest behind the overflow button. */
export interface PinArrangement<A> {
  readonly shown: ReadonlyArray<PinView<A>>
  readonly overflow: ReadonlyArray<PinView<A>>
}

/**
 * Splits pins into those shown as chips and those behind the overflow button: the first `room` pins whose
 * agent is present, in pin order; every other pin, present or away, goes to the overflow, still in pin order.
 */
export const arrangePins = <A>(
  pins: Pins,
  agentFor: (key: string) => A | undefined,
  room: number,
  hidden: (key: string) => boolean = () => false
): PinArrangement<A> => {
  const views = pins.filter((existing) => !hidden(existing.key)).map((existing) => ({
    agent: agentFor(existing.key),
    pin: existing
  }))
  const shown = views.filter((view) => view.agent !== undefined).slice(0, Math.max(0, room))
  const overflow = views.filter((view) => !shown.includes(view))
  return { overflow, shown }
}
