import { expect, type Page, test } from "@playwright/test"

const openStage = async (page: Page): Promise<void> => {
  await page.locator(".connect-agent", { hasText: "fixture-pane" }).click()
  await expect(page.getByRole("dialog", { name: "fixture-pane" })).toBeVisible()
}

test.describe("Connect pin", () => {
  // A pinned agent stays to hand on this device: over the directory, through a reload, and in the terminal.
  test("pins from the stage, survives a reload, and unpins", async ({ page }) => {
    await page.goto("/")
    await page.evaluate(() => {
      window.localStorage.removeItem("fleet-connect-pinned")
      window.localStorage.removeItem("fleet-connect-pins")
    })
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
    await expect(page.locator(".connect-pins[data-placement='float']")).toBeHidden()
  })

  // The floating pin must never sit over the last row once the list is scrolled to its end.
  test("leaves room so the last row scrolls clear of the floating pin", async ({ page }) => {
    for (const width of [320, 1280]) {
      await page.setViewportSize({ height: 640, width })
      await page.goto("/")
      await page.evaluate(() => window.localStorage.setItem("fleet-connect-pinned", "FIXTURE:agent-fixture"))
      await page.reload()
      const pin = page.locator(".connect-pins[data-placement='float']")
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

  // Pins are a set: one stored by the single-pin version carries over, and pins whose agents this poll didn't
  // list wait behind "+N", dimmed, with when they were last seen. Delete on a chip unpins it.
  test("carries over the old pin, keeps away pins behind +N, and unpins with Delete", async ({ page }) => {
    await page.goto("/")
    await page.evaluate(() => {
      window.localStorage.removeItem("fleet-connect-pins")
      window.localStorage.setItem("fleet-connect-pinned", "FIXTURE:agent-fixture")
    })
    await page.reload()
    const chip = page.getByRole("button", { name: /^Pinned: fixture-pane/ })
    await expect(chip).toBeVisible()
    const stored = () => page.evaluate(() => window.localStorage.getItem("fleet-connect-pins"))
    await expect.poll(stored).toContain("FIXTURE:agent-fixture")
    expect(await page.evaluate(() => window.localStorage.getItem("fleet-connect-pinned"))).toBeNull()

    // Two agents that have left, pinned before the one that is here.
    await page.evaluate(() => {
      const pin = (host: string, id: string, name: string) => ({ host, id, key: `${host}:${id}`, name, seenAt: 0 })
      window.localStorage.setItem(
        "fleet-connect-pins",
        JSON.stringify({
          pins: [
            pin("gone", "agent-one", "away-agent-one"),
            pin("gone", "agent-two", "away-agent-two"),
            pin("FIXTURE", "agent-fixture", "fixture-pane")
          ],
          v: 1
        })
      )
    })
    await page.reload()
    await expect(chip).toBeVisible()
    const more = page.getByRole("button", { name: "2 more pinned" })
    await more.click()
    await expect(more).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByText("away-agent-one")).toBeVisible()
    await expect(page.getByText(/not seen since/).first()).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(more).toHaveAttribute("aria-expanded", "false")
    await expect(more).toBeFocused()

    await chip.focus()
    await page.keyboard.press("Delete")
    await expect(chip).toBeHidden()
    await expect.poll(stored).not.toContain("FIXTURE:agent-fixture")
  })

  // The list behind "+N" opens clear of the chips, and in a phone's terminal bar the pins keep to one line.
  test("opens the +N list clear of the chips, and keeps the bar's pins on one line on a phone", async ({ page }) => {
    await page.setViewportSize({ height: 700, width: 320 })
    await page.goto("/")
    await page.evaluate(() => {
      const pin = (host: string, id: string, name: string) => ({ host, id, key: `${host}:${id}`, name, seenAt: 0 })
      window.localStorage.setItem(
        "fleet-connect-pins",
        JSON.stringify({
          pins: [
            pin("FIXTURE", "agent-fixture", "fixture-pane"),
            pin("gone", "agent-one", "away-agent-one"),
            pin("gone", "agent-two", "away-agent-two")
          ],
          v: 1
        })
      )
    })
    await page.reload()
    const float = page.locator(".connect-pins[data-placement='float']")
    await float.getByRole("button", { name: "2 more pinned" }).click()
    const list = await float.locator(".connect-pins-overflow").boundingBox()
    const chip = await float.locator(".connect-pin").first().boundingBox()
    expect(list).not.toBeNull()
    expect(chip).not.toBeNull()
    if (list !== null && chip !== null) expect(list.y + list.height).toBeLessThanOrEqual(chip.y)
    // A long "not seen since" wraps inside the list instead of scrolling it sideways.
    expect(await float.locator(".connect-pins-overflow").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
      true
    )

    await page.keyboard.press("Escape")
    await page.locator(".connect-agent", { hasText: "fixture-pane" }).click()
    await page.getByRole("button", { name: "Open terminal" }).click()
    await expect(page.getByText("connected", { exact: true })).toBeVisible()
    const bar = page.locator(".terminal-bar .connect-pins")
    await expect(bar.getByRole("button", { name: "2 more pinned" })).toBeVisible()
    const rows = await bar.locator("button").evaluateAll((buttons) =>
      new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size
    )
    expect(rows).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  })
})
