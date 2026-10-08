import type { Locator } from "@playwright/test"
import { expect, test } from "./fixtures.ts"

// Runs in the `coarse` project, whose Chromium reports a coarse primary pointer (see playwright.config.ts).
const story = (id: string): string =>
  `/iframe.html?id=${id}&viewMode=story&globals=theme:dark;forcedColors:auto;reducedMotion:reduce;locale:en;density:comfortable`

const height = async (locator: Locator): Promise<number> => Math.round((await locator.boundingBox())?.height ?? 0)

test("grows dense and compact controls to the 44px touch target under a coarse pointer", async ({ page }) => {
  await page.setViewportSize({ height: 1_000, width: 390 })
  await page.goto(story("primitives-field--states"))
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
  expect(await height(page.getByRole("textbox", { name: /Release name/ }))).toBe(44)
  expect(await height(page.getByRole("combobox", { name: "Environment" }))).toBe(44)

  await page.goto(story("primitives-button--states"))
  expect(await height(page.locator("[data-button-size=\"dense\"]"))).toBe(44)
  expect(await height(page.locator("[data-button-size=\"compact\"]"))).toBe(44)
  expect(await height(page.locator("[data-button-size=\"default\"]"))).toBe(48)

  // Each option is the target, not the group around it: every radio is at least 44 by 44.
  await page.goto(story("primitives-togglegroup--interaction"))
  for (const name of ["Range", "Range (compact)"]) {
    const radios = page.getByRole("radiogroup", { exact: true, name }).getByRole("radio")
    for (const box of await radios.evaluateAll((items) => items.map((item) => item.getBoundingClientRect()))) {
      expect(Math.round(box.height)).toBeGreaterThanOrEqual(44)
      expect(Math.round(box.width)).toBeGreaterThanOrEqual(44)
    }
  }
})
