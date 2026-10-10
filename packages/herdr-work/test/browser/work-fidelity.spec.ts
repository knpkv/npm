import { expect, test } from "@playwright/test"
import { workFidelityStates } from "./work-fidelity-fixture.js"

test.use({ timezoneId: "UTC" })

for (const width of [390, 1280]) {
  for (const theme of ["light", "dark"]) {
    for (const state of workFidelityStates) {
      test(`Work ${state}, ${width}, ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ height: 844, width })
        await page.goto(`/test/browser/fixture.html?fidelity=${state}`)
        await page.evaluate(
          (selectedTheme) => document.documentElement.setAttribute("data-rly-theme", selectedTheme),
          theme
        )
        // The shell owns the single page gutter. This fixture renders only its Work content.
        await page.addStyleTag({ content: "body { margin: 0; } main { padding: 16px; }" })
        await page.evaluate(() => document.fonts.ready)
        await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        if (state === "detail") await expect(page.getByRole("region", { name: "Usage tab reviewer" })).toBeVisible()
        if (state === "owner-gone") await expect(page.getByText(/^Owner gone since/)).toBeVisible()
        if (state === "read-only") await expect(page.locator("button.work-board-row")).toHaveCount(0)
        const screenshot = await page.screenshot({
          fullPage: true,
          path: testInfo.outputPath(`work-${state}-${width}-${theme}.png`)
        })
        await testInfo.attach("Work screenshot", {
          body: screenshot,
          contentType: "image/png"
        })
      })
    }
  }
}

test("a selected goal keeps one focusable row and marks its card", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 })
  await page.goto("/test/browser/fixture.html?fidelity=detail")
  const card = page.locator(".work-goal-card[data-selected=\"true\"]")
  await expect(card.locator("button")).toHaveCount(1)
  await expect(card.locator("button")).toHaveAttribute("aria-pressed", "true")
  await expect(card.locator("a, input, [tabindex]")).toHaveCount(0)
  const button = card.locator("button")
  await button.focus()
  await expect(button).toBeFocused()
})
