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
  /** A disclosure button pressed in one card before the capture; it opens in place, not as a sheet. */
  readonly expand?: { readonly button: string; readonly scope: string }
  /** Capture at the design frame's own height, so a long sheet shows whole: 1743 at 1280, 1903 at 390. */
  readonly tall?: true
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
  { id: "6a", state: "1a", expand: { button: "Copy CLI profile", scope: "ephemeral-02" } },
  { id: "8c", state: "8c", sheet: true, tall: true },
  { id: "8c-viewer", state: "8c-viewer", sheet: true, tall: true }
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
  if (screen.expand !== undefined) {
    const toggle = page
      .locator(`[data-account="${screen.expand.scope}"]`)
      .getByRole("button", { name: screen.expand.button, exact: true })
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
  }
  if (screen.press !== undefined) {
    await page.getByRole("button", { name: screen.press, exact: true }).click()
    await expect(page.getByRole("alert")).toBeVisible()
  }
}

const capture = (screen: Screen, width: number, theme: "light" | "dark") =>
  test(`${screen.prefix ?? "sandboxes"} ${screen.id} at ${String(width)} ${theme}`, async ({ page }) => {
    const height = screen.tall === true ? (width < 600 ? 1903 : 1743) : width < 600 ? 844 : 800
    await page.setViewportSize({ width, height })
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

test("a run row opens that run's detail; the owner sees the stored line and the last 30 log lines", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await show(page, { id: "8c", state: "8c", sheet: true }, "light")
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("release-7f3a")
  await expect(dialog.locator("[data-step-blocker]")).toHaveText("3 resources still removable")
  await expect(dialog.locator("[data-step-raw]")).toContainText("verify: 3 resources still removable.")
  await expect(dialog.locator("details[data-run-log] summary")).toHaveText("▼LogLast 30 lines")
  await expect(dialog.locator("details[data-run-log] pre")).toContainText("11:07:00 run release-7f3a ended")
})

test("a viewer's run detail has the failed step's words, no stored line and no log", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await show(page, { id: "8c-viewer", state: "8c-viewer", sheet: true }, "light")
  const dialog = page.getByRole("dialog")
  await expect(dialog.locator("[data-step-blocker]")).toHaveText("3 resources still removable")
  await expect(dialog.locator("[data-step-raw]")).toHaveCount(0)
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

test("the owner signs in where they may, and copies a CLI profile; an agent's lease says why not", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await show(page, { id: "6a", state: "1a" }, "light")
  const free = page.locator("[data-account=\"ephemeral-02\"]")
  const held = page.locator("[data-account=\"ephemeral-01\"]")
  await expect(free.getByRole("button", { name: /^Open console for ephemeral-02/ })).toBeEnabled()
  await expect(held.getByRole("button", { name: /^Open console for ephemeral-01/ })).toBeDisabled()
  await expect(held.locator("[data-console-reason]")).toHaveText(
    "Open console: only the lease holder can sign in. review-runner-02 holds this lease."
  )
  await free.getByRole("button", { name: "Copy CLI profile", exact: true }).click()
  await expect(free.locator("[data-cli-profile] pre")).toContainText("[profile ephemeral-02]")
  await expect(free.locator("[data-cli-note]")).toHaveText("Nix already writes these profiles on managed machines.")
})

test("a viewer has no console and no CLI profile", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await show(page, { id: "8a", state: "8a" }, "light")
  await expect(page.getByRole("button", { name: /Open console/ })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Copy CLI profile" })).toHaveCount(0)
})

test("cards show this month's spend against the alarm and the hard stop; a budget stop is past it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await show(page, { id: "1a", state: "1a" }, "light")
  const free = page.locator("[data-account=\"ephemeral-02\"]")
  await expect(free.getByRole("meter")).toHaveAccessibleName(
    "Spend this month $3.10. Alarm at $20, hard stop at $50."
  )
  await show(page, { id: "4a", state: "attention-4a", heading: "ephemeral-01" }, "light")
  await expect(page.locator("[data-spend-over]")).toHaveText("$50.20 is past the $50 hard stop.")
})
