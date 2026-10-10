/** Live Connect fixtures and reference captures. Run through the shared browser gate. */
import { expect, type Page, test } from "@playwright/test"
import { Schema } from "effect"
import { ConnectAgent } from "../../src/model.js"

const agent = (id: string, name: string, state: string, parent?: string, relation = "delegated", host = "alpha") => {
  const fields = {
    host,
    id,
    name,
    state,
    kind: "codex",
    work: "Package work",
    lastActivityAt: 1_786_355_000_000
  }
  return Schema.decodeUnknownSync(ConnectAgent)(
    parent === undefined ? fields : { ...fields, relationship: { parentAgentId: parent, relation } }
  )
}

export const hierarchyFixture = [
  agent("agent-primary", "Primary", "working"),
  agent("agent-partner", "Pair partner", "waiting", "agent-primary", "pair"),
  agent("agent-coordinator", "Coordinator", "working"),
  ...Array.from(
    { length: 5 },
    (_, index) =>
      agent(
        `agent-worker-${String(index)}`,
        `Worker ${String(index + 1)}`,
        index === 4 ? "blocked" : "working",
        "agent-coordinator",
        index === 4 ? "review" : "delegated"
      )
  ),
  agent("agent-orphan", "Unlisted primary", "ready", "agent-absent"),
  agent("agent-peer", "Peer worker", "working", undefined, "delegated", "beta")
]

const fixture = async (page: Page, agents: ReadonlyArray<ConnectAgent> = hierarchyFixture): Promise<void> => {
  await page.route(
    "**/v1/connect/agents",
    (route) => route.fulfill({ json: { agents, failures: [], nextCursor: null } })
  )
  await page.goto("/?embedded")
  // Match the hub's real main-column gutter, without modifying its stylesheet.
  await page.locator("#fleet-connect-root").evaluate((root) => root.classList.add("fleet-shell-main"))
  await expect(page.locator(".connect-family")).toHaveCount(4)
}

for (const width of [390, 1280]) {
  for (const theme of ["light", "dark"]) {
    test(`hierarchy ${String(width)} ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.clock.install({ time: Date.UTC(2026, 9, 10, 14, 2, 31) })
      await fixture(page)
      await page.locator("body").evaluate((body, theme) => body.setAttribute("data-rly-theme", theme), theme)
      const prefix = `connect-${String(width)}-${theme}`
      await expect(page.locator(".connect-agent-state")).toHaveCount(0)
      const partner = page.locator(".connect-agent[data-agent-key=\"alpha:agent-partner\"]")
      await expect(partner).toHaveAccessibleName(/Waiting.*Pair partner/)
      await expect(partner.locator(".connect-creature-state")).toBeHidden()
      await expect(page.locator(".connect-family").nth(1)).toContainText("Pair partner")
      await expect(page.locator(".connect-family-more")).toHaveText("Show 1 more")
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await page.screenshot({ path: testInfo.outputPath(`fidelity/${prefix}-closed.png`), fullPage: true })
      await page.getByRole("button", { name: "Filters", exact: true }).click()
      for (const selector of [".connect-group-filter button", ".connect-status-filter button"]) {
        const rows = await page.locator(selector).evaluateAll((buttons) =>
          new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size
        )
        expect(rows).toBe(1)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await page.screenshot({ path: testInfo.outputPath(`fidelity/${prefix}-filters.png`), fullPage: true })
      await page.getByRole("searchbox").fill("Pair partner")
      await expect(page.locator(".connect-agent")).toHaveCount(2)
      await expect(page.locator(".connect-agent[data-context='true']")).toHaveCount(1)
      await page.screenshot({ path: testInfo.outputPath(`fidelity/${prefix}-filtered.png`), fullPage: true })
      await partner.click()
      const stage = page.getByRole("dialog", { name: "Pair partner" })
      await expect(stage.getByRole("heading", { name: "Paired with" })).toBeVisible()
      await expect(stage.getByText("Waiting", { exact: true })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`fidelity/${prefix}-stage.png`), fullPage: true })
      await stage.locator(".connect-stage-lineage button", { hasText: "Primary" }).click()
      await expect(page.getByRole("dialog", { name: "Primary" })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`fidelity/${prefix}-primary-stage.png`), fullPage: true })
      await page.keyboard.press("Escape")
      await expect(page.getByRole("dialog")).toBeHidden()
    })
  }
}

test(
  "forced colours keep the shared static glyph and halo, with state in the accessible name",
  async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" })
    await fixture(page)
    const partner = page.locator(".connect-agent[data-agent-key=\"alpha:agent-partner\"]")
    await expect(partner.locator(".connect-creature-state")).toBeVisible()
    await expect(partner.locator(".connect-creature-state svg")).toHaveClass(/lucide-clock/)
    const halo = await partner.locator(".connect-creature-halo").evaluate((halo) => getComputedStyle(halo).stroke)
    expect(halo).not.toBe("none")
    await expect(partner).toHaveAccessibleName(/Waiting/)
    await page.screenshot({ path: testInfo.outputPath("fidelity/connect-390-forced-colours.png"), fullPage: true })
  }
)

for (const width of [390, 1280]) {
  for (const theme of ["light", "dark"]) {
    for (const state of ["empty", "unavailable", "loading", "stale", "unknown"]) {
      test(`directory ${state} ${String(width)} ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 844 })
        await page.emulateMedia({ reducedMotion: "reduce" })
        await page.clock.install({ time: Date.UTC(2026, 9, 10, 14, 2, 31) })
        let hostSilent = false
        await page.route("**/v1/connect/agents", async (route) => {
          if (state === "loading") return
          if (state === "unavailable") return route.fulfill({ status: 503, body: "Directory unavailable" })
          const agents = state === "empty"
            ? []
            : state === "unknown"
            ? [agent("agent-unknown", "Unknown state", "new_phase")]
            : hierarchyFixture
          const stale = state === "stale" && hostSilent
          return route.fulfill({
            json: {
              agents: stale ? agents.filter((agent) => agent.host !== "beta") : agents,
              failures: stale ? [{ host: "beta", reason: "timeout" }] : [],
              nextCursor: null
            }
          })
        })
        await page.goto("/?embedded")
        await page.locator("#fleet-connect-root").evaluate((root) => root.classList.add("fleet-shell-main"))
        await page.locator("body").evaluate((body, theme) => body.setAttribute("data-rly-theme", theme), theme)
        if (state === "stale") {
          await expect(page.locator(".connect-family")).toHaveCount(4)
          hostSilent = true
          await page.clock.fastForward(5_100)
          await expect(page.locator(".connect-agent[data-agent-key=\"beta:agent-peer\"]")).toContainText("Old reading")
          await expect(page.locator(".connect-failures")).toContainText("its readings are old")
        } else if (state === "empty") {
          await expect(page.getByText("No agents running on any host.")).toBeVisible()
        } else if (state === "unavailable") {
          await expect(page.getByRole("button", { name: "Retry directory" })).toBeVisible()
        } else if (state === "loading") {
          await expect(page.getByText("Loading fleet agents…")).toBeVisible()
        } else {
          await expect(page.locator(".connect-agent")).toHaveAccessibleName(/New_phase.*Unknown state/)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        await page.screenshot({
          path: testInfo.outputPath(`fidelity/connect-${String(width)}-${theme}-${state}.png`),
          fullPage: true
        })
      })
    }
  }
}

// A pin may open a stage whose row is hidden by a filter or family expansion. Closing still needs a live target.
test("returns to search when a pinned stage's row is outside the current scope", async ({ page }) => {
  await fixture(page)
  await page.locator(".connect-agent[data-agent-key=\"alpha:agent-partner\"]").click()
  await page.getByRole("button", { name: "Pin", exact: true }).click()
  await page.keyboard.press("Escape")
  await page.getByRole("searchbox").fill("no matching agent")
  await expect(page.locator(".connect-agent")).toHaveCount(0)
  await page.getByRole("button", { name: /^Pinned: Pair partner/ }).click()
  await expect(page.getByRole("dialog", { name: "Pair partner" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("searchbox")).toBeFocused()
})
