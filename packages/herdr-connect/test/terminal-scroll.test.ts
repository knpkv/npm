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

  it("scrolls toward the newest output as far as the floor allows", () => {
    // A server that says the pane is 3 lines back lets the client come down those 3, no further.
    const track = makeScrollTrack(() => cell, () => -3)
    track.pan(-200)
    expect(track.take()).toEqual({ direction: "down", lines: 3 })
    expect(track.take()).toBeNull()
    // Part of a line toward the bottom is never sent.
    const partial = makeScrollTrack(() => cell, () => -3)
    partial.pan(-20)
    expect(partial.take()).toEqual({ direction: "down", lines: 1 })
  })

  it("a confirmed position settles scrolls herdr drew no frame for", () => {
    // Page Up at the top: herdr clamps it and draws nothing, so no frame acknowledges it.
    const track = makeScrollTrack(() => cell)
    track.pan(45)
    expect(track.take()).toEqual({ direction: "up", lines: 3 })
    expect(track.translate()).toBe(45)
    track.acknowledgeAll()
    expect(track.translate()).toBe(0)
    expect(track.take()).toBeNull()
  })

  it("a confirmation keeps travel that was not sent yet", () => {
    // Part of a line under the finger stays drawn, and still becomes a line once it is covered.
    const finger = makeScrollTrack(() => cell)
    finger.pan(25)
    expect(finger.take()).toEqual({ direction: "up", lines: 1 })
    finger.acknowledgeAll()
    expect(finger.translate()).toBe(10)
    finger.pan(10)
    expect(finger.take()).toEqual({ direction: "up", lines: 1 })
    // A page panned but not yet taken (it goes out on the next frame) is still sent.
    const page = makeScrollTrack(() => cell)
    page.pan(60)
    page.acknowledgeAll()
    expect(page.take()).toEqual({ direction: "up", lines: 4 })
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
