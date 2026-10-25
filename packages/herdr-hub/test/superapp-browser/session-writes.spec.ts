/**
 * A session's writes from the real pages: logged in through the gate, the dashboard's approval and the
 * standalone Connect page's stage heartbeat reach the real hub with the session's CSRF token and are
 * accepted. The other superapp specs mock the server, so only these would see the pages' writes refused at
 * the front door.
 */
import { expect } from "@playwright/test"
import { test } from "./real-hub-fixture.js"

test.use({ ignoreHTTPSErrors: true })

test("logs in through the gate and approves a job, with the session's CSRF token", async ({ hub, page }) => {
  // The request's own page, which serves the login gate until the browser logs in.
  await page.goto(`${hub.origin}/?approvalHost=atlas&approvalJob=${hub.jobId}#fleet/approvals`)
  await page.getByRole("button", { name: "Log in with Tailscale" }).click()
  // Logged in, the gate reloads into the hub at the same address.
  await expect(page.locator("#fleet-dashboard-root:not([data-login-gate])")).toBeAttached({ timeout: 10_000 })
  const approve = page.getByRole("button", { name: /^Approve: / })
  await expect(approve).toBeVisible({ timeout: 10_000 })
  const answered = page.waitForResponse((response) =>
    response.url() === `${hub.origin}/v1/jobs/${hub.jobId}/approve` && response.request().method() === "POST"
  )
  await approve.click()
  const response = await answered
  expect(response.request().headers()["x-herdr-csrf"]).toMatch(/^[0-9a-f]{64}$/u)
  expect(response.status(), await response.text()).toBe(200)
})

// /connect/ mounts no session hook: its first write reads the session itself. (Muting needs a live push
// subscription on the device, so the heartbeat stands in for its writes.)
test("sends the session's CSRF token from /connect/, which has no session hook", async ({ hub, page }) => {
  await page.goto(`${hub.origin}/`)
  await page.getByRole("button", { name: "Log in with Tailscale" }).click()
  await expect(page.locator("#fleet-dashboard-root:not([data-login-gate])")).toBeAttached({ timeout: 10_000 })
  await page.goto(`${hub.origin}/connect/`)
  const answered = page.waitForResponse((response) =>
    response.url() === `${hub.origin}/v1/push/stage-heartbeat` && response.request().method() === "POST"
  )
  await page.locator(".connect-agent").first().click()
  const response = await answered
  expect(response.request().headers()["x-herdr-csrf"]).toMatch(/^[0-9a-f]{64}$/u)
  expect(response.status(), await response.text()).toBe(200)
})
