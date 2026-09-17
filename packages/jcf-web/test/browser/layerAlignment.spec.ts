import { expect, test } from "@playwright/test"
import { Schema } from "effect"

// Longer suggestion labels must not shift their button or caption relative to saved-provider controls.
test("layer controls align with wrapped labels and a single provider", async ({ page }) => {
  const response = await page.request.post("/__test/reset")
  const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json())
  await page.goto(setup.url)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  for (const scope of ["Both", "Jira only"]) {
    await page.getByRole("button", { name: scope, exact: true }).click()
    await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
    for (const width of [1100, 800, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      const groups = await page.locator(".jcf-layer-group").evaluateAll((elements) =>
        elements.map((group) => ({
          top: group.getBoundingClientRect().top,
          controls: [...group.querySelectorAll("button")].map((button) => ({
            top: button.getBoundingClientRect().top,
            height: button.getBoundingClientRect().height
          })),
          captions: [...group.querySelectorAll("small")].map((caption) => caption.getBoundingClientRect().top)
        }))
      )
      for (const group of groups) {
        expect(new Set(group.controls.map((control) => control.top)).size).toBe(1)
        expect(new Set(group.controls.map((control) => control.height)).size).toBe(1)
        expect(new Set(group.captions).size).toBe(1)
      }
      if (groups[0]?.top === groups[1]?.top) {
        expect(new Set(groups.flatMap((group) => group.controls.map((control) => control.top))).size).toBe(1)
        expect(new Set(groups.flatMap((group) => group.controls.map((control) => control.height))).size).toBe(1)
        expect(new Set(groups.flatMap((group) => group.captions)).size).toBe(1)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  }
  await page.setViewportSize({ width: 1100, height: 1000 })
  await page.locator(".jcf-calendar-tools").screenshot({ path: "test-results/layer-controls.png" })
})
