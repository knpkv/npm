import { expect, test } from "@playwright/test"

test.describe("Connect stage", () => {
  // The row opens the agent's stage; Escape closes it and focus comes back to the row that opened it.
  test("opens from a row and returns focus to it", async ({ page }) => {
    await page.goto("/")
    const row = page.locator(".connect-agent", { hasText: "fixture-pane" })
    await row.click()
    const stage = page.getByRole("dialog", { name: "fixture-pane" })
    await expect(stage).toBeVisible()
    await expect(stage.getByText("Working on")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(stage).toBeHidden()
    await expect(row).toBeFocused()
  })

  test("opens from the cast too", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("navigation", { name: "Agents at a glance" }).getByRole("button", { name: /fixture-pane/ })
      .click()
    await expect(page.getByRole("dialog", { name: "fixture-pane" })).toBeVisible()
  })

  test("hands off to the terminal", async ({ page }) => {
    await page.goto("/")
    await page.locator(".connect-agent", { hasText: "fixture-pane" }).click()
    await page.getByRole("button", { name: "Open terminal" }).click()
    await expect(page.getByRole("dialog", { name: "fixture-pane" })).toBeHidden()
    await expect(page.getByText("connected", { exact: true })).toBeVisible()
  })

  test("fits a 320px phone without sideways scroll, stage open or closed", async ({ page }) => {
    await page.setViewportSize({ height: 700, width: 320 })
    await page.goto("/")
    await expect(page.locator(".connect-cast-member")).toHaveCount(1)
    const width = () => page.evaluate(() => document.documentElement.scrollWidth)
    expect(await width()).toBeLessThanOrEqual(320)
    await page.locator(".connect-agent", { hasText: "fixture-pane" }).click()
    await expect(page.getByRole("dialog", { name: "fixture-pane" })).toBeVisible()
    expect(await width()).toBeLessThanOrEqual(320)
  })

  // The field's light drifts only when the reader allows motion.
  test("drifts its field only when motion is allowed", async ({ page }) => {
    const motes = () =>
      page
        .locator(".connect-stage-mote")
        .evaluateAll(
          (nodes) =>
            nodes.flatMap((node) => node.getAnimations()).filter((animation) => animation.playState === "running")
              .length
        )
    for (
      const [motion, expected] of [
        ["no-preference", 5],
        ["reduce", 0]
      ] satisfies ReadonlyArray<readonly ["no-preference" | "reduce", number]>
    ) {
      await page.emulateMedia({ reducedMotion: motion })
      await page.goto("/")
      await page.locator(".connect-agent", { hasText: "fixture-pane" }).click()
      await expect(page.getByRole("dialog", { name: "fixture-pane" })).toBeVisible()
      expect(await motes()).toBe(expected)
    }
  })

  // Work links to an agent with `open=stage`: the stage opens, its terminal one tap away. A plain deep link
  // still opens the terminal, as approval links expect.
  test("opens the stage from a Work link, and the terminal from a plain one", async ({ page }) => {
    await page.goto("/?host=FIXTURE&agent=agent-fixture&open=stage")
    const stage = page.getByRole("dialog", { name: "fixture-pane" })
    await expect(stage).toBeVisible()
    await expect(stage.getByRole("button", { name: "Open terminal" })).toBeVisible()
    await expect(page.getByText("connected", { exact: true })).toBeHidden()
    await page.goto("/?host=FIXTURE&agent=agent-fixture")
    await expect(page.getByText("connected", { exact: true })).toBeVisible()
    await expect(page.getByRole("dialog", { name: "fixture-pane" })).toBeHidden()
  })
})
