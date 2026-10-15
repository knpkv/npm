import { expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"

import { guardCaptureNavigation, type NavigationSubscription } from "../src/navigation.js"
import { BrowserFailure, CaptureNavigationFailure } from "../src/schema.js"

const shot = "toy--passing--1280--light"

/** This real callback contract models event delivery without fabricating a Playwright Page. */
const navigationSource = () => {
  let listener: Parameters<NavigationSubscription>[0] | undefined
  let cleanups = 0
  const subscribe: NavigationSubscription = (notify) => {
    listener = notify
    return () => {
      listener = undefined
      cleanups += 1
    }
  }
  return {
    subscribe,
    listening: () => listener !== undefined,
    cleanups: () => cleanups,
    emit: (event: Parameters<Parameters<NavigationSubscription>[0]>[0]) => listener?.(event)
  }
}

for (const event of ["framenavigated", "load"] satisfies ReadonlyArray<CaptureNavigationFailure["event"]>) {
  /** A navigation must beat a permanently pending screenshot, without a timeout or retry. */
  it.effect(`${event} ends a pending capture with its shot identity and removes listeners`, () =>
    Effect.gen(function*() {
      const source = navigationSource()
      let interrupted = false
      const capture = Effect.sync(() => {
        expect(source.listening()).toBe(true)
        source.emit({ event, url: "http://fixture.test/reloaded" })
      }).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true
          })
        )
      )
      const failure = yield* guardCaptureNavigation(shot, source.subscribe, capture).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(CaptureNavigationFailure)
      expect(failure).toMatchObject({ shot, event, url: "http://fixture.test/reloaded" })
      expect(failure.message).toContain(shot)
      expect(interrupted).toBe(true)
      expect(source.listening()).toBe(false)
      expect(source.cleanups()).toBe(1)
    }))
}

it.effect("a successful capture removes listeners and ignores subsequent navigation", () =>
  Effect.gen(function*() {
    const source = navigationSource()
    const result = yield* guardCaptureNavigation(
      shot,
      source.subscribe,
      Effect.sync(() => {
        expect(source.listening()).toBe(true)
        return "frame"
      })
    )
    expect(result).toBe("frame")
    expect(source.listening()).toBe(false)
    source.emit({ event: "load", url: "http://fixture.test/later" })
    expect(source.cleanups()).toBe(1)
  }))

it.effect("ordinary capture failures preserve their original typed error and remove listeners", () =>
  Effect.gen(function*() {
    const source = navigationSource()
    const failure = new BrowserFailure({ operation: "capture regions", cause: "bad frame" })
    expect(yield* guardCaptureNavigation(shot, source.subscribe, Effect.fail(failure)).pipe(Effect.flip)).toBe(failure)
    expect(source.listening()).toBe(false)
    expect(source.cleanups()).toBe(1)
  }))

it.effect("the first navigation remains the diagnostic when reload also emits load", () =>
  Effect.gen(function*() {
    const source = navigationSource()
    const capture = Effect.sync(() => {
      source.emit({ event: "framenavigated", url: "http://fixture.test/first" })
      source.emit({ event: "load", url: "http://fixture.test/second" })
    }).pipe(Effect.andThen(Effect.never))
    const failure = yield* guardCaptureNavigation(shot, source.subscribe, capture).pipe(Effect.flip)
    expect(failure).toMatchObject({ event: "framenavigated", url: "http://fixture.test/first" })
    expect(source.cleanups()).toBe(1)
  }))

it.effect("interrupting capture removes the observation subscription", () =>
  Effect.gen(function*() {
    const source = navigationSource()
    const entered = yield* Deferred.make<void>()
    const capture = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
    const fiber = yield* guardCaptureNavigation(shot, source.subscribe, capture).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    expect(source.listening()).toBe(true)
    yield* Fiber.interrupt(fiber)
    expect(source.listening()).toBe(false)
    expect(source.cleanups()).toBe(1)
  }))
