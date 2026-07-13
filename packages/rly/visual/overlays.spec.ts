import { expect, type Page, test } from "@playwright/test"

const story = (id: string): string =>
  `/iframe.html?id=${id}&viewMode=story&globals=theme:dark;forcedColors:auto;reducedMotion:reduce;locale:en;density:comfortable`

const expectNoHorizontalOverflow = async (page: Page): Promise<void> => {
  const dimensions = await page.locator("html").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth
  }))
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client)
}

test("keeps dialog focus, isolation, dismissal, and restoration deterministic", async ({ page }) => {
  await page.goto(story("primitives-dialog--interaction"))
  await expect(page.locator("[data-dialog-play-complete=\"true\"]")).toHaveCount(1)

  const trigger = page.getByRole("button", { name: "Review deployment" })
  await trigger.click()
  const dialog = page.getByRole("dialog", { name: "Approve production deployment" })
  const initialControl = page.getByRole("textbox", { name: /Approval reason/ })
  await expect(dialog).toBeVisible()
  await expect(initialControl).toBeFocused()
  expect(
    await page
      .locator("[data-dialog-background]")
      .evaluate((element) => ("inert" in element && typeof element.inert === "boolean" ? element.inert : false))
  ).toBe(true)
  await expect(page.locator("body")).toHaveAttribute("data-scroll-locked", "1")

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
  expect(
    await page
      .locator("[data-dialog-background]")
      .evaluate((element) => ("inert" in element && typeof element.inert === "boolean" ? element.inert : true))
  ).toBe(false)
  await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked")

  await trigger.click()
  await page.locator("[data-rly-dialog-overlay]").click({ position: { x: 4, y: 4 } })
  await expect(dialog).toHaveCount(0)
})

test("reflows dialog to a full-screen decision at compact zoom-equivalent width", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 320 })
  await page.goto(story("primitives-dialog--interaction"))
  await expect(page.locator("[data-dialog-play-complete=\"true\"]")).toHaveCount(1)
  await page.getByRole("button", { name: "Review deployment" }).click()

  const box = await page.getByRole("dialog", { name: "Approve production deployment" }).boundingBox()
  expect(box?.x).toBe(0)
  expect(box?.y).toBe(0)
  expect(Math.round(box?.width ?? 0)).toBe(320)
  expect(Math.round(box?.height ?? 0)).toBe(800)
  await expectNoHorizontalOverflow(page)
})

test("keeps only the top layer interactive across dialog and sheet nesting", async ({ page }) => {
  await page.goto(story("primitives-dialog--nested-isolation"))
  await expect(page.locator("[data-nested-overlay-play-complete=\"true\"]")).toHaveCount(1)

  const layers = page.locator("[data-rly-modal-layer]")
  const inertStates = async (): Promise<ReadonlyArray<boolean>> =>
    layers.evaluateAll((elements) =>
      elements.map((element) => "inert" in element && typeof element.inert === "boolean" ? element.inert : true)
    )

  expect(await inertStates()).toEqual([true, true, false])
  const topClose = page.getByRole("button", { name: "Close top sheet" })
  await expect(topClose).toBeFocused()
  await topClose.click()

  await expect(page.locator("[role=\"dialog\"]")).toHaveCount(2)
  expect(await inertStates()).toEqual([true, false])
  const innerClose = page.getByRole("button", { name: "Close inner dialog" })
  await expect(innerClose).toBeFocused()
  await innerClose.click()

  await expect(page.locator("[role=\"dialog\"]")).toHaveCount(1)
  expect(await inertStates()).toEqual([false])
  const outerClose = page.getByRole("button", { name: "Close outer dialog" })
  await expect(outerClose).toBeFocused()
  await outerClose.click()

  await expect(page.locator("[role=\"dialog\"]")).toHaveCount(0)
  expect(
    await page
      .locator("[data-nested-overlay-background]")
      .evaluate((element) => ("inert" in element && typeof element.inert === "boolean" ? element.inert : true))
  ).toBe(false)
  await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked")
})

test("keeps sheet focus, isolation, and compact full-screen geometry deterministic", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 320 })
  await page.goto(story("primitives-sheet--interaction"))
  await expect(page.locator("[data-sheet-play-complete=\"true\"]")).toHaveCount(1)

  const sheet = page.getByRole("dialog", { name: "Release checks" })
  await expect(sheet).toBeVisible()
  await expect(page.getByRole("button", { name: "Review approval evidence" })).toBeFocused()
  expect(
    await page
      .locator("[data-sheet-background]")
      .evaluate((element) => ("inert" in element && typeof element.inert === "boolean" ? element.inert : false))
  ).toBe(true)
  await expect(page.locator("body")).toHaveAttribute("data-scroll-locked", "1")

  const box = await sheet.boundingBox()
  expect(box?.x).toBe(0)
  expect(box?.y).toBe(0)
  expect(Math.round(box?.width ?? 0)).toBe(320)
  expect(Math.round(box?.height ?? 0)).toBe(800)
  await expectNoHorizontalOverflow(page)

  await page.keyboard.press("Escape")
  await expect(sheet).toHaveCount(0)
  const trigger = page.getByRole("button", { name: "Inspect release checks" })
  await expect(trigger).toBeFocused()
  expect(
    await page
      .locator("[data-sheet-background]")
      .evaluate((element) => ("inert" in element && typeof element.inert === "boolean" ? element.inert : true))
  ).toBe(false)
  await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked")
})
