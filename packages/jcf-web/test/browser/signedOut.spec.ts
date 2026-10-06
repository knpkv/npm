import { expect, test } from "@playwright/test"
import { Schema } from "effect"

// QA-J16: without a valid link the whole app rendered, with zeros, enabled controls and three red
// "Missing or invalid owner session" panels. Now it is one screen naming the command.
test("a tab without a session shows one screen that names jcf web login", async ({ page }) => {
  await page.request.post("/__test/reset")
  await page.goto("/")
  await expect(page.getByText("This tab is not signed in")).toBeVisible()
  await expect(page.getByText("jcf web login", { exact: true })).toBeVisible()
  await expect(page.getByRole("button")).toHaveCount(0)
  await expect(page.getByText(/saved|Missing or invalid owner session/u)).toHaveCount(0)
})

// A link pasted into a signed-out tab changes only the fragment; the tab must still sign in with it.
test("a link pasted into the signed-out tab signs it in", async ({ page }) => {
  const response = await page.request.post("/__test/reset")
  const { url } = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json())
  await page.goto("/")
  await expect(page.getByText("This tab is not signed in")).toBeVisible()
  await page.evaluate((hash) => {
    window.location.hash = hash
  }, new URL(url).hash)
  await expect(page.getByRole("heading", { name: "7–13 September 2026" })).toBeVisible()
})

// QA-J19: Jira not logged in read as "Jira 0s saved" with a "Jira entries 0" layer.
test("a week without Jira says Jira is not connected and names the command", async ({ page }) => {
  const response = await page.request.post("/__test/reset?jira=off")
  const { url } = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json())
  await page.goto(url)
  await expect(page.getByRole("heading", { name: "7–13 September 2026" })).toBeVisible()
  const jira = page.getByRole("group", { name: "Jira totals" })
  await expect(jira).toContainText("Not connected. Run jcf auth jira token")
  await expect(jira).not.toContainText("saved")
  await expect(page.getByRole("button", { name: /^Jira entries/u })).toHaveCount(0)
  await expect(page.getByRole("group", { name: "Clockify totals" })).toContainText("saved")
})
