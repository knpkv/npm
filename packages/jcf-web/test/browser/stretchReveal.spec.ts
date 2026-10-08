import { expect, type Locator, test } from "@playwright/test"
import { Schema } from "effect"
import { fixtureWeek } from "../fixture.js"

/** Whether the stretch hides rows below its time-scaled height. */
const clipsRows = (stretch: Locator) => stretch.evaluate((element) => element.scrollHeight > element.clientHeight + 1)

// Four 5-minute suggestions back to back pack into one stretch clipped to 20 minutes. Touch has no
// hover, so its head is the explicit way to reach the tickets below the clip.
test("a packed stretch opens from its head and stays open without hover", async ({ page }) => {
  const plan = fixtureWeek()
  const row = plan.rows[0]!
  const start = new Date(`${plan.monday}T11:00:00`).getTime()
  const packed = {
    ...plan,
    rows: [0, 1, 2, 3].map((index) => ({
      ...row,
      rowId: `packed-${index}`,
      ticketKey: `PROJ-${200 + index}`,
      clockifySeconds: 0,
      jiraSeconds: 0,
      intervals: [],
      proposal: {
        ...row.proposal,
        maxSeconds: 300,
        clockifyDelta: 300,
        jiraDelta: 300,
        blocks: [{
          startMs: start + index * 300_000,
          endMs: start + (index + 1) * 300_000,
          seconds: 300,
          consumed: { clockify: 0, jira: 0 }
        }]
      }
    }))
  }
  await page.route("**/api/week/recorded?*", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({ _tag: "Complete", plan: packed })}\n`
    }))
  await page.setViewportSize({ width: 1280, height: 1000 })
  const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(
    await (await page.request.post("/__test/reset")).json()
  )
  await page.goto(setup.url)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()

  const stretch = page.getByRole("group", { name: /4 tickets packed in this stretch/ })
  const head = stretch.getByRole("button", { name: /4 tickets$/ })
  await expect(head).toHaveAttribute("aria-expanded", "false")
  await stretch.scrollIntoViewIfNeeded()
  expect(await clipsRows(stretch)).toBe(true)

  await head.click()
  await page.mouse.move(0, 0)
  await expect(head).toHaveAttribute("aria-expanded", "true")
  expect(await clipsRows(stretch)).toBe(false)
  // The last ticket now sits inside the stretch's box rather than below its clip.
  const last = await stretch.getByRole("button", { name: /^PROJ-203/ }).boundingBox()
  const box = await stretch.boundingBox()
  expect(last!.y + last!.height).toBeLessThanOrEqual(box!.y + box!.height)

  // The head toggles; with the pointer away and focus on the head, the stretch closes again.
  await head.click()
  await page.mouse.move(0, 0)
  await expect(head).toHaveAttribute("aria-expanded", "false")
  expect(await clipsRows(stretch)).toBe(true)
})
