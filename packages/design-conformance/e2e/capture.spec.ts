import { expect, test } from "@playwright/test"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"

import { capturePage } from "../src/browser.js"
import { installCaptureClock, VISUAL_TIME } from "../src/capture.js"

test("capture waits for native frames after masking, even with a paused clock", async ({ page }) => {
  await installCaptureClock(page)
  await page.clock.pauseAt(new Date(VISUAL_TIME))
  await page.setContent("<main data-region=\"content\">Workspace 12345678-1234-1234-1234-123456789012</main>")

  const entered = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  const waitForFunction = page.waitForFunction.bind(page)
  const screenshot = page.screenshot.bind(page)
  let barrierPassed = false
  let screenshots = 0
  page.waitForFunction = async <R, Arg>(...args: Parameters<typeof page.waitForFunction<R, Arg>>) => {
    // This seam holds the real barrier, while the test observes screenshot ordering.
    expect(await page.locator("[data-visual-uuid]").count()).toBe(1)
    await Effect.runPromise(Deferred.succeed(entered, undefined))
    await Effect.runPromise(Deferred.await(release))
    const handle = await waitForFunction<R, Arg>(...args)
    barrierPassed = true
    return handle
  }
  page.screenshot = async (options) => {
    expect(barrierPassed).toBe(true)
    screenshots += 1
    return screenshot(options)
  }
  const capture = Effect.runPromise(capturePage(page))
  try {
    await Promise.race([Effect.runPromise(Deferred.await(entered)), capture])
    expect(screenshots).toBe(0)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await capture
  }
  const result = await capture
  expect(result.frame.byteLength).toBeGreaterThan(0)
  expect(screenshots).toBe(1)
  expect(await page.locator("[data-visual-uuid]").count()).toBe(0)
})

test("an oversized full-page frame fails before the screenshot protocol call", async ({ page }) => {
  await page.setContent("<main data-region=\"content\" style=\"width:17000px\">Workspace</main>")
  const screenshot = page.screenshot.bind(page)
  let screenshots = 0
  page.screenshot = async (options) => {
    screenshots += 1
    return screenshot(options)
  }
  const result = await Effect.runPromise(capturePage(page).pipe(Effect.exit))
  expect(result._tag).toBe("Failure")
  expect(screenshots).toBe(0)
})
