import { expect, test } from "@playwright/test"
import { Schema } from "effect"

const decodeSetup = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))
const decodeObservations = Schema.decodeUnknownSync(Schema.Struct({
  clockifyWrites: Schema.Number,
  jiraWrites: Schema.Number,
  transcriptReads: Schema.Number
}))

// Real application, owner authentication, provider reads and manual writes. No route response stubs.
test("first load without a scan shows saved time and permits manual logging without reading sessions", async ({ page }) => {
  await page.context().addInitScript(() => window.localStorage.setItem("jcf_web_week", "2026-09-07"))
  const reset = await page.request.post("/__test/reset?seed=false")
  expect(reset.ok()).toBe(true)
  const setup = decodeSetup(await reset.json())
  expect(decodeObservations(await (await page.request.get("/__test/observations")).json())).toEqual({
    clockifyWrites: 0,
    jiraWrites: 0,
    transcriptReads: 0
  })
  const weekReads: Array<string> = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith("/api/week/")) weekReads.push(path)
  })
  await page.goto(setup.url)
  await expect(page.getByRole("heading", { name: "7–13 September 2026" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  await expect(page.getByText("No session suggestions for this week", { exact: true })).toBeVisible()
  await expect(page.getByLabel("Clockify totals")).toContainText("1h 0m saved")
  await expect(page.getByLabel("Jira totals")).toContainText("1h 0m saved")
  await expect(page.locator(".jcf-block-gap")).toHaveCount(0)
  expect(weekReads).toContain("/api/week/recorded-only")
  expect(weekReads).not.toContain("/api/week/stream")
  expect(decodeObservations(await (await page.request.get("/__test/observations")).json()).transcriptReads).toBe(0)

  await page.getByRole("button", { name: "Log time", exact: true }).first().click()
  const editor = page.getByRole("complementary", { name: "Time entry editor" })
  await editor.getByRole("textbox", { name: "Issue key", exact: true }).fill("PROJ-123")
  await editor.getByRole("textbox", { name: "Amount", exact: true }).fill("15m")
  await editor.getByLabel("Day", { exact: true }).selectOption("2026-09-07")
  const written = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/rows/manual")
  await editor.getByRole("button", { name: "Log time", exact: true }).click()
  expect((await written).status()).toBe(200)
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  await expect(page.getByLabel("Clockify totals")).toContainText("1h 15m saved")
  await expect(page.getByLabel("Jira totals")).toContainText("1h 15m saved")
  await expect(page.getByText("No session suggestions for this week", { exact: true })).toBeVisible()
  expect(weekReads).toContain("/api/week/recorded")

  const saved = await page.request.get("/api/week/saved?monday=2026-09-07&only=both")
  expect(saved.status()).toBe(200)
  expect(await saved.json()).toMatchObject({
    plan: { sessionScanAvailable: false, rows: [{ ticketKey: "PROJ-123", clockifySeconds: 4500, jiraSeconds: 4500 }] }
  })
  await page.reload()
  await expect(page.getByRole("button", { name: "Refresh totals", exact: true })).toBeEnabled()
  await expect(page.getByLabel("Clockify totals")).toContainText("1h 15m saved")
  await expect(page.getByText("No session suggestions for this week", { exact: true })).toBeVisible()
  expect(decodeObservations(await (await page.request.get("/__test/observations")).json())).toEqual({
    clockifyWrites: 1,
    jiraWrites: 1,
    transcriptReads: 0
  })
  expect(weekReads).not.toContain("/api/week/stream")
  expect(weekReads).not.toContain("/api/week/")
})
