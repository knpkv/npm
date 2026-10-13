import { expect } from "@playwright/test"

import { createConnection, expectFirstSync, portfolio, synchronize } from "./api.js"
import { captureState } from "./capture.js"
import { codeCommitInput } from "./connectionInputs.js"
import { fingerprint, jiraCredential } from "./fakeProviders/transport.js"
import { addJiraConnection, expectNoProviderSecrets, JIRA_TOKEN_A, JIRA_TOKEN_B } from "./jiraUi.js"
import { test } from "./visualRuntimeFixture.js"

test("P0-9 CodeCommit and Jira connection credentials and data stay isolated", async ({ page, visualRuntime }) => {
  await visualRuntime.pairThroughUi(page)
  for (const second of [false, true]) {
    const input = codeCommitInput(second)
    const created = await createConnection(page, visualRuntime.origin, input)
    expect(created.test._tag).toBe("healthy")
    await expectFirstSync(page, visualRuntime.origin, input.pluginConnectionId)
  }
  for (
    const { name, token } of [
      { name: "Fixture Jira A", token: JIRA_TOKEN_A },
      { name: "Fixture Jira B", token: JIRA_TOKEN_B }
    ]
  ) {
    await addJiraConnection(page, visualRuntime.origin, token, name)
    const card = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: `${name} · Jira`, level: 2, exact: true })
    })
    await expect(card.getByText(/^Synced\b/u)).toBeVisible()
  }
  const connections = (await portfolio(page, visualRuntime.origin)).plugins
  const jiraConnections = connections.filter((connection) => connection.providerId === "jira")
  expect(jiraConnections).toHaveLength(2)
  const before = await portfolio(page, visualRuntime.origin)
  expect(before.releases.map((release) => [release.serviceName, release.version]).sort()).toEqual([[
    "Fixture catalogue",
    "2.0.0"
  ], ["Fixture service", "1.0.0"]])
  for (const release of before.releases) expect(release.relationships.pullRequests).toBe(1)
  const expected = new Map([
    ["codecommit-a", fingerprint("FIXTUREA")],
    ["codecommit-b", fingerprint("FIXTUREB")],
    ["jira-a", fingerprint(jiraCredential(JIRA_TOKEN_A))],
    ["jira-b", fingerprint(jiraCredential(JIRA_TOKEN_B))]
  ])
  const requests = visualRuntime.providers.requests()
  expect(new Set(requests.map((request) => request.connectionLabel))).toEqual(new Set(expected.keys()))
  for (const request of requests) expect(request.authFingerprint).toBe(expected.get(request.connectionLabel))
  visualRuntime.providers.setScenario("codecommit", "FIXTUREA", "401")
  visualRuntime.providers.setScenario("jira", jiraCredential(JIRA_TOKEN_A), "401")
  const jiraA = jiraConnections.find((connection) => connection.displayName.includes("Jira A"))
  expect(jiraA).toBeDefined()
  if (jiraA === undefined) return
  expect((await synchronize(page, visualRuntime.origin, jiraA.pluginConnectionId)).failure?.failureClass).toBe(
    "authentication"
  )
  expect(
    (await synchronize(page, visualRuntime.origin, codeCommitInput(false).pluginConnectionId)).failure?.failureClass
  ).toBe("authentication")
  expect((await synchronize(page, visualRuntime.origin, codeCommitInput(true).pluginConnectionId)).result).toBe(
    "synchronized"
  )
  const after = await portfolio(page, visualRuntime.origin)
  expect(after.releases).toHaveLength(2)
  expect(after.releases.find((release) => release.serviceName === "Fixture catalogue")?.freshness._tag).toBe("current")
  expect(after.releases.find((release) => release.serviceName === "Fixture service")?.freshness._tag).toBe(
    "source-unavailable"
  )
  expect(after.plugins.find((connection) => connection.pluginConnectionId === jiraA.pluginConnectionId)?.health)
    .toMatchObject({ _tag: "unavailable", failureClass: "authentication" })
  expect(
    after.plugins.find((connection) => connection.pluginConnectionId === codeCommitInput(true).pluginConnectionId)
      ?.health?._tag
  )
    .toBe("healthy")
  for (const request of visualRuntime.providers.requests()) {
    expect(request.authFingerprint).toBe(expected.get(request.connectionLabel))
  }
  await page.goto(visualRuntime.origin)
  await expect(page.getByText("Fixture catalogue", { exact: true })).toBeVisible()
  await expectNoProviderSecrets(page, [JIRA_TOKEN_A, JIRA_TOKEN_B, "fixture-secret-invalid-for-aws"])
  await captureState(page, "connection-isolation", {
    evidence: page.getByText("Fixture catalogue", { exact: true }),
    landmark: page.getByRole("heading", { name: "Every release. One view." }),
    primaryAction: page.getByRole("navigation", { name: "Release filters" }).getByRole("link", { name: /^All\b/u }),
    exercise: async (action) => {
      await action.press("Enter")
    },
    expectOutcome: async () => {
      await expect(page.getByText("Fixture catalogue", { exact: true })).toBeVisible()
    }
  })
  const reads = visualRuntime.apiRequests().filter(({ method }) => method === "GET" || method === "HEAD")
  // The fixed clock prevents limiter refill; each scenario must fit one 120-read window with headroom.
  expect(reads.length, "P0-9 frozen-clock read budget: at most 80 requests, including setup")
    .toBeLessThanOrEqual(80)
})
