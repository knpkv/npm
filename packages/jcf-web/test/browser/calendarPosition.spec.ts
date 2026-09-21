import { expect, type Page, test } from "@playwright/test"
import { Schema } from "effect"

const hold = () => {
  let release: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, resolve: () => release?.() }
}

const position = (page: Page) =>
  page.locator(".jcf-calendar").evaluate((calendar) => ({
    scrollTop: calendar.scrollTop,
    top: calendar.getBoundingClientRect().top,
    hourTop: [...calendar.querySelectorAll(".jcf-hour-label")]
      .find((label) => label.textContent === "12:00")?.getBoundingClientRect().top,
    pageTop: window.scrollY
  }))

// Hold both network phases: a final-state assertion alone misses the jump during totals refresh.
for (const viewport of [{ width: 1440, height: 1000 }, { width: 1440, height: 1600 }, { width: 800, height: 1000 }]) {
  // The tall viewport keeps the page at zero, where browser scroll anchoring cannot hide inserted status height.
  test(`Log selected time preserves the visible hour at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const response = await page.request.post("/__test/reset")
    const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json())
    await page.goto(setup.url)
    await expect(page.getByRole("heading", { name: "7–13 September 2026" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
    const confirmation = hold()
    const refresh = hold()
    const refreshing = hold()
    await page.route("**/api/rows/confirm", async (route) => {
      await confirmation.promise
      await route.continue()
    })
    await page.route("**/api/week/recorded?*", async (route) => {
      refreshing.resolve()
      await refresh.promise
      await route.continue()
    })
    await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
    await expect(page.getByRole("textbox", { name: "What was done (optional)", exact: true })).toHaveValue(
      "Improved weekly time review and tested approval behavior"
    )
    const submit = page.getByRole("button", { name: "Log selected time" })
    await submit.scrollIntoViewIfNeeded()
    await page.locator(".jcf-calendar").evaluate((calendar) => {
      calendar.scrollTop = 180
    })
    const before = await position(page)
    expect(before.hourTop).toEqual(expect.any(Number))
    expect(before.scrollTop).toBeGreaterThan(0)
    await submit.click()
    await expect(page.locator(".jcf-block[data-pending=\"true\"]")).toHaveCount(2)
    const pending = await position(page)
    confirmation.resolve()
    await refreshing.promise
    await expect(page.getByRole("complementary", { name: "Time entry editor" })).toHaveCount(0)
    const reading = await position(page)
    refresh.resolve()
    await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
    const complete = await position(page)
    await expect(page.getByRole("region", { name: "Week calendar", exact: true })).toBeFocused()
    for (const actual of [pending, reading, complete]) {
      expect(actual.scrollTop).toBe(before.scrollTop)
      expect(actual.hourTop).toBe(before.hourTop)
      expect(actual.pageTop).toBe(before.pageTop)
      expect(actual.top).toBe(before.top)
    }
  })
}

// The small-screen editor scrolls internally and restores the original agenda button on either dismissal path.
test("narrow editor preserves the viewport and restores focus on Escape and Cancel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const response = await page.request.post("/__test/reset")
  const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json())
  await page.goto(setup.url)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  const suggestion = page.locator(".jcf-agenda-entry[data-kind=\"proposable\"]").first()
  await suggestion.scrollIntoViewIfNeeded()
  await suggestion.focus()
  const before = await page.evaluate(() => window.scrollY)
  for (const close of ["Escape", "Cancel"]) {
    await suggestion.press("Enter")
    const editor = page.getByRole("complementary", { name: "Time entry editor" })
    await expect(editor).toBeFocused()
    await expect(editor.getByRole("textbox", { name: "What was done (optional)", exact: true })).toHaveValue(
      "Improved weekly time review and tested approval behavior"
    )
    expect(await page.evaluate(() => window.scrollY)).toBe(before)
    const bounds = await editor.boundingBox()
    expect(bounds?.height).toBeLessThanOrEqual(844 * 0.75)
    if (close === "Escape") await page.keyboard.press("Escape")
    else await editor.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(editor).toHaveCount(0)
    await expect(suggestion).toBeFocused()
    expect(await page.evaluate(() => window.scrollY)).toBe(before)
  }
})

// Failed confirmation retains the editor. Its feedback must leave the retry/cancel controls reachable.
for (const width of [1440, 390]) {
  test(`failed confirmation keeps the editor usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    const response = await page.request.post("/__test/reset")
    const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json())
    await page.goto(setup.url)
    await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
    await page.route(
      "**/api/rows/confirm",
      (route) => route.fulfill({ status: 503, json: { message: "Creation failed" } })
    )
    const suggestion = width < 640
      ? page.locator(".jcf-agenda-entry[data-kind=\"proposable\"]").first()
      : page.getByRole("button", { name: /PROJ-123, 11:00/ })
    await suggestion.click()
    const editor = page.getByRole("complementary", { name: "Time entry editor" })
    const note = editor.getByRole("textbox", { name: "What was done (optional)", exact: true })
    await expect(note).toHaveValue("Improved weekly time review and tested approval behavior")
    await editor.getByRole("button", { name: "Log selected time" }).click()
    const failure = page.getByRole("alert")
    await expect(failure).toContainText("Creation failed")
    await expect(failure).toBeVisible()
    await expect(failure.getByText("Creation failed", { exact: true })).toBeInViewport()
    await expect(editor).toBeVisible()
    await expect(page.locator("[data-pending=\"true\"]")).toHaveCount(0)
    await note.fill("Retry with this description")
    await expect(note).toHaveValue("Retry with this description")
    await expect(editor.getByRole("button", { name: "Log selected time" })).toBeEnabled()
    const retry = editor.getByRole("button", { name: "Log selected time" })
    await retry.scrollIntoViewIfNeeded()
    expect(
      await retry.evaluate((button) => {
        const bounds = button.getBoundingClientRect()
        const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
        return hit !== null && button.contains(hit)
      })
    ).toBe(true)
    await editor.getByRole("button", { name: "Cancel", exact: true }).click({ timeout: 1500 })
    await expect(editor).toHaveCount(0)
    await expect(suggestion).toBeFocused()
  })
}
