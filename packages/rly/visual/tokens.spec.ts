import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures.ts"

const storyUrl = (globals: string): string =>
  `/iframe.html?id=foundations-tokens--overview&viewMode=story&globals=${globals}`

// The sample's background as the sRGB it paints (read back from a 1×1 canvas), whatever colour space
// the token is written in.
const canvasColor = (page: Page): Promise<string> =>
  page.locator("[data-token=\"canvas\"] .tokenStory__sample")
    .evaluate((element) => {
      const context = document.createElement("canvas").getContext("2d")
      if (context === null) return ""
      context.fillStyle = getComputedStyle(element).backgroundColor
      context.fillRect(0, 0, 1, 1)
      const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
      return `rgb(${String(r)}, ${String(g)}, ${String(b)})`
    })

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

test("honors theme and preference attributes on the root element", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light", forcedColors: "none", reducedMotion: "no-preference" })
  await page.goto(storyUrl("theme:system;forcedColors:auto;reducedMotion:system;locale:en;density:comfortable"))
  await page.locator("[data-rly-catalog]").evaluate((element) => {
    for (
      const attribute of [
        "data-theme",
        "data-rly-theme",
        "data-forced-colors",
        "data-rly-forced-colors",
        "data-reduced-motion",
        "data-rly-reduced-motion"
      ]
    ) element.removeAttribute(attribute)
    document.documentElement.dataset.theme = "dark"
  })

  expect(await page.locator("html").evaluate((element) => getComputedStyle(element).colorScheme)).toBe("dark")
  expect(await canvasColor(page)).toBe("rgb(16, 17, 20)")

  const preferences = await page.locator("html").evaluate((element) => {
    element.dataset.forcedColors = "active"
    element.dataset.reducedMotion = "reduce"
    const styles = getComputedStyle(element)
    return {
      forcedText: styles.getPropertyValue("--rly-color-text-1").trim(),
      motion: styles.getPropertyValue("--rly-motion-standard-duration").trim()
    }
  })
  expect(preferences).toEqual({ forcedText: "CanvasText", motion: "0s" })

  const focusProbe = page.getByRole("button", { name: "Focus probe" })
  await page.locator("[data-rly-catalog]").evaluate((element) => {
    const button = document.createElement("button")
    button.textContent = "Focus probe"
    element.append(button)
  })
  await focusProbe.focus()
  expect(
    await focusProbe.evaluate((element) => {
      const styles = getComputedStyle(element)
      return { offset: styles.outlineOffset, width: styles.outlineWidth }
    })
  ).toEqual({ offset: "2px", width: "2px" })
})
