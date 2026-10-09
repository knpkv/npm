import { expect, test } from "@playwright/test"
import { Schema } from "effect"
import { fixtureWeek } from "../fixture.js"

// A ticket key wider than its calendar block must shrink to the block and end in "…". The block clips its
// content, so a key that keeps its full width is cut off mid-character instead (overflow: clip gives a
// flex item no automatic zero minimum, unlike hidden).
test("a long ticket key shrinks to its block instead of running under the clip", async ({ page }) => {
  const plan = fixtureWeek()
  const row = plan.rows[0]!
  const long = { ...plan, rows: [{ ...row, ticketKey: "PLATFORMENGINEERING-123456" }] }
  await page.route("**/api/week/recorded?*", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({ _tag: "Complete", plan: long })}\n`
    }))
  await page.setViewportSize({ width: 1024, height: 1000 })
  const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(
    await (await page.request.post("/__test/reset")).json()
  )
  await page.goto(setup.url)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  const keys = page.locator(".jcf-block .jcf-block-key", { hasText: "PLATFORMENGINEERING" })
  await expect(keys.first()).toBeVisible()
  const overruns = await keys.evaluateAll((spans) =>
    spans.flatMap((key) => {
      const block = key.closest(".jcf-block")
      if (block === null) return ["no block"]
      const overrun = key.getBoundingClientRect().right - block.getBoundingClientRect().right
      return overrun > 0.5 ? [`${String(Math.round(overrun))}px past the block`] : []
    })
  )
  expect(await keys.count()).toBeGreaterThan(0)
  expect(overruns).toEqual([])
})
