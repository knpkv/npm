/** Scroll-position reads spawn a process each, so the caps and the unknown state are the contract. */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  makePaneScrollReporter,
  makeReadWindow,
  PaneScrollReadError,
  readPaneScrollOffset
} from "../src/internal/pane-scroll.js"

describe("read window", () => {
  it("grants at most the limit within a second and frees as reads age out", () => {
    const window = makeReadWindow(2)
    expect(window.tryTake(0)).toBe(true)
    expect(window.tryTake(100)).toBe(true)
    expect(window.tryTake(200)).toBe(false)
    expect(window.nextFreeAt(200)).toBe(1_000)
    expect(window.tryTake(1_000)).toBe(true)
  })
})

/** A reporter over scripted reads, with the states it reports collected as they arrive. */
const reporterWith = (outcomes: ReadonlyArray<number | "fail">, hostLimit = 10) =>
  Effect.gen(function*() {
    let calls = 0
    const read = Effect.suspend(() => {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)]
      calls += 1
      return outcome === "fail" || outcome === undefined
        ? Effect.fail(new PaneScrollReadError({ cause: "scripted", detail: "scripted failure" }))
        : Effect.succeed(outcome)
    })
    const reporter = yield* makePaneScrollReporter(read, makeReadWindow(hostLimit))
    const seen: Array<number | null> = []
    const stamps: Array<number> = []
    yield* Effect.forkScoped(
      Stream.runForEach(reporter.states, (state) =>
        Effect.sync(() => {
          seen.push(state.offsetFromBottom)
          stamps.push(state.scrollsForwarded)
        }))
    )
    return { reporter, seen, stamps, calls: () => calls }
  })

describe("pane scroll reporter", () => {
  it.effect("collapses a burst of requests into one read after it settles", () =>
    Effect.scoped(Effect.gen(function*() {
      const { calls, reporter, seen } = yield* reporterWith([12])
      for (let index = 0; index < 5; index += 1) yield* reporter.request
      yield* TestClock.adjust("200 millis")
      expect(calls()).toBe(1)
      expect(seen).toEqual([12])
      // Scrolled back, so output moves the position: a frame asks for another read.
      yield* reporter.frameSeen
      yield* TestClock.adjust("1 second")
      expect(calls()).toBe(2)
    })))

  it.effect("waits for the session window rather than dropping the read that ends a burst", () =>
    Effect.scoped(Effect.gen(function*() {
      const { calls, reporter, seen } = yield* reporterWith([3, 7, 9])
      yield* reporter.request
      yield* TestClock.adjust("200 millis")
      yield* reporter.request
      yield* TestClock.adjust("200 millis")
      yield* reporter.request
      // Two reads in this second already: the third waits for the window, then lands.
      yield* TestClock.adjust("200 millis")
      expect(calls()).toBe(2)
      yield* TestClock.adjust("1 second")
      expect(calls()).toBe(3)
      expect(seen).toEqual([3, 7, 9])
    })))

  it.effect("does not queue reads past the host cap, but retries once when the host window frees", () =>
    Effect.scoped(Effect.gen(function*() {
      const { calls, reporter, seen } = yield* reporterWith([4, 8], 1)
      yield* reporter.request
      yield* TestClock.adjust("200 millis")
      yield* reporter.request
      yield* TestClock.adjust("200 millis")
      // Past the host cap: nothing read now, the last known position stands meanwhile.
      expect(calls()).toBe(1)
      expect(seen).toEqual([4])
      // The final read after scrolling still lands once the window frees.
      yield* TestClock.adjust("1 second")
      expect(calls()).toBe(2)
      expect(seen).toEqual([4, 8])
    })))

  it.effect("reports a failed read as unknown, never as the bottom, and repeats nothing unchanged", () =>
    Effect.scoped(Effect.gen(function*() {
      const { reporter, seen } = yield* reporterWith(["fail", "fail", 5, 5])
      for (let round = 0; round < 4; round += 1) {
        yield* reporter.request
        yield* TestClock.adjust("1 second")
      }
      expect(seen).toEqual([null, 5])
    })))
})

// The guarantee: every reported offset was read while no scroll was in flight, so it already
// includes every scroll the session forwarded.
describe("quiet pane readings", () => {
  it.effect("never reads while a forwarded scroll is unlanded or recent", () =>
    Effect.scoped(Effect.gen(function*() {
      const { calls, reporter, seen, stamps } = yield* reporterWith([7])
      yield* reporter.scrollForwarded
      yield* TestClock.adjust("800 millis")
      // herdr has not shown the scroll applied yet, so no read.
      expect(calls()).toBe(0)
      yield* reporter.frameSeen
      yield* TestClock.adjust("100 millis")
      expect(calls()).toBe(0)
      // Landed and quiet: now it reads.
      yield* TestClock.adjust("1 second")
      expect(calls()).toBe(1)
      expect(seen).toEqual([7])
      // Stamped with the scrolls forwarded before it, for the client to compare with its own count.
      expect(stamps).toEqual([1])
    })))

  it.effect("drops a reading when a scroll was forwarded while it ran, and reads again", () =>
    Effect.scoped(Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      let calls = 0
      const read = Effect.gen(function*() {
        calls += 1
        if (calls === 1) {
          yield* Deferred.await(gate)
          // Sampled before the scroll below reached herdr.
          return 5
        }
        return 8
      })
      const reporter = yield* makePaneScrollReporter(read, makeReadWindow(10))
      const seen: Array<number | null> = []
      yield* Effect.forkScoped(
        Stream.runForEach(reporter.states, (state) => Effect.sync(() => seen.push(state.offsetFromBottom)))
      )
      yield* reporter.request
      yield* TestClock.adjust("200 millis")
      expect(calls).toBe(1)
      yield* reporter.scrollForwarded
      yield* reporter.frameSeen
      yield* Deferred.succeed(gate, undefined)
      yield* TestClock.adjust("2 seconds")
      expect(calls).toBe(2)
      expect(seen).toEqual([8])
    })))

  it.effect("reports the same offset again after scrolls, which herdr may have clamped", () =>
    Effect.scoped(Effect.gen(function*() {
      const { reporter, seen } = yield* reporterWith([40, 40, 40])
      yield* reporter.request
      yield* TestClock.adjust("1 second")
      yield* reporter.scrollForwarded
      yield* reporter.frameSeen
      yield* TestClock.adjust("1 second")
      // A plain re-read with nothing forwarded since is not news.
      yield* reporter.request
      yield* TestClock.adjust("1 second")
      expect(seen).toEqual([40, 40])
    })))

  it.effect("a scroll herdr never renders blocks reads only for a second", () =>
    Effect.scoped(Effect.gen(function*() {
      const { calls, reporter } = yield* reporterWith([0])
      yield* reporter.scrollForwarded
      yield* TestClock.adjust("900 millis")
      expect(calls()).toBe(0)
      yield* TestClock.adjust("500 millis")
      expect(calls()).toBe(1)
    })))

  it.effect("at the bottom, a frame re-reads within two seconds even if no other frame follows", () =>
    Effect.scoped(Effect.gen(function*() {
      const { calls, reporter, seen } = yield* reporterWith([0, 40])
      yield* reporter.request
      yield* TestClock.adjust("1 second")
      // Another viewer scrolled the pane back; its one frame lands inside the refresh interval.
      yield* reporter.frameSeen
      yield* TestClock.adjust("500 millis")
      expect(calls()).toBe(1)
      // No further frame: the pending refresh still reads it once the interval ends.
      yield* TestClock.adjust("2 seconds")
      expect(calls()).toBe(2)
      expect(seen).toEqual([0, 40])
      // Nothing pending any more: a quiet pane is not polled.
      yield* TestClock.adjust("6 seconds")
      expect(calls()).toBe(2)
    })))

  it.effect("after a failed read, a later frame tries again", () =>
    Effect.scoped(Effect.gen(function*() {
      const { reporter, seen } = yield* reporterWith(["fail", 9])
      yield* reporter.request
      yield* TestClock.adjust("2500 millis")
      yield* reporter.frameSeen
      yield* TestClock.adjust("1 second")
      expect(seen).toEqual([null, 9])
    })))
})

// it.effect runs on a TestClock already, so the reporter tests need no clock of their own.
describe("readPaneScrollOffset", () => {
  const fakeHerdr = (body: string) => {
    const root = mkdtempSync(join(tmpdir(), "herdr-pane-scroll-"))
    const command = join(root, "herdr")
    writeFileSync(command, `#!/bin/sh\n${body}\n`)
    chmodSync(command, 0o700)
    return { command, root }
  }
  const read = (command: string, root: string) =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return yield* Effect.result(readPaneScrollOffset(spawner, command, root, "w1:p9"))
    })

  // Real processes and real timeouts, so these run on the live clock.
  it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect("reads offset_from_bottom from herdr pane get", () => {
      const { command, root } = fakeHerdr(
        `[ "$1 $2 $3" = "pane get w1:p9" ] || exit 3
printf '%s\\n' '{"result":{"pane":{"pane_id":"w1:p9","scroll":{"offset_from_bottom":8176,"viewport_rows":40}}}}'`
      )
      return read(command, root).pipe(Effect.map((result) => expect(result).toMatchObject({ success: 8176 })))
    })

    it.effect("gives up on a herdr that never answers and ignores SIGTERM", () => {
      const stuck = fakeHerdr("trap '' TERM\nwhile :; do sleep 60; done")
      return read(stuck.command, stuck.root).pipe(
        Effect.map((result) => expect(result).toMatchObject({ failure: { detail: "herdr pane get timed out" } }))
      )
    }, 10_000)

    it.effect("fails on output without a scroll position or a non-zero exit", () => {
      const missing = fakeHerdr(`printf '%s\\n' '{"result":{"pane":{}}}'`)
      const exits = fakeHerdr("exit 1")
      return Effect.gen(function*() {
        expect(yield* read(missing.command, missing.root)).toMatchObject({ failure: { _tag: "PaneScrollReadError" } })
        expect(yield* read(exits.command, exits.root)).toMatchObject({ failure: { _tag: "PaneScrollReadError" } })
      })
    })
  })
})
