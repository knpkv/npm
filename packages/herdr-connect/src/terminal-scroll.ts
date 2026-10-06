/**
 * Smooth touch scrolling over a server that only scrolls in whole lines.
 *
 * herdr owns the scrollback, so the client asks for whole lines and waits for a re-rendered
 * screen. To track the finger 1:1, the track keeps the finger's total travel, sends the whole
 * lines it covers, and draws the remainder — plus any lines sent but not yet rendered — as a
 * transform on the canvas. When a frame arrives the sent lines count as applied and the transform
 * shrinks by the same amount, so content does not jump.
 *
 * Pure: the client calls `pan` from gestures and momentum, `take` once per animation frame to
 * send at most one command, and `frameArrived` when output lands.
 *
 * @module
 */

/** iOS normal deceleration: velocity keeps this fraction of itself every millisecond. */
export const decelerationPerMs = 0.998
/** Momentum stops below this speed, in px/ms. */
export const stopVelocity = 0.02
/** The server takes at most this many lines per command. */
export const maximumLinesPerCommand = 400
/** Content may run this many lines ahead of the server before it stops following the finger. */
const maximumLinesAhead = 3

/** One step of momentum: distance travelled and the velocity left, in px and px/ms. */
export interface MomentumStep {
  readonly distance: number
  readonly velocity: number
}

/** Travel and remaining velocity after `dtMs` of exponential deceleration. */
export const momentumStep = (velocity: number, dtMs: number): MomentumStep => {
  const kept = decelerationPerMs ** dtMs
  return { distance: (velocity * (1 - kept)) / -Math.log(decelerationPerMs), velocity: velocity * kept }
}

export interface LineScroll {
  readonly direction: "up" | "down"
  readonly lines: number
}

export interface ScrollTrack {
  /** Finger travel in px; positive moves towards older output. Never scrolls past the latest line. */
  readonly pan: (dy: number) => void
  /** Whole lines to request now, or null. Call at most once per animation frame. */
  readonly take: () => LineScroll | null
  /** A screen arrived: every line requested so far is now on it. */
  readonly frameArrived: () => void
  /** Round the remainder to the nearest line once motion ends, so no half row stays shifted. */
  readonly settle: () => void
  /** Canvas offset to draw, in px. */
  readonly translate: () => number
  /** Lines above the latest output, as far as this client has scrolled. */
  readonly linesBack: () => number
  /** Forget the scroll position; the caller brings the server back to the latest output. */
  readonly reset: () => void
}

export const makeScrollTrack = (cellHeight: () => number): ScrollTrack => {
  let travel = 0
  let requested = 0
  let applied = 0
  const cell = (): number => Math.max(1, cellHeight())
  return {
    pan: (dy) => {
      travel = Math.max(0, travel + dy)
    },
    take: () => {
      const wanted = Math.floor(travel / cell())
      const difference = wanted - requested
      if (difference === 0) return null
      const lines = Math.min(maximumLinesPerCommand, Math.abs(difference))
      requested += Math.sign(difference) * lines
      return { direction: difference > 0 ? "up" : "down", lines }
    },
    frameArrived: () => {
      applied = requested
    },
    settle: () => {
      travel = Math.round(travel / cell()) * cell()
    },
    translate: () => {
      const ahead = maximumLinesAhead * cell()
      return Math.max(-ahead, Math.min(ahead, travel - applied * cell()))
    },
    linesBack: () => requested,
    reset: () => {
      travel = 0
      requested = 0
      applied = 0
    }
  }
}
