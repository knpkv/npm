import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures.ts"

type Motion = "no-preference" | "reduce"

/** The activity catalog with the system and in-app reduced-motion settings given separately. */
const open = async (page: Page, system: Motion, inApp: Motion): Promise<void> => {
  await page.emulateMedia({ reducedMotion: system })
  await page.goto(
    `/iframe.html?id=patterns-relaymark--activity&viewMode=story&globals=reducedMotion:${inApp};forcedColors:auto`
  )
  await expect(page.locator("[data-activity='working'] svg")).toHaveCount(2)
}

/** Names of the animations running on marks showing an activity (or the entrance), sorted. */
const running = (page: Page, selector: string): Promise<ReadonlyArray<string>> =>
  page.locator(selector).evaluateAll((elements) =>
    elements
      .flatMap((element) => element.getAnimations({ subtree: true }))
      .filter((animation) => animation.playState === "running")
      .map((animation) => ("animationName" in animation ? String(animation.animationName) : "?"))
      .sort()
  )

test.describe("RelayMark motion", () => {
  test("moves while working when the reader allows motion", async ({ page }) => {
    await open(page, "no-preference", "no-preference")
    await expect.poll(() => running(page, "[data-activity='idle'] svg")).toEqual([])
    const working = await running(page, "[data-activity='working'] svg")
    expect(working).toHaveLength(2)
    for (const name of working) expect(name).toMatch(/relay-mark-pass/)
    const box = await page.locator("[data-activity='working'] svg").first().boundingBox()
    await page.waitForTimeout(400)
    // The glyph's box stays put while its baton moves: no layout shift.
    expect(await page.locator("[data-activity='working'] svg").first().boundingBox()).toEqual(box)
  })

  test("holds still under the system reduced-motion preference", async ({ page }) => {
    await open(page, "reduce", "no-preference")
    expect(await running(page, "svg[data-rly-relay-activity]")).toEqual([])
  })

  test("holds still under the in-app reduced-motion setting", async ({ page }) => {
    await open(page, "no-preference", "reduce")
    expect(await running(page, "svg[data-rly-relay-activity]")).toEqual([])
  })

  test("stays drawn in forced colours while it works", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "no-preference" })
    await page.goto(
      "/iframe.html?id=patterns-relaymark--activity&viewMode=story&globals=reducedMotion:no-preference;forcedColors:active"
    )
    const baton = page.locator("[data-activity='working'] svg path").last()
    await expect(baton).toBeVisible()
    const minimum = await baton.evaluate((element) => {
      const animation = element.getAnimations()[0]
      if (animation === undefined) return null
      animation.pause()
      animation.currentTime = 0
      return Number(getComputedStyle(element).opacity)
    })
    // The faintest point of the pass still draws the baton; no animation at all would prove nothing.
    expect(minimum).not.toBeNull()
    expect(minimum).toBeGreaterThanOrEqual(0.5)
  })
})
