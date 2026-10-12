/** The five directory acceptance flows run with touch and real Tab navigation at both widths. */
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Schema } from "effect"
import { ConnectAgent } from "../../src/model.js"
import { failureSentences } from "../../src/unavailable-detail.js"

const at = Date.UTC(2026, 9, 10, 14, 2)
const agent = (id: string, name: string, state: string, host: string) =>
  Schema.decodeUnknownSync(ConnectAgent)({
    id,
    name,
    state,
    host,
    kind: "codex",
    work: "Package work",
    lastActivityAt: at
  })
const agents = [
  agent("agent-worker", "Worker", "working", "alpha"),
  agent("agent-reviewer", "Reviewer", "blocked", "beta")
]

/** Advance through the actual tab order; do not focus a target programmatically. */
const tabTo = async (page: Page, control: Locator): Promise<void> => {
  await expect(control).toBeVisible()
  if (await control.evaluate((node) => node === document.activeElement)) return
  for (let step = 0; step < 30; step += 1) {
    await page.keyboard.press("Tab")
    if (await control.evaluate((node) => node === document.activeElement)) return
  }
  await expect(control).toBeFocused()
}

for (const width of [390, 1280]) {
  for (const input of ["touch", "keyboard"]) {
    test.describe(`directory usability ${String(width)} ${input}`, () => {
      test.use({ hasTouch: input === "touch", viewport: { width, height: 844 } })

      const activate = async (page: Page, control: Locator): Promise<void> => {
        if (input === "touch") await control.tap()
        else {
          await tabTo(page, control)
          await page.keyboard.press("Enter")
        }
      }

      const openReviewer = async (page: Page): Promise<void> => {
        const reviewer = page.getByRole("button", { name: "Blocked, Reviewer", exact: true })
        if (input === "touch") await reviewer.tap()
        else {
          // The cast is a roving tab stop; ArrowRight reaches the other agent.
          await tabTo(
            page,
            page.getByRole("navigation", { name: "Agents at a glance" }).locator("button[tabindex='0']")
          )
          if (!await reviewer.evaluate((node) => node === document.activeElement)) {
            await page.keyboard.press("ArrowRight")
          }
          await expect(reviewer).toBeFocused()
          await page.keyboard.press("Enter")
        }
      }

      const open = async (page: Page, failed = false): Promise<void> => {
        await page.clock.install({ time: at })
        await page.emulateMedia({ reducedMotion: "reduce" })
        await page.route("**/v1/connect/agents", (route) =>
          failed
            ? route.fulfill({ status: 503 })
            : route.fulfill({ json: { agents, failures: [], hosts: ["alpha", "beta"], nextCursor: null } }))
        await page.goto("/?embedded")
        if (failed) await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
        else await expect(page.locator(".connect-agent")).toHaveCount(2)
      }

      test("find who needs me", async ({ page }) => {
        await open(page)
        await expect(page.getByRole("heading", { name: /Connect/ })).toContainText("1 needs you")
        for (const row of await page.locator(".connect-agent").all()) {
          await expect(row).toHaveAccessibleName(/last active at \d{2}:\d{2}, open stage$/)
        }
        await openReviewer(page)
        await expect(page.getByRole("dialog", { name: "Reviewer", exact: true })).toBeVisible()
        await expect(page.locator(".connect-stage-speech")).toContainText("Blocked")
      })

      test("recover from a failed directory", async ({ page }) => {
        await open(page, true)
        await expect(page.locator(".connect-directory-error")).toContainText("Relay tries again every 5 seconds.")
        await page.unroute("**/v1/connect/agents")
        await page.route(
          "**/v1/connect/agents",
          (route) => route.fulfill({ json: { agents, failures: [], hosts: ["alpha", "beta"], nextCursor: null } })
        )
        await activate(page, page.getByRole("button", { name: "Retry", exact: true }))
        await expect(page.locator(".connect-directory-error")).toBeHidden()
        await expect(page.locator(".connect-agent")).toHaveCount(2)
      })

      test("filter to nothing and clear", async ({ page }) => {
        await open(page)
        await activate(page, page.getByRole("button", { name: "Filters", exact: true }))
        await activate(page, page.getByRole("button", { name: "beta", exact: true }))
        await activate(page, page.getByRole("button", { name: /^Filters/ }))
        const search = page.getByRole("searchbox")
        if (input === "touch") await search.tap()
        else await tabTo(page, search)
        await page.keyboard.type("zzz")
        await expect(page.locator(".connect-empty")).toContainText("No agents match “zzz” on beta, in all states.")
        await activate(page, page.getByRole("button", { name: "Clear filters", exact: true }))
        await expect(search).toHaveValue("")
        await expect(search).toBeFocused()
        await expect(page.locator(".connect-filter-summary")).toHaveText("All hosts,All states")
        await expect(page.locator(".connect-agent")).toHaveCount(2)
      })

      test("pin an agent and reopen it", async ({ page }) => {
        await open(page)
        await openReviewer(page)
        await activate(page, page.getByRole("button", { name: "Pin", exact: true }))
        if (input === "touch") await page.getByRole("button", { name: "Close", exact: true }).tap()
        else await page.keyboard.press("Escape")
        const pinned = page.getByRole("button", { name: "Pinned: Reviewer, Blocked", exact: true })
        await expect(pinned).toBeVisible()
        await expect(page.locator(".connect-pins[data-placement='float'] .connect-pin-name")).toHaveText("Reviewer")
        await activate(page, pinned)
        await expect(page.getByRole("dialog", { name: "Reviewer", exact: true })).toBeVisible()
      })

      test("read the limits failure", async ({ page }) => {
        await page.route("**/v1/connect/limits", (route) =>
          route.fulfill({
            json: {
              hosts: [{
                host: "alpha",
                readAt: at,
                reading: { _tag: "Unavailable", reason: "failed", detail: failureSentences.notRunning }
              }],
              failures: [],
              peersListed: true
            }
          }))
        await open(page)
        await expect(page.locator(".connect-limits-problem")).toHaveText(failureSentences.notRunning)
        const link = page.getByRole("link", { name: "Limits and usage", exact: true })
        await expect(link).toHaveAttribute("href", "/?tab=usage")
        await activate(page, link)
        await expect(page).toHaveURL(/\?tab=usage$/)
      })
    })
  }
}
