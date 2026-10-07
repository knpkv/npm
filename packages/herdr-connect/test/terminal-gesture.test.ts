/** One gesture model decides tap, scroll, fling and long-press, so each must exclude the others. */
import { describe, expect, it } from "@effect/vitest"
import { longPressMs, makeTouchGesture } from "../src/terminal-gesture.js"

describe("touch gesture", () => {
  it("a still touch is a tap at its start point", () => {
    const gesture = makeTouchGesture()
    gesture.start(10, 20, 0)
    expect(gesture.move(13, 22, 30)).toEqual({ _tag: "None" })
    expect(gesture.end(60)).toEqual({ _tag: "Tap", x: 10, y: 20 })
  })

  it("a vertical drag pans by the full travel, including the slop", () => {
    const gesture = makeTouchGesture()
    gesture.start(10, 100, 0)
    expect(gesture.move(10, 112, 16)).toEqual({ _tag: "Pan", dy: 12 })
    expect(gesture.move(10, 120, 32)).toEqual({ _tag: "Pan", dy: 8 })
    expect(gesture.scrolling()).toBe(true)
    expect(gesture.end(400)._tag).toBe("PanEnd")
  })

  it("a horizontal swipe neither scrolls nor taps", () => {
    const gesture = makeTouchGesture()
    gesture.start(10, 100, 0)
    expect(gesture.move(40, 104, 16)).toEqual({ _tag: "None" })
    expect(gesture.move(60, 140, 32)).toEqual({ _tag: "None" })
    expect(gesture.end(48)).toEqual({ _tag: "None" })
  })

  it("a quick release flings with the recent velocity", () => {
    const gesture = makeTouchGesture()
    gesture.start(0, 0, 0)
    gesture.move(0, 20, 10)
    gesture.move(0, 40, 20)
    gesture.move(0, 60, 30)
    const release = gesture.end(30)
    expect(release._tag).toBe("Fling")
    if (release._tag === "Fling") expect(release.velocity).toBeCloseTo(2, 5)
  })

  // Timestamps from a real headless run: moves ~50 ms apart, the one before last 105 ms before the lift.
  it("flings when moves arrive 50 ms apart and the lift follows the last one", () => {
    const gesture = makeTouchGesture()
    gesture.start(0, 0, 0)
    gesture.move(0, 24, 45)
    gesture.move(0, 48, 95)
    gesture.move(0, 72, 145)
    const release = gesture.end(200)
    expect(release._tag).toBe("Fling")
    if (release._tag === "Fling") expect(release.velocity).toBeCloseTo(0.48, 5)
  })

  it("a finger that rests before lifting just stops", () => {
    const gesture = makeTouchGesture()
    gesture.start(0, 0, 0)
    gesture.move(0, 30, 10)
    gesture.move(0, 60, 20)
    expect(gesture.end(200)).toEqual({ _tag: "PanEnd" })
  })

  it("long-press needs the full hold and a still finger, and is never also a tap", () => {
    const gesture = makeTouchGesture()
    gesture.start(5, 5, 0)
    expect(gesture.holdElapsed(longPressMs - 1)).toEqual({ _tag: "None" })
    expect(gesture.holdElapsed(longPressMs)).toEqual({ _tag: "LongPress", x: 5, y: 5 })
    expect(gesture.end(longPressMs + 50)).toEqual({ _tag: "None" })

    const moved = makeTouchGesture()
    moved.start(5, 5, 0)
    moved.move(5, 30, 100)
    expect(moved.holdElapsed(longPressMs)).toEqual({ _tag: "None" })
  })
})
