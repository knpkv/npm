import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, test } from "@playwright/test"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { mock } from "node:test"

import { capturePage } from "../src/browser.js"
import { installCaptureClock } from "../src/capture.js"
import { CaptureNavigationFailure } from "../src/schema.js"
import { localServer } from "./fixtures.js"

const shot = "toy--passing--1280--light"
const reloadHtml = `<!doctype html><html><head><style>
  body { margin: 0; font-size: 16px; } main { block-size: 59.0625em; }+</style></head><body><main data-region=content>Capture workspace</main><script>
  matchMedia("(max-width: 599px)").addEventListener("change", () => location.reload());
</script></body></html>`

/** Chromium's full-page 1x1 emulation crosses the breakpoint and reloads this real fixture. */
test("a breakpoint reload fails the pending capture promptly with its shot identity", async ({ page }) => {
  test.setTimeout(10_000)
  await Effect.runPromise(
    Effect.gen(function*() {
      const origin = yield* localServer(() => HttpServerResponse.html(reloadHtml))
      yield* Effect.promise(() => page.setViewportSize({ width: 1280, height: 800 }))
      yield* Effect.promise(() => installCaptureClock(page))
      yield* Effect.promise(() => page.goto(`${origin}/reload`))
      const registered = yield* Effect.acquireRelease(
        Effect.sync(() => mock.method(page, "on")),
        (on) => Effect.sync(() => on.mock.restore())
      )
      const removed = yield* Effect.acquireRelease(
        Effect.sync(() => mock.method(page, "off")),
        (off) => Effect.sync(() => off.mock.restore())
      )
      const start = yield* Clock.currentTimeMillis
      const failure = yield* capturePage(page, shot).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(CaptureNavigationFailure)
      expect(failure).toMatchObject({ _tag: "CaptureNavigationFailure", shot, url: `${origin}/reload` })
      expect(failure.message).toContain(shot)
      expect((yield* Clock.currentTimeMillis) - start).toBeLessThan(5_000)
      const handlers = registered.mock.calls.filter(({ arguments: [event] }) =>
        ["framenavigated", "load"].includes(event)
      ).map(({ arguments: args }) => args)
      expect(handlers).toEqual(expect.arrayContaining([
        ["framenavigated", expect.any(Function)],
        ["load", expect.any(Function)]
      ]))
      expect(removed.mock.calls.map(({ arguments: args }) => args)).toEqual(expect.arrayContaining(handlers))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

/** Subframe navigation is normal page activity and must not invalidate the main document capture. */
test("iframe navigation remains allowed and successful capture removes its listeners", async ({ page }) => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const origin = yield* localServer((url) =>
        HttpServerResponse.html(
          url === "/parent"
            ? "<main data-region=content>Workspace<iframe src=/child></iframe></main>"
            : "<p>Frame workspace</p>"
        )
      )
      yield* Effect.promise(() => page.setViewportSize({ width: 390, height: 844 }))
      yield* Effect.promise(() => page.goto(`${origin}/parent`))
      const child = page.frames().find((frame) => frame !== page.mainFrame())
      expect(child).toBeDefined()
      if (child === undefined) return
      const registered = yield* Effect.acquireRelease(
        Effect.sync(() => mock.method(page, "on")),
        (on) => Effect.sync(() => on.mock.restore())
      )
      const removed = yield* Effect.acquireRelease(
        Effect.sync(() => mock.method(page, "off")),
        (off) => Effect.sync(() => off.mock.restore())
      )
      const screenshot = page.screenshot.bind(page)
      page.screenshot = async (options) => {
        await child.goto(`${origin}/next-child`)
        return screenshot(options)
      }
      try {
        const result = yield* capturePage(page, "toy--passing--390--light")
        expect(result.frame.byteLength).toBeGreaterThan(0)
        expect(result.regions.get("content")?._tag).toBe("Image")
      } finally {
        page.screenshot = screenshot
      }
      const handlers = registered.mock.calls.filter(({ arguments: [event] }) =>
        ["framenavigated", "load"].includes(event)
      ).map(({ arguments: args }) => args)
      expect(handlers).toEqual(expect.arrayContaining([
        ["framenavigated", expect.any(Function)],
        ["load", expect.any(Function)]
      ]))
      expect(removed.mock.calls.map(({ arguments: args }) => args)).toEqual(expect.arrayContaining(handlers))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
