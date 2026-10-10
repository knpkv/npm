import { expect, type Page, test } from "@playwright/test"

const openStage = async (page: Page): Promise<void> => {
  await page.locator(".connect-agent", { hasText: "fixture-pane" }).click()
  await expect(page.getByRole("dialog", { name: "fixture-pane" })).toBeVisible()
}

test.describe("Connect pin", () => {
  // A pinned agent stays to hand on this device: over the directory, through a reload, and in the terminal.
  test("pins from the stage, survives a reload, and unpins", async ({ page }) => {
    await page.goto("/")
    await page.evaluate(() => window.localStorage.removeItem("fleet-connect-pinned"))
    await page.reload()
    await openStage(page)
    await page.getByRole("button", { name: "Pin" }).click()
    await page.keyboard.press("Escape")
    const pin = page.getByRole("button", { name: /^Pinned: fixture-pane/ })
    await expect(pin).toBeVisible()
    await page.reload()
    await expect(pin).toBeVisible()
    await pin.click()
    await expect(page.getByRole("dialog", { name: "fixture-pane" })).toBeVisible()
    await page.getByRole("button", { name: "Unpin" }).click()
    await page.keyboard.press("Escape")
    await expect(pin).toBeHidden()
  })

  // Over the terminal the floating pin never shows: it would cover the output or the key rail. The pinned
  // agent's own terminal doesn't repeat it in the bar either. (The fixture serves one agent, so a different
  // pinned agent in the bar is covered by the component test.)
  test("never floats over the terminal, and doesn't repeat the open agent in its bar", async ({ page }) => {
    await page.setViewportSize({ height: 700, width: 390 })
    await page.goto("/")
    await openStage(page)
    await page.getByRole("button", { name: "Pin" }).click()
    await page.getByRole("button", { name: "Open terminal" }).click()
    await expect(page.getByText("connected", { exact: true })).toBeVisible()
    await expect(page.locator(".terminal-bar .connect-pin")).toHaveCount(0)
    await expect(page.locator(".connect-pin[data-placement='float']")).toBeHidden()
  })

  // The floating pin must never sit over the last row once the list is scrolled to its end.
  test("leaves room so the last row scrolls clear of the floating pin", async ({ page }) => {
    for (const width of [320, 1280]) {
      await page.setViewportSize({ height: 640, width })
      await page.goto("/")
      await page.evaluate(() => window.localStorage.setItem("fleet-connect-pinned", "FIXTURE:agent-fixture"))
      await page.reload()
      const pin = page.locator(".connect-pin[data-placement='float']")
      await expect(pin).toBeVisible()
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      const row = await page.locator(".connect-agent").last().boundingBox()
      const chip = await pin.boundingBox()
      expect(row).not.toBeNull()
      expect(chip).not.toBeNull()
      if (row !== null && chip !== null) expect(row.y + row.height).toBeLessThanOrEqual(chip.y)
    }
  })

  // The pin hides while its own stage is open, so the control that opened it is gone when the stage closes;
  // focus must land on the agent's row, not the page.
  test("returns focus to the agent's row when the control that opened the stage is gone", async ({ page }) => {
    await page.goto("/")
    await page.evaluate(() => window.localStorage.setItem("fleet-connect-pinned", "FIXTURE:agent-fixture"))
    await page.reload()
    await page.getByRole("button", { name: /^Pinned: fixture-pane/ }).click()
    await expect(page.getByRole("dialog", { name: "fixture-pane" })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.locator(".connect-agent[data-agent-key=\"FIXTURE:agent-fixture\"]")).toBeFocused()
  })
})
