import { expect } from "@playwright/test"

import { expectFirstSync, portfolio } from "./api.js"
import { addJiraConnection, JIRA_TOKEN_B } from "./jiraUi.js"
import { connectionCard } from "./serviceUi.js"
import { test } from "./visualRuntimeFixture.js"

test("real first-party runtime pairs a browser", async ({ page, visualRuntime }, testInfo) => {
  await page.goto(visualRuntime.origin)
  await expect(page.getByText("Release facts stay private", { exact: true })).toBeVisible()
  await visualRuntime.pairThroughUi(page)
  await expect(page.getByRole("heading", { name: "Every release. One view." })).toBeVisible()
  await expect(page.getByText("Browser not paired", { exact: true })).toHaveCount(0)
  await page.goto(`${visualRuntime.origin}/services?enable=jira&atlassianProvider=jira`)
  await page.getByRole("button", { name: "Use API token instead" }).click()
  await page.getByLabel(/^Account name/u).fill("Fixture Jira")
  await page.getByLabel(/^Atlassian email/u).fill("owner@example.com")
  await page.getByLabel(/^API token/u).fill("fixture-jira-token-a")
  await page.getByLabel(/^Atlassian site URL/u).fill("https://fixture.atlassian.net")
  await page.getByLabel(/^Site ID/u).fill("fixture-site")
  await page.getByLabel(/^Jira project ID/u).fill("10001")
  await page.getByRole("button", { name: "Connect Atlassian" }).click()
  await expect(page.getByText("Healthy", { exact: true }).first()).toBeVisible()
  await expect(connectionCard(page, "Fixture Jira · Jira").getByText(/^Synced\b/u)).toBeVisible()
  expect(visualRuntime.providers.requests().some((request) => request.path === "/rest/api/3/search/jql")).toBe(true)
  const order = await page.locator("main h2, main h3").allTextContents()
  expect(order).toEqual(["CodeCommit", "CodePipeline", "Fixture Jira · Jira", "Jira", "Confluence", "Clockify"])
  await addJiraConnection(page, visualRuntime.origin, JIRA_TOKEN_B, "Fixture Jira B")
  const connections = (await portfolio(page, visualRuntime.origin)).plugins
  for (const connection of connections) {
    await expectFirstSync(page, visualRuntime.origin, connection.pluginConnectionId)
  }
  const services = await page.locator("main h2, main h3").allTextContents()
  const snapshot = await portfolio(page, visualRuntime.origin)
  expect(snapshot.releases).toHaveLength(2)
  await page.goto(visualRuntime.origin)
  await expect(page.getByText("Fixture catalogue", { exact: true })).toBeVisible()
  await testInfo.attach("service-order", {
    body: JSON.stringify({
      services,
      connections: snapshot.plugins.map(({ displayName, providerId }) => ({ providerId, displayName })),
      releases: snapshot.releases.map(({ serviceName, version }) => ({ serviceName, version })),
      visibleReleases: await page.locator("[data-portfolio-release-id]").allTextContents()
    }),
    contentType: "application/json"
  })
})
