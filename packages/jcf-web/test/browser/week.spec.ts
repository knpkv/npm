import { expect, type Page, test } from "@playwright/test"
import { Schema } from "effect"
import type { WriteResultResponse } from "../../src/shared/contracts.js"
import { fixtureWeek } from "../fixture.js"

const pinFixtureWeek = (page: Page) =>
  page.addInitScript(() => {
    if (window.localStorage.getItem("jcf_web_week") === null) window.localStorage.setItem("jcf_web_week", "2026-09-07")
  })

const bootstrap = async (page: Page, scenario?: "seconds" | "whole-minutes" | "sub-hour-seconds" | "overlap") => {
  const response = await page.request.post(`/__test/reset${scenario === undefined ? "" : `?scenario=${scenario}`}`)
  expect(response.ok()).toBe(true)
  const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json())
  await pinFixtureWeek(page)
  await page.goto(setup.url)
}

const open = async (page: Page, scenario?: "seconds" | "whole-minutes" | "sub-hour-seconds" | "overlap") => {
  await bootstrap(page, scenario)
  await expect(page.getByRole("heading", { name: "7–13 September 2026" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
}

// The conversation shares the editor column without changing the calendar's geometry.
for (const width of [1440, 390]) {
  test(`agent conversation uses the side panel without moving the calendar at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 1000 })
    await open(page)
    const calendar = page.getByRole("region", { name: "Week calendar", exact: true })
    const beforeScan = await calendar.boundingBox()
    await request.get("/__test/hold-start")
    await page.getByRole("button", { name: "Rescan sessions", exact: true }).click()
    await expect(page.getByRole("region", { name: "Agent request", exact: true }).locator("pre")).toContainText(
      "supplied evidence"
    )
    const panel = page.getByRole("complementary", { name: "Agent conversation", exact: true })
    await expect(panel.getByRole("region", { name: "Week loading progress" })).toBeVisible()
    expect(await calendar.boundingBox()).toEqual(beforeScan)
    await panel.getByText("Loading details", { exact: false }).click()
    await expect(panel.getByText("Read logged time", { exact: true })).toBeVisible()
    expect(await calendar.boundingBox()).toEqual(beforeScan)
    await panel.getByText("Loading details", { exact: false }).click()
    await request.get("/__test/finish")
    await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
    await expect(panel.getByRole("region", { name: "Agent response", exact: true })).toBeVisible()
    const before = await calendar.boundingBox()
    expect(before).not.toBeNull()
    const bounds = await panel.boundingBox()
    expect(bounds).not.toBeNull()
    if (before !== null && bounds !== null) {
      if (width > 1100) expect(bounds.x).toBeGreaterThanOrEqual(before.x + before.width)
      else {
        expect(bounds.x).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
        expect(bounds.height).toBeLessThanOrEqual(750)
      }
    }
    await panel.getByRole("button", { name: "Close", exact: true }).click()
    await expect(panel).toHaveCount(0)
    expect(await calendar.boundingBox()).toEqual(before)
    const trigger = page.getByRole("button", { name: "Agent requests and responses", exact: true })
    await trigger.click()
    await expect(panel).toBeFocused()
    expect(await calendar.boundingBox()).toEqual(before)
    await page.keyboard.press("Escape")
    await expect(panel).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(await calendar.boundingBox()).toEqual(before)
  })
}

test("streams detailed progress, keeps the previous week visible, and cancels a read", async ({ page, request }) => {
  await open(page)
  await request.get("/__test/hold")
  await page.getByRole("button", { name: "Rescan sessions", exact: true }).first().click()
  await expect(page.getByRole("status")).toContainText("2 of 8 sessions checked.")
  await expect(page.getByRole("progressbar", { name: "Sessions checked" })).toHaveAttribute("value", "2")
  await expect(page.getByRole("region", { name: "Agent activity" })).toContainText(
    "Checking session context. Matched PROJ-5662."
  )
  const terminal = page.getByRole("region", { name: "Agent activity" })
  await expect(terminal.getByRole("region", { name: "Agent response", exact: true })).toBeVisible()
  await expect(terminal.locator("textarea, input, [contenteditable=true]")).toHaveCount(0)
  await expect(terminal.getByRole("region", { name: "Agent response", exact: true }).locator("pre")).toBeVisible()
  await page.getByText("Loading details", { exact: false }).click()
  await expect(page.getByText("Read logged time", { exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "7–13 September 2026" })).toBeVisible()
  await page.screenshot({ path: "test-results/read-progress.png", fullPage: true })
  await page.getByRole("button", { name: "Cancel read" }).click()
  await expect(page.getByText("Read cancelled", { exact: true })).toBeVisible()
  await request.get("/__test/finish")
  await page.getByRole("button", { name: "Rescan sessions", exact: true }).first().click()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
})

test("a newer scope wins over a slow older read", async ({ page }) => {
  await open(page)
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let firstRefresh = true
  let signalHeld: (() => void) | undefined
  const intercepted = new Promise<void>((resolve) => {
    signalHeld = resolve
  })
  await page.route("**/api/week/recorded?*", async (route) => {
    if (firstRefresh) {
      firstRefresh = false
      signalHeld?.()
      await held
    }
    await route.continue()
  })
  await page.getByRole("button", { name: "Jira only", exact: true }).click()
  await intercepted
  await expect(page.getByRole("status")).toBeVisible()
  await page.getByRole("button", { name: "Clockify only", exact: true }).click()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  release?.()
  await expect(page.getByRole("button", { name: "Clockify only", exact: true })).toHaveAttribute("aria-pressed", "true")
})

test("selects one block, keeps the editor in view and restores keyboard focus", async ({ page }) => {
  await open(page)
  const block = page.getByRole("button", { name: /PROJ-123, 11:00/ })
  await block.focus()
  await block.press("Enter")
  const editor = page.getByRole("complementary", { name: "Time entry editor" })
  await expect(editor).toBeFocused()
  await expect(editor.getByRole("textbox", { name: "Amount", exact: true })).toHaveValue("1h 0m")
  await expect(page.locator(".jcf-block-gap[data-selected=\"true\"]")).toHaveCount(1)
  const bounds = await editor.boundingBox()
  expect(bounds?.y).toBeLessThan(500)
  await editor.getByRole("textbox", { name: "Amount", exact: true }).fill("3h")
  await expect(editor.getByRole("button", { name: "Log selected time" })).toBeDisabled()
  await expect(editor.getByRole("alert")).toContainText("This block contains")
  await expect(editor.getByRole("group", { name: "Blocks to write" })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(editor).toHaveCount(0)
  await expect(block).toBeFocused()
  await page.locator(".jcf-block-logged").first().click()
  await expect(page.getByRole("complementary", { name: "Saved time editor" })).toBeVisible()
  await expect(editor).toHaveCount(0)
})

const exactAmountCases: ReadonlyArray<{
  readonly scenario: "seconds" | "whole-minutes" | "sub-hour-seconds"
  readonly seconds: number
  readonly amount: string
}> = [
  { scenario: "seconds", seconds: 5027, amount: "1h 23m 47s" },
  { scenario: "whole-minutes", seconds: 4980, amount: "1h 23m" },
  { scenario: "sub-hour-seconds", seconds: 3027, amount: "50m 27s" }
]

for (const { amount, scenario, seconds } of exactAmountCases) {
  test(`confirming an unchanged ${seconds}-second block writes its exact amount`, async ({ page }) => {
    await open(page, scenario)
    await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
    const editor = page.getByRole("complementary", { name: "Time entry editor" })
    await expect(editor.getByRole("textbox", { name: "Amount", exact: true })).toHaveValue(amount)
    await expect(editor.getByText("The entry will say the amount was set by hand.")).toHaveCount(0)
    const submitted = page.waitForRequest((request) => request.url().includes("/api/rows/confirm"))
    await editor.getByRole("button", { name: "Log selected time" }).click()
    expect((await submitted).postDataJSON()).not.toHaveProperty("seconds")
    await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
    const observations = Schema.decodeUnknownSync(Schema.Struct({
      clockifyWriteSeconds: Schema.Array(Schema.Number),
      jiraWriteSeconds: Schema.Array(Schema.Number)
    }))(await (await page.request.get("/__test/observations")).json())
    expect(observations.clockifyWriteSeconds).toEqual([seconds])
    expect(observations.jiraWriteSeconds).toEqual([seconds])
  })
}

const previewCases: ReadonlyArray<{
  readonly scenario: "overlap" | undefined
  readonly seconds: number
  readonly preview: string
}> = [
  { scenario: "overlap", seconds: 1800, preview: "Clockify 30m 0s · Jira 30m 0s" },
  { scenario: undefined, seconds: 3600, preview: "Clockify 1h 0m · Jira 1h 0m" }
]

for (const { preview, scenario, seconds } of previewCases) {
  test(`confirmation preview agrees with both provider writes when ${scenario ?? "no time"} overlaps`, async ({ page }) => {
    await open(page, scenario)
    if (scenario === "overlap") {
      await page.getByRole("group", { name: "Visible calendar layers" }).getByRole("button", {
        name: "Overlap",
        exact: true
      }).click()
    }
    await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
    const editor = page.getByRole("complementary", { name: "Time entry editor" })
    await expect(editor.getByText(/Will add/)).toContainText(preview)
    await editor.getByRole("button", { name: "Log selected time" }).click()
    await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
    const observations = Schema.decodeUnknownSync(Schema.Struct({
      clockifyWriteSeconds: Schema.Array(Schema.Number),
      jiraWriteSeconds: Schema.Array(Schema.Number)
    }))(await (await page.request.get("/__test/observations")).json())
    expect(observations.clockifyWriteSeconds).toEqual([seconds])
    expect(observations.jiraWriteSeconds).toEqual([seconds])
  })
}

test("preview and provider writes agree after half a block was logged under a corrected ticket", async ({ page }) => {
  await open(page)
  const block = page.getByRole("button", { name: /PROJ-123, 11:00/ })
  await block.click()
  const editor = page.getByRole("complementary", { name: "Time entry editor" })
  await editor.getByRole("textbox", { name: "Issue key", exact: true }).fill("PROJ-456")
  await editor.getByRole("textbox", { name: "Amount", exact: true }).fill("30m")
  await editor.getByRole("button", { name: "Log selected time" }).click()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()

  await page.getByRole("group", { name: "Visible calendar layers" }).getByRole("button", {
    name: "Overlap",
    exact: true
  }).click()
  await block.click()
  await expect(editor.getByRole("textbox", { name: "Amount", exact: true })).toHaveValue("1h 0m")
  await expect(editor.getByText("The entry will say the amount was set by hand.")).toHaveCount(0)
  await expect(editor.getByText(/Will add/)).toContainText("Clockify 30m 0s · Jira 30m 0s")
  await editor.getByRole("button", { name: "Log selected time" }).click()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  const observations = Schema.decodeUnknownSync(Schema.Struct({
    clockifyWriteSeconds: Schema.Array(Schema.Number),
    jiraWriteSeconds: Schema.Array(Schema.Number)
  }))(await (await page.request.get("/__test/observations")).json())
  expect(observations.clockifyWriteSeconds).toEqual([1800, 1800])
  expect(observations.jiraWriteSeconds).toEqual([1800, 1800])
})

test("preview keeps provider consumption separate after a Clockify-only corrected write", async ({ page }) => {
  await open(page)
  const block = page.getByRole("button", { name: /PROJ-123, 11:00/ })
  await block.click()
  const editor = page.getByRole("complementary", { name: "Time entry editor" })
  await editor.getByRole("textbox", { name: "Issue key", exact: true }).fill("PROJ-456")
  await editor.getByRole("textbox", { name: "Amount", exact: true }).fill("30m")
  await editor.getByRole("group", { name: "Write to selected layers" }).getByRole("checkbox", { name: "Jira" })
    .uncheck()
  await editor.getByRole("button", { name: "Log selected time" }).click()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()

  await page.getByRole("group", { name: "Visible calendar layers" }).getByRole("button", {
    name: "Overlap",
    exact: true
  }).click()
  await block.click()
  await expect(editor.getByText(/Will add/)).toContainText("Clockify 30m 0s · Jira 1h 0m")
  await editor.getByRole("button", { name: "Log selected time" }).click()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  const observations = Schema.decodeUnknownSync(Schema.Struct({
    clockifyWriteSeconds: Schema.Array(Schema.Number),
    jiraWriteSeconds: Schema.Array(Schema.Number)
  }))(await (await page.request.get("/__test/observations")).json())
  expect(observations.clockifyWriteSeconds).toEqual([1800, 1800])
  expect(observations.jiraWriteSeconds).toEqual([3600])
})

test("mobile agenda, manual date selection, validation and partial-write feedback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  await expect(page.locator(".jcf-agenda")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole("button", { name: "Log time", exact: true }).first().click()
  const editor = page.getByRole("complementary", { name: "Time entry editor" })
  await editor.getByRole("textbox", { name: "Issue key", exact: true }).fill("proj-123")
  await editor.getByRole("textbox", { name: "Amount", exact: true }).fill("25h")
  await expect(editor.getByRole("button", { name: "Log time", exact: true })).toBeDisabled()
  await editor.getByRole("textbox", { name: "Amount", exact: true }).fill("45m")
  await editor.getByLabel("Day", { exact: true }).selectOption("2026-09-09")
  const note = editor.getByRole("textbox", { name: "What was done (optional)", exact: true })
  await expect(note).toHaveJSProperty("tagName", "TEXTAREA")
  await note.fill("Team meeting\nReviewed next steps.")
  let payload: unknown
  await page.route("**/api/rows/manual", async (route) => {
    payload = route.request().postDataJSON()
    await route.fulfill({
      json: {
        clockify: { _tag: "Written", seconds: 2700 },
        jira: { _tag: "NotLoggedIn" },
        description: "Team meeting",
        lines: ["Clockify: 45m logged", "Jira: not logged in"]
      }
    })
  })
  await editor.getByRole("button", { name: "Log time", exact: true }).click()
  await expect(page.getByText("Some time could not be logged", { exact: true })).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "Some time could not be logged" })).toHaveClass(/caution/u)
  expect(payload).toMatchObject({
    day: "2026-09-09",
    ticketKey: "PROJ-123",
    seconds: 2700,
    note: "Team meeting\nReviewed next steps."
  })
  await page.getByLabel("Appearance", { exact: true }).selectOption("dark")
  await page.screenshot({ path: "test-results/mobile-dark.png", fullPage: true })
})

test("light and dark calendars fit desktop and narrow calendar scroll stays inside the page", async ({ page }) => {
  await open(page)
  await page.getByLabel("Appearance", { exact: true }).selectOption("light")
  await page.screenshot({ path: "test-results/desktop-light.png", fullPage: true })
  await page.getByLabel("Appearance", { exact: true }).selectOption("dark")
  await page.screenshot({ path: "test-results/desktop-dark.png", fullPage: true })
  await page.setViewportSize({ width: 320, height: 700 })
  await page.getByRole("button", { name: "Calendar", exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(page.getByRole("region", { name: "Scrollable weekly calendar" })).toBeVisible()
})

test("failed reads preserve the visible week and offer a working retry", async ({ page }) => {
  await open(page)
  await page.route(
    "**/api/week/stream?*",
    (route) => route.fulfill({ status: 503, json: { message: "Jira is temporarily unavailable" } }),
    { times: 1 }
  )
  await page.getByRole("button", { name: "Rescan sessions", exact: true }).first().click()
  await expect(page.getByRole("alert")).toContainText("Jira is temporarily unavailable")
  await expect(page.getByRole("heading", { name: "7–13 September 2026" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Log time", exact: true }).first()).toBeDisabled()
  await page.getByRole("alert").getByRole("button", { name: "Rescan sessions", exact: true }).click()
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Log time", exact: true }).first()).toBeEnabled()
})

test("after a write refreshes only totals and releases navigation while totals load", async ({ page }) => {
  await open(page)
  let fullReads = 0
  page.on("request", (request) => {
    if (request.url().includes("/api/week/stream")) fullReads += 1
  })
  let finish: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  await page.route("**/api/week/recorded?*", async (route) => {
    await held
    await route.continue()
  })
  await page.route("**/api/rows/confirm", (route) =>
    route.fulfill({
      json: {
        clockify: { _tag: "Written", seconds: 3600 },
        jira: { _tag: "Written", seconds: 3600 },
        description: "Confirmed work",
        lines: ["Logged one hour"]
      }
    }))
  await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
  await page.getByRole("button", { name: "Log selected time" }).click()
  await expect(page.getByText("Time checked", { exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: "Week loading progress" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Next week", exact: true })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Both", exact: true })).toBeEnabled()
  await page.getByText("Loading details", { exact: false }).click()
  await expect(page.getByText("Read logged time", { exact: true })).toBeVisible()
  await expect(page.getByText("Match tickets", { exact: true })).toHaveCount(0)
  finish?.()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  expect(fullReads).toBe(0)
})

for (
  const { failure, source } of [
    { source: "jira", failure: "NotLoggedIn" },
    { source: "jira", failure: "Refused" },
    { source: "clockify", failure: "NotLoggedIn" },
    { source: "clockify", failure: "Refused" }
  ] satisfies ReadonlyArray<{ readonly source: "jira" | "clockify"; readonly failure: "NotLoggedIn" | "Refused" }>
) {
  test(`a partially written ${source} approval with ${failure} reports the saved minute and failure`, async ({ page }) => {
    await open(page)
    const label = source === "jira" ? "Jira" : "Clockify"
    const failureDetail = failure === "NotLoggedIn" ? "later segment needs login" : "later segment was refused"
    const partial = {
      _tag: "PartiallyWritten",
      seconds: 60,
      failure: failure === "NotLoggedIn" ? { _tag: "NotLoggedIn" } : { _tag: "Refused", message: "Rejected" }
    } satisfies WriteResultResponse["jira"]
    let writes = 0
    await page.route("**/api/rows/confirm", (route) => {
      writes += 1
      return route.fulfill({
        json: {
          clockify: source === "clockify" ? partial : { _tag: "Skipped" },
          jira: source === "jira" ? partial : { _tag: "Skipped" },
          description: "Saved first minute",
          lines: [`${label}: 1m 0s logged`, `${label}: ${failureDetail}`]
        }
      })
    })
    await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
    await page.getByRole("button", { name: "Log selected time" }).click()
    const result = page.getByRole("status").filter({ hasText: "Some time could not be logged" })
    await expect(result).toBeVisible()
    await expect(result).toHaveClass(/caution/u)
    await expect(result).toContainText(`${label}: 1m 0s logged`)
    await expect(result).toContainText(`${label}: ${failureDetail}`)
    await expect(result).toContainText("Saved first minute")
    expect(writes).toBe(1)
  })
}

test("a written provider with the other skipped keeps a positive result", async ({ page }) => {
  await open(page)
  await page.route("**/api/rows/confirm", (route) =>
    route.fulfill({
      json: {
        clockify: { _tag: "Written", seconds: 60 },
        jira: { _tag: "Skipped" },
        description: "Saved first minute",
        lines: ["Clockify: 1m 0s logged", "Jira: not selected"]
      }
    }))
  await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
  await page.getByRole("button", { name: "Log selected time" }).click()
  const result = page.getByRole("status").filter({ hasText: "Time checked" })
  await expect(result).toBeVisible()
  await expect(result).toHaveClass(/positive/u)
  await expect(result).toContainText("Clockify: 1m 0s logged")
})

test("failed post-write refresh retries totals without rescanning or repeating the write", async ({ page }) => {
  await open(page)
  let fullReads = 0
  let writes = 0
  let refreshes = 0
  page.on("request", (request) => {
    if (request.url().includes("/api/week/stream")) fullReads += 1
    if (request.url().includes("/api/week/recorded")) refreshes += 1
  })
  await page.route("**/api/rows/manual", (route) => {
    writes += 1
    return route.fulfill({
      json: {
        clockify: { _tag: "Written", seconds: 900 },
        jira: { _tag: "Written", seconds: 900 },
        description: "Meeting",
        lines: ["Logged 15 minutes"]
      }
    })
  })
  await page.route(
    "**/api/week/recorded?*",
    (route) => route.fulfill({ status: 503, json: { message: "Clockify unavailable" } }),
    { times: 1 }
  )
  await page.getByRole("button", { name: "Log time", exact: true }).first().click()
  const editor = page.getByRole("complementary", { name: "Time entry editor" })
  await editor.getByRole("textbox", { name: "Issue key", exact: true }).fill("PROJ-123")
  await editor.getByRole("textbox", { name: "Amount", exact: true }).fill("15m")
  await editor.getByRole("button", { name: "Log time", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Could not update logged time")
  await page.getByRole("button", { name: "Retry read" }).click()
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  expect(fullReads).toBe(0)
  expect(refreshes).toBe(2)
  expect(writes).toBe(1)
})

test("fifteen-minute allocations have readable labels and do not overlap visually", async ({ page }) => {
  const plan = fixtureWeek()
  const template = plan.rows[0]!
  const start = new Date(`${plan.monday}T10:00:00`).getTime()
  await page.route("**/api/week/stream**", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: `${
        JSON.stringify({
          _tag: "Complete",
          plan: {
            ...plan,
            rows: Array.from({ length: 4 }, (_, index) => ({
              ...template,
              rowId: `allocated-${index}`,
              ticketKey: `PROJ-${7000 + index}`,
              intervals: [],
              clockifySeconds: 0,
              jiraSeconds: 0,
              proposal: {
                ...template.proposal,
                blocks: [{
                  startMs: start + index * 900_000,
                  endMs: start + (index + 1) * 900_000,
                  seconds: 900,
                  consumed: { clockify: 0, jira: 0 }
                }],
                maxSeconds: 900,
                clockifyDelta: 900,
                jiraDelta: 900
              }
            }))
          }
        })
      }\n`
    }))
  await open(page)
  await page.getByRole("button", { name: "Rescan sessions", exact: true }).click()
  const blocks = page.locator(".jcf-block-gap")
  await expect(blocks).toHaveCount(4)
  let end = 0
  for (let index = 0; index < 4; index++) {
    const block = blocks.nth(index)
    await expect(block.locator(".jcf-block-key")).toHaveText(`PROJ-${7000 + index}`)
    const bounds = await block.boundingBox()
    expect(bounds).not.toBeNull()
    if (bounds === null) continue
    expect(bounds.y).toBeGreaterThanOrEqual(end)
    expect(bounds.width).toBeGreaterThan(100)
    expect(bounds.height).toBeGreaterThanOrEqual(28)
    end = bounds.y + bounds.height
  }
  await page.screenshot({ path: "test-results/allocated-quarter-hours.png", fullPage: true })
})

test("read-only conversation fits mobile and typing cannot send commands", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  await request.get("/__test/hold")
  const mutations: Array<string> = []
  page.on("request", (request) => {
    if (request.method() === "POST") mutations.push(request.url())
  })
  await page.getByRole("button", { name: "Rescan sessions", exact: true }).first().click()
  const terminal = page.getByRole("region", { name: "Agent activity" })
  await expect(terminal.getByRole("region", { name: "Agent response", exact: true })).toBeVisible()
  await expect(terminal.locator("textarea, input, [contenteditable=true]")).toHaveCount(0)
  await terminal.getByRole("region", { name: "Agent response", exact: true }).locator("pre").focus()
  await page.keyboard.type("echo cannot-send")
  await page.keyboard.press("Enter")
  expect(mutations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: "test-results/mobile-agent-terminal.png", fullPage: true })
  await page.getByRole("button", { name: "Cancel read" }).click()
  await expect(terminal).toHaveCount(0)
  await request.get("/__test/finish")
})

// Empty startup and status-only updates must keep the conversation and calendar usable.
test("conversation survives empty startup and status-only updates between output chunks", async ({ page, request }) => {
  const errors: Array<string> = []
  page.on("pageerror", (error) => errors.push(error.message))
  await open(page)
  await request.get("/__test/hold-start")
  await page.getByRole("button", { name: "Rescan sessions", exact: true }).first().click()
  const terminal = page.getByRole("region", { name: "Agent activity" })
  await expect(terminal.getByRole("region", { name: "Agent response", exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "7–13 September 2026" })).toBeVisible()
  await expect(terminal.getByText("Agent started", { exact: true })).toBeVisible()
  await request.get("/__test/activity")
  await expect(terminal.getByRole("region", { name: "Agent response", exact: true }).locator("pre")).toContainText(
    "Matched PROJ-5662."
  )
  await request.get("/__test/activity")
  await expect(terminal.getByText("Answer received", { exact: true })).toBeVisible()
  await expect(terminal.getByRole("region", { name: "Agent response", exact: true })).toBeVisible()
  expect(errors).toEqual([])
  await page.getByRole("button", { name: "Cancel read" }).click()
  await request.get("/__test/finish")
})

test("keeps each request and completed response readable after the week finishes", async ({ page, request }) => {
  await open(page)
  await request.get("/__test/hold-start")
  await page.getByRole("button", { name: "Rescan sessions", exact: true }).first().click()
  const terminal = page.getByRole("region", { name: "Agent activity" })
  await expect(terminal.getByRole("region", { name: "Agent response", exact: true })).toBeVisible()
  await expect(terminal.getByRole("region", { name: "Agent request", exact: true }).locator("pre")).toHaveText(
    "Match the session about PROJ-5662 using its supplied evidence."
  )
  await request.get("/__test/activity")
  await request.get("/__test/activity")
  await request.get("/__test/finish")
  await expect(page.getByText("Agent requests and responses", { exact: true })).toBeVisible()
  await expect(terminal.getByRole("region", { name: "Agent response", exact: true })).toBeVisible()
  await expect(terminal.getByRole("region", { name: "Agent response", exact: true }).locator("pre")).toHaveText(
    JSON.stringify({ answers: [{ ticketKey: "PROJ-5662" }] }, null, 2)
  )
  await expect(terminal.getByRole("region", { name: "Agent request", exact: true }).locator("pre")).toContainText(
    "supplied evidence"
  )
  await expect(terminal.getByRole("button", { name: /^(Request|Response)$/ })).toHaveCount(0)
  const messages = terminal.locator(".jcf-agent-message")
  await expect(messages.nth(0)).toHaveAttribute("data-speaker", "request")
  await expect(messages.nth(1)).toHaveAttribute("data-speaker", "response")
})

// Both providers may hold the same interval. Each remains independently visible without another read.
test("Jira, Clockify and suggestions are separate layers with provider totals", async ({ page }) => {
  const plan = fixtureWeek()
  const row = plan.rows[0]!
  await page.route("**/api/week/stream**", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: `${
        JSON.stringify({
          _tag: "Complete",
          plan: {
            ...plan,
            rows: [
              {
                ...row,
                jiraSeconds: 1800,
                intervals: [
                  ...row.intervals,
                  { source: "jira", startMs: row.intervals[0]!.startMs, endMs: row.intervals[0]!.startMs + 1800000 }
                ]
              }
            ]
          }
        })
      }\n`
    }))
  await open(page)
  await page.getByRole("button", { name: "Rescan sessions", exact: true }).click()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  let reads = 0
  page.on("request", (request) => {
    if (request.url().includes("/api/week/")) reads += 1
  })
  await expect(page.getByLabel("Jira totals")).toContainText("30m 0s saved")
  await expect(page.getByLabel("Clockify totals")).toContainText("1h 0m saved")
  const layers = page.getByRole("group", { name: "Visible calendar layers" })
  await expect(page.locator(".jcf-block-logged[data-source=\"jira\"]")).toHaveCount(1)
  await expect(page.locator(".jcf-block-logged[data-source=\"clockify\"]")).toHaveCount(1)
  await layers.getByRole("button", { name: "Jira entries", exact: true }).click()
  await expect(page.locator(".jcf-block-logged[data-source=\"jira\"]")).toHaveCount(0)
  await expect(page.locator(".jcf-block-logged[data-source=\"clockify\"]")).toHaveCount(1)
  await layers.getByRole("button", { name: "Overlap", exact: true }).click()
  await expect(page.locator(".jcf-block-gap")).toHaveCount(0)
  await layers.getByRole("button", { name: "Jira entries", exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator(".jcf-agenda-entry[data-source=\"jira\"]")).toBeVisible()
  await layers.getByRole("button", { name: "Clockify entries", exact: true }).click()
  await expect(page.locator(".jcf-agenda-entry[data-source=\"clockify\"]")).toHaveCount(0)
  await expect(page.getByLabel("Clockify totals")).toContainText("1h 0m saved")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(reads).toBe(0)
})

// A browser reload must restore the held evidence, never enter the expensive session route.
test("reload restores the selected week and refreshes totals without scanning sessions", async ({ page }) => {
  await open(page)
  await page.getByRole("button", { name: "Next week", exact: true }).click()
  await expect(page.getByRole("heading", { name: "14–20 September 2026" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Clockify only", exact: true }).click()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  const reads: Array<string> = []
  page.on("request", (request) => {
    if (request.url().includes("/api/week/")) reads.push(request.url())
  })
  await page.reload()
  await expect(page.getByRole("heading", { name: "14–20 September 2026" })).toBeVisible()
  await expect.poll(() => reads.filter((url) => url.includes("/recorded")).length).toBe(1)
  expect(reads.some((url) => url.includes("/stream"))).toBe(false)
  await page.getByRole("button", { name: "Rescan sessions", exact: true }).first().click()
  await expect.poll(() => reads.filter((url) => url.includes("/stream")).length).toBe(1)
})

// Hold the write at the HTTP boundary so pending UI must appear before any server result.
test("optimistic confirmation appears immediately and rolls back on failure", async ({ page }) => {
  await open(page)
  let finish: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  await page.route("**/api/rows/confirm", async (route) => {
    await held
    await route.fulfill({ status: 503, json: { message: "Creation failed" } })
  })
  await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
  await page.getByRole("button", { name: "Log selected time" }).click()
  const pending = page.locator(".jcf-block[data-pending=\"true\"]")
  await expect(pending).toHaveCount(2)
  await expect(pending.first()).toContainText("11:00–12:00")
  finish?.()
  await expect(page.getByRole("alert")).toContainText("Creation failed")
  await expect(pending).toHaveCount(0)
  await expect(page.getByRole("button", { name: /PROJ-123, 11:00/ })).toBeVisible()
})

test("optimistic manual entry keeps Clockify success when Jira creation fails", async ({ page }) => {
  await open(page)
  let finish: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  await page.route("**/api/rows/manual", async (route) => {
    await held
    await route.fulfill({
      json: {
        clockify: { _tag: "Written", seconds: 2700 },
        jira: { _tag: "Refused", message: "Creation failed" },
        description: "Meeting",
        lines: ["Clockify saved; Jira failed"]
      }
    })
  })
  await page.route(
    "**/api/week/recorded?*",
    (route) => route.fulfill({ status: 503, json: { message: "Totals unavailable" } })
  )
  await page.getByRole("button", { name: "Log time", exact: true }).first().click()
  const editor = page.getByRole("complementary", { name: "Time entry editor" })
  await editor.getByRole("textbox", { name: "Issue key", exact: true }).fill("PROJ-999")
  await editor.getByRole("textbox", { name: "Amount", exact: true }).fill("45m")
  await editor.getByRole("button", { name: "Log time", exact: true }).click()
  await expect(page.locator(".jcf-block[data-pending=\"true\"]")).toHaveCount(2)
  finish?.()
  await expect(page.getByRole("alert")).toContainText("Totals unavailable")
  await expect(page.locator(".jcf-block[data-pending=\"true\"]")).toHaveCount(0)
  await expect(page.locator(".jcf-block-logged[data-source=\"clockify\"]").filter({ hasText: "PROJ-999" })).toHaveCount(
    1
  )
  await expect(page.locator(".jcf-block-logged[data-source=\"jira\"]").filter({ hasText: "PROJ-999" })).toHaveCount(0)
})

test("missing plans do not start an agent or fall back to a full read", async ({ page }) => {
  const reset = await page.request.post("/__test/reset?seed=false")
  const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await reset.json())
  await pinFixtureWeek(page)
  let scans = 0
  page.on("request", (request) => {
    if (request.url().includes("/api/week/stream")) scans += 1
  })
  await page.goto(setup.url)
  await expect(page.getByText("No session suggestions for this week", { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText("No session suggestions for this week", { exact: true })).toBeVisible()
  expect(scans).toBe(0)
  const calendar = await page.getByRole("region", { name: "Week calendar", exact: true }).boundingBox()
  const empty = await page.getByRole("complementary", { name: "Session suggestions", exact: true }).boundingBox()
  expect(calendar).not.toBeNull()
  expect(empty).not.toBeNull()
  if (calendar !== null && empty !== null) {
    expect(empty.x).toBeGreaterThanOrEqual(calendar.x + calendar.width)
    expect(empty.y).toBeGreaterThanOrEqual(calendar.y)
  }
  const scan = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/week/stream")
  await page.getByRole("button", { name: "Scan sessions", exact: true }).click()
  await scan
  await expect(page.getByRole("heading", { name: "7–13 September 2026" })).toBeVisible()
  expect(scans).toBe(1)
})

// A ticket-less meeting occupies time too. Hiding its provider changes the suggestion category.
test("unkeyed Clockify entries count toward totals and visible-layer overlap", async ({ page }) => {
  const plan = fixtureWeek()
  const at = (hour: number) => new Date(`${plan.monday}T${hour}:00:00`).getTime()
  const updated = {
    ...plan,
    unlinkedClockify: [
      {
        day: plan.monday,
        description: "Team planning",
        seconds: 1800,
        startMs: at(11),
        endMs: at(11) + 1800000
      }
    ]
  }
  await page.route("**/api/week/recorded?*", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({ _tag: "Complete", plan: updated })}\n`
    }))
  await open(page)
  const layers = page.getByRole("group", { name: "Visible calendar layers" })
  const meeting = page.locator(".jcf-block-logged[data-source=\"clockify\"]").filter({ hasText: "Team planning" })
  await expect(meeting).toContainText("No ticket")
  await expect(page.getByLabel("Clockify totals")).toContainText("1h 30m saved")
  await expect(layers.getByRole("button", { name: "Overlap", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false"
  )
  await layers.getByRole("button", { name: "Overlap", exact: true }).click()
  await expect(page.locator(".jcf-block-gap[data-overlap=\"true\"]")).toHaveCount(1)
  await expect(layers.getByRole("button", { name: "No overlap", exact: true })).toHaveAttribute("aria-pressed", "false")
  await layers.getByRole("button", { name: "All", exact: true }).click()
  await expect(page.locator(".jcf-block-gap")).toHaveCount(2)
  await expect(layers.getByRole("button", { name: "Overlap", exact: true })).toHaveAttribute("aria-pressed", "false")
  await expect(layers.getByRole("button", { name: "No overlap", exact: true })).toHaveAttribute("aria-pressed", "false")
  await layers.getByRole("button", { name: "No overlap", exact: true }).click()
  await expect(page.locator(".jcf-block-gap")).toHaveCount(1)
  await expect(page.getByRole("button", { name: /PROJ-123, 14:00/ })).toBeVisible()
  await layers.getByRole("button", { name: "Clockify entries", exact: true }).click()
  await expect(meeting).toHaveCount(0)
  await expect(page.locator(".jcf-block-gap")).toHaveCount(2)
  await expect(page.getByRole("button", { name: /PROJ-123, 11:00/ })).toContainText("11:00–12:00")
  await layers.getByRole("button", { name: "Overlap", exact: true }).click()
  await expect(page.locator(".jcf-block-gap")).toHaveCount(0)
  await layers.getByRole("button", { name: "Clockify entries", exact: true }).click()
  await layers.getByRole("button", { name: "Overlap", exact: true }).click()
  await expect(page.locator(".jcf-block-gap")).toHaveCount(1)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator(".jcf-agenda-entry[data-overlap=\"true\"]")).toContainText("overlaps saved time")
  await expect(
    page.locator(".jcf-agenda-entry[data-source=\"clockify\"]").filter({ hasText: "Team planning" })
  ).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

// Exercise real authentication, confirmation, provider re-tally and SavedWeek JSON decoding.
// The fixture's old hand-written JSON omitted proposal instead of encoding its absent value as null.
test("real confirmation survives reload with a fully logged row", async ({ page }) => {
  await open(page)
  const before = await page.request.get("/__test/observations")
  const decodeObservations = Schema.decodeUnknownSync(
    Schema.Struct({
      clockifyWrites: Schema.Number,
      jiraWrites: Schema.Number,
      transcriptReads: Schema.Number
    })
  )
  const initial = decodeObservations(await before.json())
  let rescans = 0
  page.on("request", (request) => {
    if (request.url().includes("/api/week/stream")) rescans += 1
  })
  await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
  const confirmed = page.waitForResponse((response) => response.url().includes("/api/rows/confirm"))
  await page.getByRole("button", { name: "Log selected time" }).click()
  expect((await confirmed).status()).toBe(200)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  await expect(page.locator(".jcf-block-gap")).toHaveCount(0)
  await expect(page.getByLabel("Clockify totals")).toContainText("2h 0m saved")
  await expect(page.getByLabel("Jira totals")).toContainText("2h 0m saved")
  const saved = await page.request.get("/api/week/saved?monday=2026-09-07&only=both")
  expect(saved.status()).toBe(200)
  expect(await saved.json()).toMatchObject({ plan: { rows: [{ ticketKey: "PROJ-123", proposal: null }] } })
  await page.reload()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  await expect(page.getByRole("heading", { name: "7–13 September 2026" })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page.locator(".jcf-block-gap")).toHaveCount(0)
  await expect(page.getByLabel("Clockify totals")).toContainText("2h 0m saved")
  await expect(page.getByLabel("Jira totals")).toContainText("2h 0m saved")
  const after = decodeObservations(await (await page.request.get("/__test/observations")).json())
  expect(after).toEqual({ clockifyWrites: 1, jiraWrites: 1, transcriptReads: initial.transcriptReads })
  expect(rescans).toBe(0)
})

// Saved entries retain short actual durations. Their minimum drawn height still participates in collisions.
test("one-minute saved entries three minutes apart never cover another card", async ({ page }) => {
  const plan = fixtureWeek()
  const row = plan.rows[0]!
  const start = new Date(`${plan.monday}T11:00:00`).getTime()
  await page.route("**/api/week/recorded?*", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: `${
        JSON.stringify({
          _tag: "Complete",
          plan: {
            ...plan,
            rows: Array.from({ length: 5 }, (_, index) => ({
              ...row,
              rowId: `short-${index}`,
              ticketKey: `PROJ-${8000 + index}`,
              intervals: [{ source: "jira", startMs: start + index * 180000, endMs: start + index * 180000 + 60000 }],
              clockifySeconds: 0,
              jiraSeconds: 60,
              proposal: undefined
            }))
          }
        })
      }\n`
    }))
  await open(page)
  const cards = page.locator(".jcf-block-logged[data-source=\"jira\"]")
  await expect(cards).toHaveCount(5)
  const rectangles = await cards.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height }
    })
  )
  for (const [index, rectangle] of rectangles.entries()) {
    expect(rectangle.height).toBeGreaterThanOrEqual(24)
    for (const other of rectangles.slice(index + 1)) {
      const width = Math.min(rectangle.right, other.right) - Math.max(rectangle.left, other.left)
      const height = Math.min(rectangle.bottom, other.bottom) - Math.max(rectangle.top, other.top)
      expect(width > 0.5 && height > 0.5).toBe(false)
    }
  }
})

// Visibility is also write intent. A hidden provider must stay off even when the editor submits
// a confirmation, in both directions; the other provider remains usable.
for (const hidden of ["clockify", "jira"] satisfies ReadonlyArray<"clockify" | "jira">) {
  test(`hiding ${hidden} excludes it from confirmation writes`, async ({ page }) => {
    await open(page)
    const layers = page.getByRole("group", { name: "Visible calendar layers" })
    const label = hidden === "clockify" ? "Clockify entries" : "Jira entries"
    await layers.getByRole("button", { name: label, exact: true }).click()
    await page.route("**/api/rows/confirm", (route) =>
      route.fulfill({
        json: {
          clockify: hidden === "clockify" ? { _tag: "Skipped" } : { _tag: "Written", seconds: 3600 },
          jira: hidden === "jira" ? { _tag: "Skipped" } : { _tag: "Written", seconds: 3600 },
          description: "Confirmed work",
          lines: []
        }
      }))
    await page.getByRole("button", { name: /PROJ-123, 11:00/ }).click()
    const submitted = page.waitForRequest((request) => request.url().includes("/api/rows/confirm"))
    await page.getByRole("button", { name: "Log selected time" }).click()
    expect((await submitted).postDataJSON()).toMatchObject({
      targets: { clockify: hidden !== "clockify", jira: hidden !== "jira" }
    })
    await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  })
}
