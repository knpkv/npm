import { expect, test } from "@playwright/test"
import { Schema } from "effect"
import { fixtureWeek } from "../fixture.js"

// Restored evidence can predate the minimum. Filter suggestions immediately while preserving saved seconds.
test("restored plans hide sub-quarter-hour suggestions and tiny selected-provider remainders", async ({ page }) => {
  const plan = fixtureWeek()
  const row = plan.rows[0]!
  const start = new Date(`${plan.monday}T11:00:00`).getTime()
  const updated = {
    ...plan,
    rows: [16, 899, 900].map((seconds, index) => ({
      ...row,
      rowId: `minimum-${index}`,
      ticketKey: `PROJ-${100 + index}`,
      jiraSeconds: 16,
      clockifySeconds: 0,
      intervals: [{
        source: "jira",
        startMs: start - 3600000 + index * 60000,
        endMs: start - 3600000 + index * 60000 + 16000
      }],
      proposal: {
        ...row.proposal,
        maxSeconds: seconds,
        clockifyDelta: seconds,
        jiraDelta: 16,
        blocks: [{
          startMs: start + index * 3600000,
          endMs: start + index * 3600000 + seconds * 1000,
          seconds,
          consumed: { clockify: 0, jira: 0 }
        }]
      }
    }))
  }
  await page.route("**/api/week/recorded?*", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: `${JSON.stringify({ _tag: "Complete", plan: updated })}\n`
    }))
  const setup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(
    await (await page.request.post("/__test/reset")).json()
  )
  await page.goto(setup.url)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  await expect(page.locator(".jcf-block-gap")).toHaveCount(1)
  await expect(page.locator(".jcf-block-gap")).toContainText("PROJ-102")
  await expect(page.locator(".jcf-block-logged[data-source=\"jira\"]")).toHaveCount(3)
  await expect(page.getByLabel("Jira totals")).toContainText("48s saved")
  await page.getByRole("button", { name: "Clockify entries", exact: true }).click()
  await expect(page.locator(".jcf-block-gap")).toHaveCount(0)
  await page.getByRole("button", { name: "Clockify entries", exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator(".jcf-agenda-entry[data-kind=\"proposable\"]")).toHaveCount(1)
  await expect(page.locator(".jcf-agenda-entry[data-kind=\"proposable\"]")).toContainText("15m 0s suggested")
})
