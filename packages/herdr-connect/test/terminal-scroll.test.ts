/** The scroll track turns finger pixels into whole-line requests without content jumping. */
import { describe, expect, it } from "@effect/vitest"
import { makeScrollTrack, momentumStep } from "../src/terminal-scroll.js"

describe("scroll track", () => {
  const cell = 15

  it("follows the finger 1:1 and requests whole lines as they are covered", () => {
    const track = makeScrollTrack(() => cell)
    track.pan(10)
    expect(track.take()).toBeNull()
    expect(track.translate()).toBe(10)
    track.pan(25)
    expect(track.take()).toEqual({ direction: "up", lines: 2 })
    // Until the server renders those lines, the canvas carries the whole travel.
    expect(track.translate()).toBe(35)
    track.frameArrived()
    expect(track.translate()).toBe(5)
    expect(track.linesBack()).toBe(2)
  })

  it("each frame acknowledges only the oldest scroll still in flight", () => {
    const track = makeScrollTrack(() => cell)
    track.pan(15)
    expect(track.take()).toEqual({ direction: "up", lines: 1 })
    track.pan(15)
    expect(track.take()).toEqual({ direction: "up", lines: 1 })
    track.frameArrived()
    // One line is still in flight, so its 15 px stay drawn instead of snapping back.
    expect(track.translate()).toBe(15)
    track.frameArrived()
    expect(track.translate()).toBe(0)
    track.frameArrived()
    expect(track.translate()).toBe(0)
  })

  it("never scrolls past the latest output", () => {
    const track = makeScrollTrack(() => cell)
    track.pan(-50)
    expect(track.take()).toBeNull()
    expect(track.translate()).toBe(0)
    track.pan(30)
    track.take()
    track.pan(-100)
    expect(track.take()).toEqual({ direction: "down", lines: 2 })
  })

  it("stops following a server that has not answered for three lines", () => {
    const track = makeScrollTrack(() => cell)
    track.pan(200)
    track.take()
    expect(track.translate()).toBe(3 * cell)
  })

  it("settles to a whole line so no half row stays shifted", () => {
    const track = makeScrollTrack(() => cell)
    track.pan(38)
    track.settle()
    expect(track.take()).toEqual({ direction: "up", lines: 3 })
    track.frameArrived()
    expect(track.translate()).toBe(0)
  })

  it("reset forgets the position after a jump to the latest output", () => {
    const track = makeScrollTrack(() => cell)
    track.pan(95)
    track.take()
    track.reset()
    expect(track.linesBack()).toBe(0)
    expect(track.translate()).toBe(0)
    expect(track.take()).toBeNull()
  })
})

describe("momentum", () => {
  it("decelerates like iOS and covers the integral of the velocity", () => {
    const step = momentumStep(2, 100)
    expect(step.velocity).toBeCloseTo(2 * 0.998 ** 100, 10)
    // A fling at 2 px/ms travels about v / -ln(0.998) ≈ 999 px in total.
    expect(momentumStep(2, 100_000).distance).toBeCloseTo(2 / -Math.log(0.998), 3)
  })
})
