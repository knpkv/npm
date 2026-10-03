import { expect, type Page, test } from "@playwright/test"
import { Schema } from "effect"
import { ConfirmPayload } from "../../src/shared/contracts.js"
import { fixtureWeek } from "../fixture.js"

const open = async (page: Page) => {
  await page.clock.install()
  const response = await page.request.post("/__test/reset")
  const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json())
  await page.goto(setup.url)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
}

const calendarPosition = (page: Page) =>
  page.locator(".jcf-calendar").evaluate((calendar) => ({
    top: calendar.getBoundingClientRect().top,
    scrollTop: calendar.scrollTop,
    hourTop: [...calendar.querySelectorAll(".jcf-hour-label")]
      .find((label) => label.textContent === "12:00")?.getBoundingClientRect().top,
    pageTop: window.scrollY
  }))

// Plus always queues, including in Review first. Undo must retain the visible time and never write.
for (const mode of ["Review first", "Quick approve · 5s Undo"]) {
  test(`calendar + queues with Undo and preserves position in ${mode}`, async ({ page }) => {
    await open(page)
    await page.getByRole("button", { name: mode, exact: true }).click()
    const requests: Array<string> = []
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/rows/")) requests.push(request.url())
    })
    const plus = page.getByRole("button", {
      name: "Quick approve PROJ-123 at 11:00–12:00 with 5-second Undo",
      exact: true
    })
    await plus.scrollIntoViewIfNeeded()
    const before = await calendarPosition(page)
    expect(before.hourTop).toEqual(expect.any(Number))
    await plus.click()
    const queue = page.getByRole("region", { name: "Approval queue" })
    await expect(queue.getByRole("listitem")).toHaveCount(1)
    await expect(page.getByRole("complementary", { name: "Time entry editor" })).toHaveCount(0)
    await expect(page.locator(".jcf-block[data-pending=\"true\"]")).toHaveCount(2)
    expect(await calendarPosition(page)).toEqual(before)
    await page.clock.runFor(4000)
    expect(requests).toEqual([])
    await queue.getByRole("button", { name: /^Undo PROJ-123/ }).click()
    await expect(queue).toHaveCount(0)
    expect(await calendarPosition(page)).toEqual(before)
    await page.clock.runFor(2000)
    expect(requests).toEqual([])
    await expect(plus).toBeEnabled()
  })
}

// The compact action is separate from the review button and large enough for a phone tap.
test("agenda + is keyboard accessible and leaves ordinary card review unchanged", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  const card = page.locator(".jcf-agenda-entry[data-kind=\"proposable\"]").first()
  await card.click()
  const editor = page.getByRole("complementary", { name: "Time entry editor" })
  await expect(editor).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(card).toBeFocused()
  const plus = page.getByRole("button", {
    name: "Quick approve PROJ-123 at 11:00–12:00 with 5-second Undo",
    exact: true
  })
  await plus.focus()
  const before = await page.evaluate(() => window.scrollY)
  const size = await plus.boundingBox()
  expect(size?.width).toBeGreaterThanOrEqual(44)
  expect(size?.height).toBeGreaterThanOrEqual(44)
  expect(await plus.evaluate((button) => button.parentElement?.closest("button"))).toBeNull()
  await page.keyboard.press("Enter")
  await expect(editor).toHaveCount(0)
  const queue = page.getByRole("region", { name: "Approval queue" })
  await expect(queue).toBeVisible()
  expect(await page.evaluate(() => window.scrollY)).toBe(before)
  await queue.getByRole("button", { name: /^Undo PROJ-123/ }).click()
  await expect(plus).toBeEnabled()
  expect(await page.evaluate(() => window.scrollY)).toBe(before)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

// Saving one queued block must leave other cards reviewable and their + actions available.
test("another + queues during a held write in Review first and totals refresh once", async ({ page }) => {
  await open(page)
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const requests: Array<typeof ConfirmPayload.Type> = []
  await page.route("**/api/rows/confirm", async (route) => {
    requests.push(Schema.decodeUnknownSync(ConfirmPayload)(route.request().postDataJSON()))
    if (requests.length === 1) await held
    await route.fulfill({
      json: {
        clockify: { _tag: "Written", seconds: 3600 },
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
  await page.getByRole("button", { name: "Quick approve PROJ-123 at 11:00–12:00 with 5-second Undo", exact: true })
    .click()
  await page.clock.runFor(6000)
  await expect.poll(() => requests.length).toBe(1)
  const nextCard = page.getByRole("button", { name: /PROJ-123, 14:00/ })
  await expect(nextCard).toBeEnabled()
  await nextCard.click()
  const editor = page.getByRole("complementary", { name: "Time entry editor" })
  await expect(editor).toBeVisible()
  const note = editor.getByRole("textbox", { name: "What was done (optional)", exact: true })
  await note.fill("Review remains editable while the earlier block saves")
  await expect(note).toHaveValue("Review remains editable while the earlier block saves")
  await page.keyboard.press("Escape")
  await expect(editor).toHaveCount(0)
  await expect(nextCard).toBeFocused()
  const next = page.getByRole("button", {
    name: "Quick approve PROJ-123 at 14:00–15:00 with 5-second Undo",
    exact: true
  })
  await expect(next).toBeEnabled()
  await next.click()
  const queue = page.getByRole("region", { name: "Approval queue" })
  await expect(queue.getByRole("listitem")).toHaveCount(2)
  await page.clock.runFor(6000)
  expect(requests).toHaveLength(1)
  expect(totals).toEqual([])
  release?.()
  await expect(queue).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  expect(requests).toHaveLength(2)
  expect(requests.map((request) => request.blocks)).toEqual([[0], [1]])
  expect(totals).toHaveLength(1)
})

// Overlapping fifteen-minute suggestions retain separate usable controls without covering another card.
test("fifteen-minute + controls stay inside non-overlapping calendar cards", async ({ page }) => {
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
              rowId: `overlapping-${index}`,
              ticketKey: `PROJ-${8000 + index}`,
              intervals: [],
              clockifySeconds: 0,
              jiraSeconds: 0,
              proposal: {
                ...row.proposal,
                maxSeconds: 900,
                clockifyDelta: 900,
                jiraDelta: 900,
                blocks: [{
                  startMs: start + index * 180000,
                  endMs: start + index * 180000 + 900000,
                  seconds: 900,
                  consumed: { clockify: 0, jira: 0 }
                }]
              }
            }))
          }
        })
      }\n`
    }))
  await open(page)
  const cards = page.locator(".jcf-block-actions")
  await expect(cards).toHaveCount(5)
  const bounds = await cards.evaluateAll((cards) =>
    cards.map((card) => {
      const rect = card.getBoundingClientRect()
      const plus = card.querySelector(".jcf-quick-approve")
      const action = plus?.getBoundingClientRect()
      const source = card.querySelector(".jcf-block-source")
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        keyWidth: card.querySelector(".jcf-block-key")?.getBoundingClientRect().width,
        sourceHidden: source !== null && getComputedStyle(source).display === "none",
        plus: action === undefined
          ? null
          : {
            left: action.left,
            right: action.right,
            top: action.top,
            bottom: action.bottom,
            width: action.width,
            height: action.height
          },
        nestedButton: plus?.parentElement?.closest("button") !== null
      }
    })
  )
  for (const [index, card] of bounds.entries()) {
    expect(card.keyWidth).toBeGreaterThan(0)
    expect(card.sourceHidden).toBe(true)
    expect(card.plus?.width).toBeGreaterThanOrEqual(24)
    expect(card.plus?.height).toBeGreaterThanOrEqual(24)
    expect(card.plus?.left).toBeGreaterThanOrEqual(card.left)
    expect(card.plus?.right).toBeLessThanOrEqual(card.right)
    expect(card.plus?.top).toBeGreaterThanOrEqual(card.top)
    expect(card.plus?.bottom).toBeLessThanOrEqual(card.bottom)
    expect(card.nestedButton).toBe(false)
    for (const other of bounds.slice(index + 1)) {
      const width = Math.min(card.right, other.right) - Math.max(card.left, other.left)
      const height = Math.min(card.bottom, other.bottom) - Math.max(card.top, other.top)
      expect(width > 0.5 && height > 0.5).toBe(false)
    }
  }
})
