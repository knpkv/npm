import { expect, test } from "@playwright/test"
import { Schema } from "effect"
import { ConfirmPayload } from "../../src/shared/contracts.js"

test.beforeEach(async ({ page }) => {
  await page.clock.install()
  const response = await page.request.post("/__test/reset")
  const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json())
  await page.goto(setup.url)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Quick approve · 5s Undo", exact: true }).click()
})

// Undo removes both optimistic providers before any create request can leave the browser.
test("one click previews approval and Undo restores the suggestion without a write", async ({ page }) => {
  const writes: Array<string> = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/rows/confirm") writes.push(request.url())
  })
  const suggestion = page.getByRole("button", { name: /PROJ-123, 11:00/ })
  await suggestion.click()
  await expect(page.getByRole("complementary", { name: "Time entry editor" })).toHaveCount(0)
  await expect(page.locator(".jcf-block[data-pending=\"true\"]")).toHaveCount(2)
  const queue = page.getByRole("region", { name: "Approval queue" })
  await queue.getByRole("button", { name: /^Undo PROJ-123/ }).click()
  await expect(queue).toHaveCount(0)
  await expect(suggestion).toBeVisible()
  await page.clock.runFor(6000)
  expect(writes).toEqual([])
})

test("quick approval and Undo fit the phone agenda", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator(".jcf-agenda-entry[data-kind=proposable]").first().click()
  const queue = page.getByRole("region", { name: "Approval queue" })
  await expect(queue).toBeVisible()
  expect(await queue.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await queue.getByRole("button", { name: /^Undo / }).click()
  await expect(queue).toHaveCount(0)
  await expect(page.locator(".jcf-agenda-entry[data-kind=proposable]").first()).toBeVisible()
})

// A held first request must not block queueing another block or trigger a totals read between writes.
test("queues while saving, intersects changed layers, then refreshes totals once", async ({ page }) => {
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const requests: Array<typeof ConfirmPayload.Type> = []
  await page.route("**/api/rows/confirm", async (route) => {
    const payload = Schema.decodeUnknownSync(ConfirmPayload)(route.request().postDataJSON())
    requests.push(payload)
    if (requests.length === 1) await held
    await route.fulfill({
      json: {
        clockify: payload.targets?.clockify === true ? { _tag: "Written", seconds: 3600 } : { _tag: "Skipped" },
        jira: { _tag: "Written", seconds: 3600 },
        description: "Queued work",
        lines: ["Logged queued work"]
      }
    })
  })
  const totals: Array<string> = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/week/recorded") totals.push(request.url())
  })
  await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
  await page.clock.runFor(6000)
  await expect.poll(() => requests.length).toBe(1)
  await page.getByRole("button", { name: /PROJ-123, 14:00/ }).click()
  const queue = page.getByRole("region", { name: "Approval queue" })
  await expect(queue.getByRole("listitem")).toHaveCount(2)
  await expect(page.getByRole("button", { name: "Next week", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Clockify entries", exact: true }).click()
  await page.clock.runFor(6000)
  expect(requests).toHaveLength(1)
  expect(totals).toEqual([])
  release?.()
  await expect(queue).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  expect(requests).toHaveLength(2)
  expect(requests[0]?.targets).toEqual({ jira: true, clockify: true })
  expect(requests[1]?.targets).toEqual({ jira: true, clockify: false })
  expect(totals).toHaveLength(1)
})
