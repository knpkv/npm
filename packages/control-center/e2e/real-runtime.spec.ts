import { expect } from "@playwright/test"

import { test } from "./realRuntimeFixture.js"
import {
  INITIAL_RELEASE_VERSION,
  REAL_RELEASE_ID,
  REAL_WORKSPACE_ID,
  UPDATED_RELEASE_VERSION
} from "./realRuntimeScenario.js"

test.describe("repository-managed real runtime", () => {
  test("pairs, reconnects its live stream, applies a plugin update, and preserves full release routes", async ({ page, realRuntime }) => {
    test.setTimeout(30_000)
    let eventStreamRequests = 0
    await page.route(`${realRuntime.origin}/api/v1/events**`, async (route) => {
      eventStreamRequests += 1
      if (eventStreamRequests === 1) {
        await route.abort("connectionrefused")
        return
      }
      await route.continue()
    })

    await page.goto(`${realRuntime.origin}/services`)
    await expect(page.getByRole("heading", { level: 1, name: "Services" })).toBeVisible()
    await expect(page.getByText("Health and configuration for every negotiated delivery plugin.")).toBeVisible()

    await realRuntime.pairThroughUi(page)
    await expect(page).toHaveURL(`${realRuntime.origin}/w/${REAL_WORKSPACE_ID}/overview`)
    await expect(page.getByRole("heading", { level: 1, name: "Every release. One view." })).toBeVisible()
    await expect(page.getByText(INITIAL_RELEASE_VERSION, { exact: true })).toBeVisible()
    await expect.poll(() => eventStreamRequests).toBeGreaterThanOrEqual(2)
    await expect(page.getByRole("status").getByText("Live", { exact: true })).toBeVisible()

    await realRuntime.synchronizeUpdate()
    await expect(page.getByText(UPDATED_RELEASE_VERSION, { exact: true })).toBeVisible()
    await expect(page.getByText(INITIAL_RELEASE_VERSION, { exact: true })).toHaveCount(0)

    await page.getByRole("link", { name: "Services" }).click()
    await expect(page).toHaveURL(`${realRuntime.origin}/services`)
    await expect(page.getByRole("heading", { level: 1, name: "Services" })).toBeVisible()
    await page.getByRole("link", { name: "Overview" }).click()
    await expect(page).toHaveURL(`${realRuntime.origin}/w/${REAL_WORKSPACE_ID}/overview`)

    await page.getByRole("button", { name: /^Preview /u }).click()
    await expect(page).toHaveURL(`${realRuntime.origin}/w/${REAL_WORKSPACE_ID}/releases/${REAL_RELEASE_ID}/preview`)
    const preview = page.getByRole("dialog")
    await expect(preview).toBeVisible()
    await expect(preview.getByText(UPDATED_RELEASE_VERSION, { exact: true })).toBeVisible()
    await preview.getByRole("button", { name: /^Open .+ full view$/u }).click()

    const fullReleaseUrl = `${realRuntime.origin}/w/${REAL_WORKSPACE_ID}/releases/${REAL_RELEASE_ID}`
    await expect(page).toHaveURL(fullReleaseUrl)
    await expect(page.getByRole("heading", { level: 1, name: "payments-api" })).toBeVisible()
    await expect(page.getByText(UPDATED_RELEASE_VERSION, { exact: true })).toBeVisible()
    for (let refresh = 0; refresh < 2; refresh += 1) {
      await page.reload()
      await expect(page).toHaveURL(fullReleaseUrl)
      await expect(page.getByRole("heading", { level: 1, name: "payments-api" })).toBeVisible()
      await expect(page.getByText(UPDATED_RELEASE_VERSION, { exact: true })).toBeVisible()
    }
  })
})
