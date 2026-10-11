import { expect, test } from "@playwright/test"

const states = [
  "populated",
  "urgent-5m",
  "urgent-60s",
  "decision-bar",
  "remote-selected",
  "empty",
  "fresh-install",
  "host-unchecked",
  "paged",
  "paged-first-empty",
  "approvals-off",
  "notifications-strip",
  "refresh-failure",
  "long-text",
  "shortcuts-dialog",
  "full-request-open",
  "stale",
  "unknown-requester",
  "host-read-failed"
]
const themes: ReadonlyArray<"light" | "dark"> = ["light", "dark"]

for (const width of [390, 1280]) {
  for (const theme of themes) {
    for (const state of states) {
      test(`${state} at ${width} in ${theme}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: width + 2, height: 844 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.clock.install({ time: Date.UTC(2026, 9, 10, 14, 2, 31) })
        await page.clock.pauseAt(Date.UTC(2026, 9, 10, 14, 2, 31))
        await page.route("**/assets/approvals.css", async (route) => {
          const response = await route.fetch()
          await route.fulfill({
            response,
            body: (await response.text()).replaceAll(/font-display:\s*(?:swap|optional)/g, "font-display:block")
          })
        })
        await page.goto(`/?state=${state}&theme=${theme}`)
        await expect(page.getByRole("heading", { name: "Approvals", exact: true })).toBeAttached()
        // The export includes a one-pixel device-frame border. The real shell supplies its masthead.
        await page.addStyleTag({
          content:
            "#root { border: 1px solid var(--rly-color-border-1); } .fleet-shell { min-block-size: 0; } .fleet-shell-main { padding-block-end: var(--rly-space-32); }"
        })
        if (state === "remote-selected" || state === "long-text") {
          await page.locator(".countdown-row[data-approval-host]").filter({
            hasText: state === "long-text" ? "garden-orange-builder" : "birch"
          }).click()
        }
        if (state === "full-request-open") {
          await page.locator(".countdown-row[data-approval-job='apr_4f2c1e']").click()
          await page.locator(".countdown-selected summary").click()
        }
        if (state === "long-text") {
          await page.locator(".countdown-selected summary").click()
          expect(
            await page.locator(".approval-request-json").evaluate((element) =>
              element.scrollWidth <= element.clientWidth
            )
          ).toBe(true)
        }
        if (state === "shortcuts-dialog") await page.keyboard.press("?")
        if (state === "stale") {
          await page.clock.runFor(15_000)
          await expect(page.locator(".countdown-freshness")).toContainText("15s ago")
          await page.clock.runFor(16_000)
          await expect(page.locator(".countdown-freshness")).toContainText("Stale")
        }
        if (state === "empty" || state === "fresh-install") {
          await expect(page.locator(".countdown-waiting .countdown-empty")).toHaveText("No requests waiting")
        }
        if (state === "refresh-failure" || state === "host-read-failed") {
          await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
        }
        if (state === "unknown-requester") {
          await expect(page.locator(".countdown-request-header")).toContainText("Requester unreadable")
        }
        if (state === "approvals-off" || state === "host-read-failed") {
          await expect(page.locator("[data-rly-decision-bar]")).toHaveAttribute("data-state", "off")
        }
        if (
          !["empty", "fresh-install", "host-unchecked", "paged-first-empty"].includes(state) &&
          state !== "shortcuts-dialog"
        ) {
          const selected = page.locator(".countdown-selected")
          await expect(selected).toBeVisible()
          if (width === 1280) {
            const listBox = await page.locator(".countdown-waiting").boundingBox()
            const selectedBox = await selected.boundingBox()
            const historyBox = await page.locator(".countdown-decided").boundingBox()
            expect(listBox?.width).toBe(320)
            expect(selectedBox?.x).toBeGreaterThan((listBox?.x ?? 0) + (listBox?.width ?? 0))
            expect(historyBox?.x).toBe(listBox?.x)
            expect(historyBox?.y).toBeCloseTo((listBox?.y ?? 0) + (listBox?.height ?? 0) + 24, 0)
          }
        }
        await page.evaluate(() => document.fonts.ready)
        const notificationBox = await page.locator(".notification-status").boundingBox()
        const regionsBox = await page.locator(".countdown-regions").boundingBox()
        expect(regionsBox?.y).toBeCloseTo((notificationBox?.y ?? 0) + (notificationBox?.height ?? 0) + 24, 0)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await page.locator("#root").screenshot({
          path: testInfo.outputPath(`fidelity/approvals-${state}-${width}-${theme}.png`),
          animations: "disabled"
        })
      })
    }
  }
}

test("phone decisions and disclosure have 44px targets, visible focus and exact arguments", async ({ page }) => {
  await page.goto("/?state=populated")
  await expect(page.locator(".countdown-selected [data-rly-decision-bar]")).toHaveCSS("border-block-start-width", "1px")
  const summary = page.locator(".countdown-selected summary")
  expect(
    await summary.evaluate((element) => Number.parseFloat(getComputedStyle(element, "::before").fontSize))
  ).toBeGreaterThanOrEqual(16)
  const connect = page.getByRole("link", { name: "Open run-bb in Connect", exact: true })
  await expect(connect.locator("svg")).toHaveAttribute("aria-hidden", "true")
  expect(await connect.evaluate((element) => Number(getComputedStyle(element).fontWeight))).toBeGreaterThanOrEqual(600)
  const audit = page.locator(".countdown-history-audit")
  await expect(audit).not.toHaveAttribute("open")
  await audit.locator(":scope > summary").click()
  await audit.locator(".approval-request-disclosure").first().locator("summary").click()
  await expect(audit.locator(".approval-request-detail").first()).toContainText("nix.check")
  await audit.locator(":scope > summary").click()
  await summary.click()
  await expect(page.locator(".countdown-selected details")).toHaveAttribute("open", "")
  await expect(page.locator(".countdown-selected .approval-request-detail")).toContainText("/workspace/project")
  await page.keyboard.press("Tab")
  for (
    const control of [
      summary,
      page.getByRole("button", { name: "Approve: Delegate agent work", exact: true }),
      page.getByRole("button", { name: "Reject: Delegate agent work", exact: true })
    ]
  ) {
    const box = await control.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
    await control.focus()
    expect(await control.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none")
  }
  await page.getByRole("button", { name: "Approve: Delegate agent work", exact: true }).click()
  await expect(page.locator("[data-fixture-decisions]")).toHaveText(
    "[{\"decision\":\"approve\",\"jobId\":\"apr_451d2c\"}]"
  )
})

test("stale approval revalidates and remains bound to its request", async ({ page }) => {
  await page.clock.install({ time: Date.UTC(2026, 9, 10, 14, 2, 31) })
  await page.clock.pauseAt(Date.UTC(2026, 9, 10, 14, 2, 31))
  await page.goto("/?state=stale")
  await page.clock.runFor(15_000)
  await expect(page.locator(".countdown-freshness")).toContainText("15s ago")
  await page.clock.runFor(16_000)
  await expect(page.locator(".countdown-freshness")).toContainText("Stale")
  await page.getByRole("button", { name: "Approve: Delegate agent work", exact: true }).click()
  await expect(page.locator("[data-fixture-reads]")).toHaveText("1")
  await expect(page.locator("[data-fixture-decisions]")).toHaveText(
    "[{\"decision\":\"approve\",\"jobId\":\"apr_451d2c\"}]"
  )
})

test("requester leans once, holds on polling, and becomes static with reduced motion", async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("animationstart", (event) => {
      if (
        event.animationName === "countdown-requester-entry" &&
        event.target === document.querySelector(".countdown-request-header .connect-creature-lean")
      ) {
        document.body.dataset["approvalEntryStarts"] = String(
          Number(document.body.dataset["approvalEntryStarts"] ?? "0") + 1
        )
      }
    })
  })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.clock.install({ time: Date.UTC(2026, 9, 10, 14, 2, 31) })
  await page.clock.pauseAt(Date.UTC(2026, 9, 10, 14, 2, 31))
  await page.goto("/?state=populated")
  const lean = page.locator(".countdown-request-header .connect-creature-lean")
  await expect(page.locator("body")).toHaveAttribute("data-approval-entry-starts", "1")
  await expect(lean).toHaveCSS("animation-name", "none")
  await expect(lean).toHaveCSS("rotate", "-3deg")
  await page.clock.runFor(15_000)
  await expect(page.locator(".countdown-freshness")).toContainText("15s ago")
  await page.clock.runFor(16_000)
  await expect(page.locator(".countdown-freshness")).toContainText("Stale")
  await page.getByRole("button", { name: "Approve: Delegate agent work", exact: true }).click()
  await expect(page.locator("[data-fixture-reads]")).toHaveText("1")
  await expect(lean).toHaveCSS("animation-name", "none")
  await expect(page.locator("body")).toHaveAttribute("data-approval-entry-starts", "1")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.reload()
  await expect(page.locator(".countdown-request-header .connect-creature-lean")).toHaveCSS("animation-name", "none")
  await expect(page.locator(".countdown-request-header .connect-creature")).toHaveAttribute("aria-hidden", "true")
  expect(
    await page.locator(".countdown-request-header .connect-creature *").evaluateAll((elements) =>
      elements.every((element) => getComputedStyle(element).animationName === "none")
    )
  ).toBe(true)
})

test("forced colours retain selection and written request state", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" })
  await page.goto("/?state=populated")
  await expect(page.locator(".countdown-row[aria-current='true']")).toHaveCSS("outline-style", "solid")
  await expect(page.locator(".countdown-pending-count")).toHaveText("3 waiting on you")
  await expect(page.getByRole("button", { name: "Approve: Delegate agent work", exact: true })).toBeVisible()
  await expect(page.locator(".countdown-request-header")).toContainText("Requested by owner")
})
