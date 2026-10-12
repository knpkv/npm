import { expect } from "@playwright/test"
import * as DateTime from "effect/DateTime"

import { portfolio } from "./api.js"
import { captureState } from "./capture.js"
import { jiraCredential } from "./fakeProviders/transport.js"
import { addJiraConnection, expectNoProviderSecrets, JIRA_TOKEN_A } from "./jiraUi.js"
import { connectionCard } from "./serviceUi.js"
import { test } from "./visualRuntimeFixture.js"

test("P0-2 rejected credentials differ from availability and revoked sync keeps source facts", async ({ page, visualRuntime }) => {
  await visualRuntime.pairThroughUi(page)
  visualRuntime.providers.setScenario("jira", jiraCredential(JIRA_TOKEN_A), "401")
  await addJiraConnection(page, visualRuntime.origin, JIRA_TOKEN_A, "Fixture Jira")
  await expect(page.getByText("The provider rejected these credentials.", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("The provider is currently unavailable.", { exact: true })).toHaveCount(0)
  await captureState(page, "jira-credential-rejected", {
    evidence: page.getByText("The provider rejected these credentials.", { exact: true }).first(),
    landmark: page.getByRole("heading", { name: "Services", exact: true }),
    primaryAction: page.getByRole("button", { name: "Retry test", exact: true }).first(),
    exercise: async (action) => {
      await action.press("Enter")
    },
    expectOutcome: async () => {
      await expect(page.getByText("The provider rejected these credentials.", { exact: true }).first()).toBeVisible()
    }
  })
  visualRuntime.providers.setScenario("jira", jiraCredential(JIRA_TOKEN_A), "healthy")
  await page.getByRole("button", { name: "Retry test", exact: true }).first().click()
  await expect(page.getByText("Connection healthy", { exact: true }).first()).toBeVisible()
  const jiraCard = connectionCard(page, "Fixture Jira · Jira")
  const syncAction = jiraCard.getByRole("button", { name: "Sync now", exact: true })
  // The action row's parent owns the sync details; the card header repeats the same status text.
  const syncDetails = syncAction.locator("..").locator("..")
  await expect(syncDetails).toHaveCount(1)
  await syncAction.click()
  await expect(syncDetails.getByText(/^Synced\b/u)).toBeVisible()
  const before = await portfolio(page, visualRuntime.origin)
  expect(before.releases).toHaveLength(1)
  visualRuntime.providers.setScenario("jira", jiraCredential(JIRA_TOKEN_A), "401")
  await syncAction.click()
  await expect(syncDetails.getByText("Sync failed", { exact: true })).toBeVisible()
  const after = await portfolio(page, visualRuntime.origin)
  expect(after.releases.map(({ freshness: _freshness, ...facts }) => facts))
    .toEqual(before.releases.map(({ freshness: _freshness, ...facts }) => facts))
  expect(after.releases[0]?.freshness._tag).toBe("source-unavailable")
  expect(after.releases[0]?.freshness.sourceObservedAt).toEqual(before.releases[0]?.freshness.sourceObservedAt)
  expect(after.releases[0]?.freshness.synchronizedAt).toEqual(before.releases[0]?.freshness.synchronizedAt)
  expect(after.plugins[0]?.health).toMatchObject({ _tag: "unavailable", failureClass: "authentication" })
  expect(after.releases[0]?.readiness?.verdict).not.toBe("ready")
  await page.goto(visualRuntime.origin)
  await expect(page.getByText("Showing preserved source facts", { exact: true })).toBeVisible()
  await expect(page.getByText(/^Source unavailable since .* · authentication · last read /u)).toBeVisible()
  await expect(page.getByText("Current", { exact: true })).toHaveCount(0)
  await expect(page.getByText("1.0.0", { exact: true }).first()).toBeVisible()
  await expect(page.locator("time").first()).toBeVisible()
  await expectNoProviderSecrets(page, [JIRA_TOKEN_A])
  await captureState(page, "jira-revoked-preserved", {
    evidence: page.getByText(/^Source unavailable since .* · authentication · last read /u),
    landmark: page.getByRole("heading", { name: "Every release. One view." }),
    primaryAction: page.getByRole("navigation", { name: "Release filters" }).getByRole("link", { name: /^All\b/u }),
    exercise: async (action) => {
      await action.press("Enter")
    },
    expectOutcome: async () => {
      await expect(page.getByText("Showing preserved source facts", { exact: true })).toBeVisible()
    }
  })
  // Stay active between advances: the real session has a 12-hour idle expiry.
  for (const hours of [11, 11, 3]) {
    const time = visualRuntime.advanceClockBy(hours * 3_600_000)
    await page.clock.setFixedTime(new Date(time))
    await portfolio(page, visualRuntime.origin)
  }
  // A healthy check clears the failure streak without reading fresh release data.
  visualRuntime.providers.setScenario("jira", jiraCredential(JIRA_TOKEN_A), "healthy")
  await page.goto(`${visualRuntime.origin}/services`)
  await page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Fixture Jira · Jira", level: 2, exact: true })
  }).getByRole("button", { name: "Test connection", exact: true }).click()
  await expect(page.getByText("Connection healthy", { exact: true }).first()).toBeVisible()
  const aged = await portfolio(page, visualRuntime.origin)
  const stale = aged.releases[0]
  const original = before.releases[0]
  expect(stale?.freshness._tag).toBe("stale")
  expect(stale?.updatedAt).toEqual(original?.updatedAt)
  expect(stale?.freshness.sourceObservedAt).toEqual(original?.freshness.sourceObservedAt)
  expect(stale?.freshness.synchronizedAt).toEqual(original?.freshness.synchronizedAt)
  expect(stale?.readiness?.verdict).not.toBe("ready")
  await page.goto(visualRuntime.origin)
  const staleStamp = page.getByText(/^Stale,\s*14 Jul, 12:00 UTC$/u).first()
  await expect(staleStamp).toBeVisible()
  if (original?.freshness.sourceObservedAt === null || original?.freshness.sourceObservedAt === undefined) return
  await expect(page.locator(`time[datetime="${DateTime.formatIso(original.freshness.sourceObservedAt)}"]`).first())
    .toBeVisible()
  await captureState(page, "jira-revoked-aged-stale", {
    evidence: staleStamp,
    landmark: page.getByRole("heading", { name: "Every release. One view." }),
    primaryAction: page.getByRole("navigation", { name: "Release filters" }).getByRole("link", { name: /^All\b/u }),
    exercise: async (action) => {
      await action.press("Enter")
    },
    expectOutcome: async () => {
      await expect(staleStamp).toBeVisible()
    }
  })
})
