import { expect, test } from "@playwright/test"

test("Work navigation links use intentional hover and keyboard focus affordances", async ({ page }) => {
  await page.goto("/test/browser/fixture.html?navigation")

  const timeLink = page.locator(".work-time-link").first()
  const rowLink = page.locator(".work-board-row").first()

  await expect(timeLink).toHaveCSS("text-decoration-line", "none")
  await expect(rowLink).toHaveCSS("text-decoration-line", "none")

  await timeLink.hover()
  await expect(timeLink).toHaveCSS("text-decoration-line", "underline")

  const rowBackground = await rowLink.evaluate((element) => getComputedStyle(element).backgroundColor)
  await rowLink.hover()
  await expect
    .poll(() => rowLink.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe(rowBackground)

  await page.keyboard.press("Tab")
  await expect(timeLink).toBeFocused()
  await expect(timeLink).toHaveCSS("outline-style", "solid")

  await rowLink.focus()
  await expect(rowLink).toHaveCSS("outline-style", "solid")
  await expect(rowLink).toHaveAttribute("href", /goal=goal-1/)

  await page.getByRole("link", { name: "24 hours ago" }).click()
  await expect(page).toHaveURL(/[?&]window=day(?:&|$)/)
  await expect(page.getByRole("link", { name: "24 hours ago" })).toHaveAttribute("aria-current", "page")
})
