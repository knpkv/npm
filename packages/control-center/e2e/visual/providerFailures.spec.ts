import { expect, type Page } from "@playwright/test"
import * as DateTime from "effect/DateTime"

import { checkConnection, createConnection, expectFirstSync, portfolio, synchronize } from "./api.js"
import { captureState } from "./capture.js"
import { confluenceInput, pipelineInput } from "./connectionInputs.js"
import { jiraCredential } from "./fakeProviders/transport.js"
import { addJiraConnection, JIRA_TOKEN_A } from "./jiraUi.js"
import { resourceTestAction } from "./serviceUi.js"
import { test, VISUAL_WORKSPACE_ID, type VisualRuntimeFixture } from "./visualRuntimeFixture.js"

/** Both failure surfaces start with the same retained healthy facts and real provider failures. */
const setupUnavailableSources = async (page: Page, visualRuntime: VisualRuntimeFixture): Promise<void> => {
  await visualRuntime.pairThroughUi(page)
  await addJiraConnection(page, visualRuntime.origin, JIRA_TOKEN_A, "Fixture Jira")
  const jira = (await portfolio(page, visualRuntime.origin)).plugins.find((connection) =>
    connection.providerId === "jira"
  )
  expect(jira).toBeDefined()
  if (jira === undefined) return
  await expectFirstSync(page, visualRuntime.origin, jira.pluginConnectionId)
  for (const input of [pipelineInput, confluenceInput]) {
    expect((await createConnection(page, visualRuntime.origin, input)).test._tag).toBe("healthy")
    await expectFirstSync(page, visualRuntime.origin, input.pluginConnectionId)
  }
  visualRuntime.providers.setScenario("codepipeline", "FIXTUREA", "503")
  visualRuntime.providers.setScenario("jira", jiraCredential(JIRA_TOKEN_A), "429")
  visualRuntime.providers.setScenario("confluence", jiraCredential("fixture-confluence-token"), "truncated")
  for (
    const [connectionId, failureClass] of [[pipelineInput.pluginConnectionId, "outage"], [
      jira.pluginConnectionId,
      "rate-limit"
    ], [confluenceInput.pluginConnectionId, "malformed-response"]] satisfies ReadonlyArray<readonly [string, string]>
  ) {
    const result = await checkConnection(page, visualRuntime.origin, connectionId)
    expect(result._tag).toBe("failed")
    if (result._tag !== "failed") continue
    expect(result.failureClass).toBe(failureClass)
    if (failureClass === "rate-limit") {
      expect(result.retryAt === null ? null : DateTime.formatIso(result.retryAt)).toBe("2026-07-14T12:02:00.000Z")
    }
    expect((await synchronize(page, visualRuntime.origin, connectionId)).failure?.failureClass).toBe(failureClass)
  }
  const snapshot = await portfolio(page, visualRuntime.origin)
  expect(snapshot.releases).toHaveLength(1)
  expect(snapshot.releases[0]?.freshness._tag).toBe("source-unavailable")
  expect(snapshot.releases[0]?.readiness?.verdict).not.toBe("ready")
}

test("P0-10 provider outage, Retry-After and malformed response preserve unavailable source facts", async ({ page, visualRuntime }) => {
  await setupUnavailableSources(page, visualRuntime)
  await page.goto(`${visualRuntime.origin}/services`)
  for (const name of ["fixture-pipeline", "Space · 40001"]) {
    await (await resourceTestAction(page, name)).click()
  }
  const jiraCard = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Fixture Jira · Jira", level: 2, exact: true })
  })
  await jiraCard.getByRole("button", { name: "Test connection", exact: true }).click()
  await expect(page.getByText("The provider is currently unavailable.", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("The provider rate limit has been reached.", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("The provider returned an unexpected identity response.", { exact: true }).first())
    .toBeVisible()
  for (
    const state of [
      {
        name: "codepipeline-outage",
        message: "The provider is currently unavailable.",
        action: await resourceTestAction(page, "fixture-pipeline")
      },
      {
        name: "jira-rate-limited",
        message: "The provider rate limit has been reached.",
        action: jiraCard.getByRole("button", { name: "Retry test", exact: true })
      },
      {
        name: "confluence-malformed",
        message: "The provider returned an unexpected identity response.",
        action: await resourceTestAction(page, "Space · 40001")
      }
    ]
  ) {
    const evidence = page.getByText(state.message, { exact: true }).first()
    await captureState(page, state.name, {
      evidence,
      landmark: page.getByRole("heading", { name: "Services", exact: true }),
      primaryAction: state.action,
      exercise: async (action) => {
        await action.press("Enter")
      },
      expectOutcome: async () => {
        await expect(evidence).toBeVisible()
      }
    })
  }
  const reads = visualRuntime.apiRequests().filter(({ method }) => method === "GET" || method === "HEAD")
  // The fixed clock prevents limiter refill; each scenario must fit one 120-read window with headroom.
  expect(reads.length, "P0-10a Services frozen-clock read budget: at most 100 requests, including setup")
    .toBeLessThanOrEqual(100)
})

test("P0-10 overview preserves unavailable source facts", async ({ page, visualRuntime }) => {
  await setupUnavailableSources(page, visualRuntime)
  await page.goto(visualRuntime.origin)
  await expect(page.getByText("Showing preserved source facts", { exact: true })).toBeVisible()
  await expect(page.getByText(/^Source unavailable since .*rate-limited, retry .*last read /u)).toBeVisible()
  await expect(page.getByText("Current", { exact: true })).toHaveCount(0)
  await captureState(page, "provider-failures-source-unavailable", {
    evidence: page.getByText(/^Source unavailable since .*rate-limited, retry .*last read /u),
    landmark: page.getByRole("heading", { name: "Every release. One view." }),
    primaryAction: page.getByRole("navigation", { name: "Release filters" }).getByRole("link", { name: /^All\b/u }),
    exercise: async (action) => {
      await action.press("Enter")
    },
    expectOutcome: async () => {
      await expect(page.getByText("Showing preserved source facts", { exact: true })).toBeVisible()
    }
  })
  const reads = visualRuntime.apiRequests().filter(({ method }) => method === "GET" || method === "HEAD")
  // The fixed clock prevents limiter refill; each scenario must fit one 120-read window with headroom.
  expect(reads.length, "P0-10b Overview frozen-clock read budget: at most 68 requests, including setup")
    .toBeLessThanOrEqual(68)
})

test("P0-10 omitted Confluence body is a truthful unsynchronized-task gap", async ({ page, visualRuntime }) => {
  await visualRuntime.pairThroughUi(page)
  await addJiraConnection(page, visualRuntime.origin, JIRA_TOKEN_A, "Fixture Jira")
  const jira = (await portfolio(page, visualRuntime.origin)).plugins.find((connection) =>
    connection.providerId === "jira"
  )
  expect(jira).toBeDefined()
  if (jira === undefined) return
  await expectFirstSync(page, visualRuntime.origin, jira.pluginConnectionId)
  visualRuntime.providers.omitConfluenceBody("confluence-a")
  expect((await createConnection(page, visualRuntime.origin, confluenceInput)).test._tag).toBe("healthy")
  await expectFirstSync(page, visualRuntime.origin, confluenceInput.pluginConnectionId)
  const snapshot = await portfolio(page, visualRuntime.origin)
  expect(snapshot.releases).toHaveLength(1)
  expect(snapshot.releases[0]?.readiness?.verdict).not.toBe("ready")
  const release = snapshot.releases[0]
  expect(release).toBeDefined()
  if (release === undefined) return
  const path = `${visualRuntime.origin}/w/${VISUAL_WORKSPACE_ID}/releases/${release.releaseId}`
  await page.goto(path)
  const gap = page.getByText("Fixture release 1.0.0 checklist tasks are not synchronized", { exact: true })
  await expect(gap).toBeVisible()
  await captureState(page, "confluence-partial-workset", {
    evidence: gap,
    landmark: page.getByRole("heading", { name: "Fixture service", exact: true }),
    primaryAction: page.getByRole("link", { name: /Back to overview|Return to overview/u }).first(),
    exercise: async (action) => {
      await action.press("Enter")
    },
    expectOutcome: async () => {
      await expect(page.getByRole("heading", { name: "Every release. One view." })).toBeVisible()
      await page.goto(path)
      await expect(gap).toBeVisible()
    }
  })
})
