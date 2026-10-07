/**
 * One touch gesture model for the terminal: tap, vertical pan, fling and long-press.
 *
 * Pure: the client feeds touch positions and timestamps and acts on the returned events. A touch
 * stays a candidate tap until it travels past the slop; then it locks to an axis. Only a vertical
 * lock scrolls — a horizontal swipe is left alone. A long-press is reported only when the finger
 * has not left the slop by the time the client's timer asks for it.
 *
 * @module
 */

/** Distance a finger may wander and still tap or long-press. */
export const touchSlopPx = 8
/** Hold time that turns a still touch into a long-press. */
export const longPressMs = 450
/** Release velocity below which a pan just stops, in px/ms. */
export const minimumFlingVelocity = 0.15
const velocityWindowMs = 100

export type GestureEvent =
  | { readonly _tag: "None" }
  | { readonly _tag: "Tap"; readonly x: number; readonly y: number }
  | { readonly _tag: "LongPress"; readonly x: number; readonly y: number }
  /** Incremental vertical travel; positive when the finger moves down, towards older output. */
  | { readonly _tag: "Pan"; readonly dy: number }
  /** Release velocity in px/ms, same sign convention as `Pan`. */
  | { readonly _tag: "Fling"; readonly velocity: number }
  | { readonly _tag: "PanEnd" }

type Phase =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Pending"; readonly x: number; readonly y: number; readonly t: number }
  | { readonly _tag: "Vertical"; readonly lastY: number }
  | { readonly _tag: "Ignored" }

type Sample = { readonly t: number; readonly y: number }

const none: GestureEvent = { _tag: "None" }

export interface TouchGesture {
  readonly start: (x: number, y: number, t: number) => void
  readonly move: (x: number, y: number, t: number) => GestureEvent
  readonly end: (t: number) => GestureEvent
  /** Called by the client's long-press timer; reports a long-press only if the touch is still. */
  readonly holdElapsed: (t: number) => GestureEvent
  readonly cancel: () => void
  /** Whether the current touch is scrolling, so the client can claim it from the page. */
  readonly scrolling: () => boolean
}

export const makeTouchGesture = (): TouchGesture => {
  let phase: Phase = { _tag: "Idle" }
  let samples: Array<Sample> = []
  const record = (t: number, y: number): void => {
    samples = [...samples.filter((sample) => t - sample.t <= velocityWindowMs), { t, y }]
  }
  // Velocity over the window before the last move, not before the lift: touchmove can arrive
  // 50 ms apart on a busy page, and a lift that soon after a move is still a flick. Only a
  // finger that rests longer than the window before lifting has stopped.
  const releaseVelocity = (t: number): number => {
    const last = samples.at(-1)
    if (last === undefined || t - last.t > velocityWindowMs) return 0
    const first = samples.find((sample) => last.t - sample.t <= velocityWindowMs)
    if (first === undefined || last.t === first.t) return 0
    return (last.y - first.y) / (last.t - first.t)
  }
  return {
    start: (x, y, t) => {
      phase = { _tag: "Pending", x, y, t }
      samples = [{ t, y }]
    },
    move: (x, y, t) => {
      if (phase._tag === "Pending") {
        const dx = x - phase.x
        const dy = y - phase.y
        if (Math.hypot(dx, dy) < touchSlopPx) return none
        if (Math.abs(dx) > Math.abs(dy)) {
          phase = { _tag: "Ignored" }
          return none
        }
        // The slop is consumed, not dropped: content starts moving with the finger from here on.
        phase = { _tag: "Vertical", lastY: y }
        record(t, y)
        return { _tag: "Pan", dy }
      }
      if (phase._tag === "Vertical") {
        const dy = y - phase.lastY
        phase = { _tag: "Vertical", lastY: y }
        record(t, y)
        return dy === 0 ? none : { _tag: "Pan", dy }
      }
      return none
    },
    end: (t) => {
      const ended = phase
      phase = { _tag: "Idle" }
      if (ended._tag === "Pending") return { _tag: "Tap", x: ended.x, y: ended.y }
      if (ended._tag !== "Vertical") return none
      const velocity = releaseVelocity(t)
      return Math.abs(velocity) >= minimumFlingVelocity ? { _tag: "Fling", velocity } : { _tag: "PanEnd" }
    },
    holdElapsed: (t) => {
      if (phase._tag !== "Pending" || t - phase.t < longPressMs) return none
      const { x, y } = phase
      phase = { _tag: "Ignored" }
      return { _tag: "LongPress", x, y }
    },
    cancel: () => {
      phase = { _tag: "Idle" }
      samples = []
    },
    scrolling: () => phase._tag === "Vertical"
  }
}
