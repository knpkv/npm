import { expect, test } from "@playwright/test"
import { Schema } from "effect"

// Layer toggles are one row of one-line controls per kind; a count never wraps away from its label.
test("layer controls keep one line each with both scopes and every width", async ({ page }, testInfo) => {
  const response = await page.request.post("/__test/reset")
  const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json())
  await page.goto(setup.url)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  for (const scope of ["Both", "Jira only"]) {
    await page.getByRole("button", { name: scope, exact: true }).click()
    await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
    for (const width of [1280, 1024, 800, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      const groups = await page.locator(".jcf-layer-group").evaluateAll((elements) =>
        elements.map((group) =>
          [...group.querySelectorAll("button")].map((button) => {
            const label = button.querySelector("span span") ?? button
            const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight)
            return {
              height: button.getBoundingClientRect().height,
              lines: Math.round(label.getBoundingClientRect().height / lineHeight)
            }
          })
        )
      )
      expect(groups).toHaveLength(2)
      for (const controls of groups) {
        expect(controls.length).toBeGreaterThan(0)
        expect(new Set(controls.map((control) => control.height)).size).toBe(1)
        for (const control of controls) expect(control.lines).toBe(1)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  }
  await page.setViewportSize({ width: 1100, height: 1000 })
  await page.locator(".jcf-calendar-tools").screenshot({ path: testInfo.outputPath("layer-controls.png") })
})
