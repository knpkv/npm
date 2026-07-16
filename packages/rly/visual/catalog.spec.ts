import { expect, test } from "@playwright/test"

test("renders the bounded catalog environment and captures one local frame", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", forcedColors: "active", reducedMotion: "reduce" })
  await page.goto(
    "/iframe.html?id=catalog-overview--default&viewMode=story&globals=theme:dark;forcedColors:active;reducedMotion:reduce;locale:nl;density:compact"
  )

  await expect(page.getByRole("heading", { name: "Component catalog" })).toBeVisible()
  const environment = page.locator("[data-rly-catalog]")
  await expect(environment).toHaveAttribute("data-theme", "dark")
  await expect(environment).toHaveAttribute("data-forced-colors", "active")
  await expect(environment).toHaveAttribute("data-reduced-motion", "reduce")
  await expect(environment).toHaveAttribute("data-rly-theme", "dark")
  await expect(environment).toHaveAttribute("data-rly-forced-colors", "active")
  await expect(environment).toHaveAttribute("data-rly-reduced-motion", "reduce")
  await expect(environment).toHaveAttribute("data-rly-density", "compact")
  await expect(environment).toHaveAttribute("lang", "nl")

  const screenshot = await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("catalog-overview.png")
  })
  expect(screenshot.byteLength).toBeGreaterThan(1_000)
})
