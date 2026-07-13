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

test("keeps controlled tabs keyboard-navigable through narrow reflow", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 320 })
  await page.goto(story("primitives-tabs--interaction"))
  await expect(page.locator("[data-tabs-play-complete=\"true\"]")).toHaveCount(1)

  const list = page.getByRole("tablist", { exact: true, name: "Release sections" })
  const summary = list.getByRole("tab", { name: "Summary" })
  const evidence = list.getByRole("tab", { name: "Evidence" })
  await summary.focus()
  await expect(summary).toBeFocused()
  await summary.press("ArrowRight")
  await expect(evidence).toBeFocused()
  await expect(evidence).toHaveAttribute("aria-selected", "true")
  await expect(list.getByRole("tab", { name: "Decision history and governed actions" })).toBeDisabled()
  await expectNoHorizontalOverflow(page)
})

test("preserves field semantics and deliberate form-control geometry", async ({ page }) => {
  await page.setViewportSize({ height: 1_000, width: 320 })
  await page.goto(story("primitives-field--states"))

  const input = page.getByRole("textbox", { name: /Release name/ })
  const notes = page.getByRole("textbox", { name: "Release notes" })
  const environment = page.getByRole("combobox", { name: "Environment" })
  expect(Math.round((await input.boundingBox())?.height ?? 0)).toBe(48)
  expect(Math.round((await environment.boundingBox())?.height ?? 0)).toBe(40)
  await expect(notes).toHaveAttribute("aria-invalid", "true")
  await expect(notes).toHaveAttribute("aria-errormessage", "release-notes-error")
  await expect(page.getByRole("alert")).toHaveText("Add a concise summary before continuing.")
  await expectNoHorizontalOverflow(page)
})

test("contains the select popup and restores trigger focus", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 320 })
  await page.goto(story("primitives-select--states"))

  const trigger = page.getByRole("combobox", { exact: true, name: "Environment" })
  await trigger.click()
  const listbox = page.getByRole("listbox")
  await expect(listbox).toBeVisible()
  const box = await listbox.boundingBox()
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
  expect((box?.x ?? 321) + (box?.width ?? 321)).toBeLessThanOrEqual(320)
  await page.keyboard.press("Escape")
  await expect(trigger).toBeFocused()
  await expectNoHorizontalOverflow(page)
})
