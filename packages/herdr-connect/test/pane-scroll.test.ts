/** Scroll-position reads spawn a process each, so the caps and the unknown state are the contract. */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
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

// Each test effect is an application boundary; @effect/vitest scopes its test layer.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideTestClock = Effect.provide(TestClock.layer())
// The reader tests spawn a real fake herdr, so they own the Node services for their lifetime.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

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
    let forwarded = 0
    const read = Effect.suspend(() => {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)]
      calls += 1
      return outcome === "fail" || outcome === undefined
        ? Effect.fail(new PaneScrollReadError({ cause: "scripted", detail: "scripted failure" }))
        : Effect.succeed(outcome)
    })
    const reporter = yield* makePaneScrollReporter(read, makeReadWindow(hostLimit), () => forwarded)
    const seen: Array<number | null> = []
    const commands: Array<number> = []
    yield* Effect.forkScoped(
      Stream.runForEach(reporter.states, (state) =>
        Effect.sync(() => {
          seen.push(state.offsetFromBottom)
          commands.push(state.scrollCommands)
        }))
    )
    return {
      reporter,
      seen,
      commands,
      calls: () => calls,
      forward: () => {
        forwarded += 1
      }
    }
  })

describe("pane scroll reporter", () => {
  it.effect("collapses a burst of requests into one read after it settles", () =>
    Effect.scoped(Effect.gen(function*() {
      const { calls, reporter, seen } = yield* reporterWith([12])
      for (let index = 0; index < 5; index += 1) yield* reporter.request
      yield* TestClock.adjust("200 millis")
      expect(calls()).toBe(1)
      expect(seen).toEqual([12])
      expect(reporter.scrolledBack()).toBe(true)
    })).pipe(provideTestClock))

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
    })).pipe(provideTestClock))

  it.effect("drops reads past the host cap and keeps the last known position", () =>
    Effect.scoped(Effect.gen(function*() {
      const { calls, reporter, seen } = yield* reporterWith([4, 8], 1)
      yield* reporter.request
      yield* TestClock.adjust("200 millis")
      yield* reporter.request
      yield* TestClock.adjust("200 millis")
      expect(calls()).toBe(1)
      expect(seen).toEqual([4])
    })).pipe(provideTestClock))

  it.effect("reports a failed read as unknown, never as the bottom, and repeats nothing unchanged", () =>
    Effect.scoped(Effect.gen(function*() {
      const { reporter, seen } = yield* reporterWith(["fail", "fail", 5, 5])
      for (let round = 0; round < 4; round += 1) {
        yield* reporter.request
        yield* TestClock.adjust("1 second")
      }
      expect(seen).toEqual([null, 5])
      expect(reporter.scrolledBack()).toBe(true)
    })).pipe(provideTestClock))
})

describe("pane scroll reporter coverage", () => {
  it.effect("stamps each reading with the scrolls forwarded before it and reports the same offset again once more are covered", () =>
    Effect.scoped(Effect.gen(function*() {
      // A scroll clamped at the top leaves the offset unchanged, but the client already assumed it moved.
      const { commands, forward, reporter, seen } = yield* reporterWith([40, 40, 40])
      yield* reporter.request
      yield* TestClock.adjust("1 second")
      forward()
      yield* reporter.request
      yield* TestClock.adjust("1 second")
      yield* reporter.request
      yield* TestClock.adjust("1 second")
      expect(seen).toEqual([40, 40])
      expect(commands).toEqual([0, 1])
    })).pipe(provideTestClock))
})

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
    }).pipe(provideNodeServices)

  it.effect("reads offset_from_bottom from herdr pane get", () => {
    const { command, root } = fakeHerdr(
      `[ "$1 $2 $3" = "pane get w1:p9" ] || exit 3
printf '%s\\n' '{"result":{"pane":{"pane_id":"w1:p9","scroll":{"offset_from_bottom":8176,"viewport_rows":40}}}}'`
    )
    return read(command, root).pipe(Effect.map((result) => expect(result).toMatchObject({ success: 8176 })))
  })

  it.live("gives up on a herdr that never answers and ignores SIGTERM", () => {
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
