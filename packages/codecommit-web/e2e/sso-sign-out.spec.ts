import { expect, test } from "@playwright/test"

// `aws sso logout` ends every SSO session on the machine, so signing out must state that scope and
// wait for confirmation; cancelling sends nothing.
test("asks before signing out of AWS SSO, and only confirming sends the request", async ({ page }) => {
  const logouts: Array<string> = []
  await page.route("**/api/session/current", (route) => route.fulfill({ status: 204 }))
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        accounts: [],
        autoDetect: false,
        autoRefresh: false,
        refreshIntervalSeconds: 300,
        review: { defaultProfileId: "synthetic", profiles: [] }
      }
    }))
  await page.route("**/api/subscriptions", (route) => route.fulfill({ json: [] }))
  await page.route("**/api/notifications/sso-logout", (route) => {
    logouts.push(route.request().method())
    return route.fulfill({ json: "ok" })
  })
  await page.route("**/api/events/", (route) =>
    route.fulfill({
      body: `data: ${
        JSON.stringify({ accounts: [], currentUser: "viewer", pullRequests: [], sandboxes: [], status: "idle" })
      }\n\n`,
      contentType: "text/event-stream"
    }))

  await page.goto("/settings/accounts")
  await page.getByRole("button", { name: "Sign out of AWS SSO on this machine" }).click()
  const dialog = page.getByRole("dialog", { name: "Sign out of AWS SSO on this machine?" })
  await expect(dialog).toContainText("signs out of AWS SSO for all profiles on this machine")
  // Cancel takes the initial focus, so Enter on open never signs out.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(dialog).toHaveCount(0)
  expect(logouts).toEqual([])

  await page.getByRole("button", { name: "Sign out of AWS SSO on this machine" }).click()
  await page.getByRole("button", { name: "Sign out of all SSO sessions" }).click()
  await expect.poll(() => logouts).toEqual(["POST"])
})
