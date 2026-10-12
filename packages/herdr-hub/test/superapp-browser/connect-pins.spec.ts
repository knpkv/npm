import { expect, test } from "@playwright/test"
import {
  pinRegressionFleet,
  scrollPinDirectory,
  seedPins
} from "../../../herdr-connect/test/browser/connect-pin-fixture.js"

for (const theme of ["light", "dark"]) {
  test(`sticky pin stack in the real hub shell ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme === "dark" ? "dark" : "light", reducedMotion: "reduce" })
    await seedPins(page, pinRegressionFleet)
    await page.route("**/v1/connect/agents", (route) =>
      route.fulfill({
        json: {
          agents: pinRegressionFleet,
          failures: [],
          hosts: ["atlas", "birch"],
          nextCursor: null
        }
      }))
    await page.goto("/#fleet/connect")
    await page.locator("body").evaluate((body, theme) => body.setAttribute("data-rly-theme", theme), theme)
    await expect(page.locator(".superapp-shell")).toBeVisible()
    await expect(page.locator(".connect-agent")).toHaveCount(34)
    await page.evaluate(() => document.fonts.ready)
    const stack = page.locator(".connect-pins[data-placement='float']")
    await expect(stack.locator(".connect-pin")).toHaveCount(2)
    const read = () =>
      stack.evaluate((node) => {
        const box = node.getBoundingClientRect()
        const inset = Number.parseFloat(getComputedStyle(node).insetBlockEnd)
        return { y: box.y, bottom: box.bottom, inset }
      })
    const firstOwner = await scrollPinDirectory(page, 0.35)
    const first = await read()
    expect.soft(firstOwner.scrollTop).toBeGreaterThan(500)
    expect.soft(first.y, firstOwner.owner).toBeGreaterThanOrEqual(0)
    expect.soft(first.bottom + first.inset, firstOwner.owner).toBeCloseTo(firstOwner.bottom, 0)
    const mobileNavigation = await page.locator(".superapp-bottom").isVisible()
      ? await page.locator(".superapp-bottom").boundingBox()
      : null
    if (mobileNavigation !== null) expect.soft(first.bottom).toBeLessThanOrEqual(mobileNavigation.y)
    const secondOwner = await scrollPinDirectory(page, 0.65)
    const second = await read()
    expect.soft(secondOwner.scrollTop).toBeGreaterThan(firstOwner.scrollTop + 100)
    expect.soft(second.y).toBeCloseTo(first.y, 0)
    expect.soft(second.bottom + second.inset).toBeCloseTo(secondOwner.bottom, 0)
    await scrollPinDirectory(page, 1)
    const end = await read()
    const footer = await page.locator(".connect-directory-secondary").boundingBox()
    expect(footer).not.toBeNull()
    if (footer !== null) expect.soft(end.y).toBeGreaterThanOrEqual(footer.y)
    const link = page.locator(".connect-limits-link")
    await expect(link).toBeVisible()
    expect(
      await link.evaluate((node) => {
        const box = node.getBoundingClientRect()
        return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      })
    ).toBe(true)
  })
}
