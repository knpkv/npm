/**
 * Page-14 and page-15 Sandboxes states in the real hub stylesheet stack, with captures for the design compare:
 * page 14 at 1280 and 390, page 15 at 1280 and 360, as the design draws them.
 */
import { expect, type Page, test } from "@playwright/test"
import { join } from "node:path"

test.use({ locale: "en-GB", timezoneId: "UTC" })

const now = new Date("2026-10-17T13:05:00.000Z")
const poolWidths: ReadonlyArray<number> = [1280, 390]
const attentionWidths: ReadonlyArray<number> = [1280, 360]
const themes: ReadonlyArray<"light" | "dark"> = ["light", "dark"]
const shots = join(import.meta.dirname, "..", "..", "test-results", "sandboxes-shots")

type Screen = {
  readonly id: string
  readonly state: string
  readonly open?: { readonly button: string; readonly scope?: string }
  readonly after?: number
  /** The page's level-one heading; the pool pages say Sandboxes, an account page names the account. */
  readonly heading?: string
  /** A button pressed before the capture, whose answer is part of the screen. */
  readonly press?: string
  /** The page opens on a sheet, which leaves the page behind it out of the accessibility tree. */
  readonly sheet?: true
  /** Capture name prefix, matching the design's frame names. */
  readonly prefix?: "sandboxes" | "sandboxes-attention"
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
  { id: "8g", state: "8g", after: 120_000 },
  { id: "8d", state: "8d", heading: "ephemeral-02" },
  { id: "2a-refused", state: "2a-refused", open: { button: "Lease an account" }, press: "Lease longest idle" },
  { id: "8c", state: "8c", sheet: true }
]

const attention: ReadonlyArray<Screen> = [
  { id: "1a", state: "attention-1a", prefix: "sandboxes-attention" },
  { id: "2a", state: "attention-2a", prefix: "sandboxes-attention", heading: "ephemeral-02" },
  { id: "3a", state: "attention-3a", prefix: "sandboxes-attention", heading: "ephemeral-02" },
  { id: "4a", state: "attention-4a", prefix: "sandboxes-attention", heading: "ephemeral-01" },
  { id: "4a-lift", state: "attention-4a-lift", prefix: "sandboxes-attention", heading: "ephemeral-01" },
  {
    id: "2a-refused",
    state: "attention-refused",
    prefix: "sandboxes-attention",
    heading: "ephemeral-02",
    press: "Retry reset"
  },
  { id: "3a-stale", state: "attention-stale", prefix: "sandboxes-attention", heading: "ephemeral-02", after: 30_000 }
]

const show = async (page: Page, screen: Screen, theme: string) => {
  await page.clock.install({ time: now })
  await page.goto(`/sandboxes/?state=${screen.state}&theme=${theme}`)
  await expect(
    screen.sheet === true
      ? page.getByRole("dialog")
      : page.getByRole("heading", { level: 1, name: screen.heading ?? "Sandboxes" })
  ).toBeVisible()
  if (screen.after !== undefined) await page.clock.runFor(screen.after)
  if (screen.open !== undefined) {
    const scope = screen.open.scope === undefined ? page : page.locator(`[data-account="${screen.open.scope}"]`)
    await scope.getByRole("button", { name: screen.open.button, exact: true }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
  }
  if (screen.press !== undefined) {
    await page.getByRole("button", { name: screen.press, exact: true }).click()
    await expect(page.getByRole("alert")).toBeVisible()
  }
}

const capture = (screen: Screen, width: number, theme: "light" | "dark") =>
  test(`${screen.prefix ?? "sandboxes"} ${screen.id} at ${String(width)} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 800 })
    await show(page, screen, theme)
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow).toBe(0)
    await page.screenshot({
      path: join(shots, `${screen.prefix ?? "sandboxes"}--${screen.id}--${String(width)}-${theme}.png`)
    })
  })

for (const theme of themes) {
  for (const width of poolWidths) for (const screen of screens) capture(screen, width, theme)
  for (const width of attentionWidths) for (const screen of attention) capture(screen, width, theme)
}

test("puts the quarantine first as the only red, and a pending lift is words, never a spinner", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await show(page, { id: "1a", state: "attention-1a" }, "light")
  await expect(page.locator("[data-account]").first()).toHaveAttribute("data-account", "ephemeral-02")
  await expect(page.locator("[data-account=\"ephemeral-01\"] [data-pool-state]")).toHaveText("Stopped by budget")
  await expect(page.locator("[data-account=\"ephemeral-01\"] [data-request-state]")).toHaveText("Approval requested")
  await expect(page.getByRole("progressbar")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Lease an account" })).toBeDisabled()
})

test("phone stretches the request link on the account page to a full-width 44px target", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 844 })
  await show(page, { id: "3a", state: "attention-3a", heading: "ephemeral-02" }, "light")
  const link = await page.getByRole("link", { name: /Retry one quarantined sandbox account/ }).boundingBox()
  const main = await page.locator(".sandboxes-page").boundingBox()
  expect(link?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(Math.round(link?.width ?? 0)).toBeGreaterThan(Math.round((main?.width ?? 0) - 32 - 40))
})

test("the owner can ask Fleet to retry a quarantine, with the note under a full-width 44px button on phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 844 })
  await show(page, { id: "2a", state: "attention-2a", heading: "ephemeral-02" }, "light")
  const retry = page.getByRole("button", { name: "Retry reset" })
  await expect(retry).toBeEnabled()
  await expect(page.getByText("Starts a fresh run. Goes to Fleet / Approvals first.")).toBeVisible()
  const box = await retry.boundingBox()
  const main = await page.locator(".sandboxes-page").boundingBox()
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(Math.round(box?.width ?? 0)).toBe(Math.round((main?.width ?? 0) - 32))
})

test("a run row opens that run's detail, with the failed step's words and no log", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await show(page, { id: "8c", state: "8c", sheet: true }, "light")
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("release-7f3a")
  await expect(dialog.locator("[data-step-blocker]")).toHaveText("3 resources still removable")
  await expect(dialog).not.toContainText("Log")
})

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
