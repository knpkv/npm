import { expect, type Locator, test } from "@playwright/test"

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
})
