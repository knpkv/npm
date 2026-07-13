import { expect, type Page, test } from "@playwright/test"

const storyUrl = (globals: string): string =>
  `/iframe.html?id=foundations-tokens--overview&viewMode=story&globals=${globals}`

const canvasColor = (page: Page): Promise<string> =>
  page.locator("[data-token=\"canvas\"] .tokenStory__sample")
    .evaluate((element) => getComputedStyle(element).backgroundColor)

test("resolves explicit and system light-dark themes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light", forcedColors: "none", reducedMotion: "no-preference" })
  await page.goto(storyUrl("theme:light;forcedColors:auto;reducedMotion:no-preference;locale:en;density:comfortable"))
  await expect(page.getByRole("heading", { name: "Meaning before color." })).toBeVisible()
  expect(await canvasColor(page)).toBe("rgb(246, 246, 248)")

  await page.goto(storyUrl("theme:dark;forcedColors:auto;reducedMotion:no-preference;locale:en;density:comfortable"))
  expect(await canvasColor(page)).toBe("rgb(16, 17, 20)")

  await page.goto(storyUrl("theme:system;forcedColors:auto;reducedMotion:no-preference;locale:en;density:comfortable"))
  expect(await canvasColor(page)).toBe("rgb(246, 246, 248)")
  await page.emulateMedia({ colorScheme: "dark" })
  expect(await canvasColor(page)).toBe("rgb(16, 17, 20)")
})

test("centralizes forced colors, reduced motion, and self-hosted fonts", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", forcedColors: "active", reducedMotion: "reduce" })
  await page.goto(storyUrl("theme:system;forcedColors:auto;reducedMotion:system;locale:en;density:comfortable"))
  const environment = page.locator("[data-rly-catalog]")
  await expect(environment).toBeVisible()

  const values = await environment.evaluate(async (element) => {
    await document.fonts.ready
    const styles = getComputedStyle(element)
    return {
      forcedText: styles.getPropertyValue("--rly-color-text-1").trim(),
      fontLoaded: document.fonts.check("16px \"Geist Variable\""),
      motion: styles.getPropertyValue("--rly-motion-standard-duration").trim()
    }
  })
  expect(values).toEqual({ forcedText: "CanvasText", fontLoaded: true, motion: "0s" })
  await expect(page.getByText("success", { exact: true })).toBeVisible()
  await expect(page.getByText("provenance", { exact: true })).toHaveCount(5)
})
