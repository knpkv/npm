/** Page-14 Sandboxes states in the real hub stylesheet stack, at 1280 and 390, with captures for the design compare. */
import { expect, type Page, test } from "@playwright/test"
import { join } from "node:path"

test.use({ locale: "en-GB", timezoneId: "UTC" })

const now = new Date("2026-10-17T13:05:00.000Z")
const widths: ReadonlyArray<number> = [1280, 390]
const themes: ReadonlyArray<"light" | "dark"> = ["light", "dark"]
const shots = join(import.meta.dirname, "..", "..", "test-results", "sandboxes-shots")

type Screen = {
  readonly id: string
  readonly state: string
  readonly open?: { readonly button: string; readonly scope?: string }
  readonly after?: number
}

const screens: ReadonlyArray<Screen> = [
  { id: "1a", state: "1a" },
  { id: "2a", state: "1a", open: { button: "Lease an account" } },
  { id: "3a", state: "3a" },
  { id: "4a", state: "4a", open: { button: "Extend", scope: "ephemeral-01" } },
  { id: "4b", state: "4b" },
  { id: "5a", state: "4a", open: { button: "Release", scope: "ephemeral-01" } },
  { id: "5b", state: "5b" },
  { id: "7a", state: "7a" },
  { id: "7b", state: "7b" },
  { id: "8a", state: "8a" },
  { id: "8e", state: "8e" },
  { id: "8e-late", state: "8e-late" },
  { id: "8f", state: "8f" },
  { id: "8f-host", state: "8f-host" },
  { id: "8g", state: "8g", after: 120_000 }
]

const show = async (page: Page, screen: Screen, theme: string) => {
  await page.clock.install({ time: now })
  await page.goto(`/sandboxes/?state=${screen.state}&theme=${theme}`)
  await expect(page.getByRole("heading", { level: 1, name: "Sandboxes" })).toBeVisible()
  if (screen.after !== undefined) await page.clock.runFor(screen.after)
  if (screen.open !== undefined) {
    const scope = screen.open.scope === undefined ? page : page.locator(`[data-account="${screen.open.scope}"]`)
    await scope.getByRole("button", { name: screen.open.button, exact: true }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
  }
}

for (const width of widths) {
  for (const theme of themes) {
    for (const screen of screens) {
      test(`${screen.id} at ${String(width)} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: width < 600 ? 844 : 800 })
        await show(page, screen, theme)
        const overflow = await page.evaluate(() =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth
        )
        expect(overflow).toBe(0)
        await page.screenshot({ path: join(shots, `sandboxes--${screen.id}--${String(width)}-${theme}.png`) })
      })
    }
  }
}

test("phone keeps one card per row and a full-width Lease", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await show(page, { id: "1a", state: "1a" }, "light")
  const cards = page.locator("[data-account]")
  await expect(cards).toHaveCount(2)
  const [first, second] = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()])
  expect(first?.x).toBe(second?.x)
  const lease = await page.getByRole("button", { name: "Lease an account" }).boundingBox()
  const main = await page.locator(".sandboxes-page").boundingBox()
  expect(Math.round(lease?.width ?? 0)).toBe(Math.round((main?.width ?? 0) - 32))
})

test("desktop sets the two cards side by side", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await show(page, { id: "1a", state: "1a" }, "light")
  const cards = page.locator("[data-account]")
  const [first, second] = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()])
  expect(first?.y).toBe(second?.y)
})

test("a later failed read says stale and keeps the cards", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await show(page, { id: "8g", state: "8g", after: 120_000 }, "light")
  await expect(page.getByRole("status").filter({ hasText: "Stale, updated 2m ago" })).toBeVisible()
  await expect(page.locator("[data-account=\"ephemeral-01\"]")).toContainText("Last known at 13:05")
})

test("no pool on this hub is one panel without Lease", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await show(page, { id: "8f", state: "8f" }, "light")
  await expect(page.getByRole("heading", { name: "Sandboxes aren’t set up on this hub." })).toBeVisible()
  await expect(page.getByRole("button", { name: "Lease an account" })).toHaveCount(0)
  await expect(page.locator("[data-account]")).toHaveCount(0)
})
