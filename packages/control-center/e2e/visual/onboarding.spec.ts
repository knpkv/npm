import { expect } from "@playwright/test"
import * as Schema from "effect/Schema"

import { PortfolioSnapshot } from "../../src/api/portfolio.js"
import { captureState } from "./capture.js"
import { addJiraConnection, expectNoProviderSecrets, JIRA_TOKEN_A } from "./jiraUi.js"
import { connectionCard } from "./serviceUi.js"
import { test } from "./visualRuntimeFixture.js"

test("P0-1 first run pairs, connects Jira, and reads the first portfolio", async ({ page, visualRuntime }) => {
  await page.goto(visualRuntime.origin)
  const privateState = page.getByText("Release facts stay private", { exact: true })
  await expect(privateState).toBeVisible()
  await captureState(page, "first-run", {
    evidence: privateState,
    landmark: privateState,
    primaryAction: page.getByRole("link", { name: "Pair this browser", exact: true }).last(),
    exercise: async (action) => {
      await action.press("Enter")
    },
    expectOutcome: async () => {
      await expect(page.getByRole("heading", { name: "Pair this browser" })).toBeVisible()
      await page.goto(visualRuntime.origin)
      await expect(privateState).toBeVisible()
    }
  })
  await page.goto(`${visualRuntime.origin}/pair`)
  await expect(page.getByRole("button", { name: "Pair browser", exact: true })).toBeDisabled()
  await captureState(page, "pairing", {
    evidence: page.getByRole("heading", { name: "Pair this browser" }),
    landmark: page.getByRole("heading", { name: "Pair this browser" }),
    primaryAction: page.getByRole("textbox", { name: /^Pairing code/u }),
    exercise: async (action) => {
      await action.press("Tab")
    },
    expectOutcome: async () => {
      await expect(page.getByRole("button", { name: "Pair browser", exact: true })).toBeDisabled()
    }
  })
  await visualRuntime.pairThroughUi(page)
  await addJiraConnection(page, visualRuntime.origin, JIRA_TOKEN_A, "Fixture Jira")
  await expect(page.getByText("Connection healthy", { exact: true }).first()).toBeVisible()
  await expectNoProviderSecrets(page, [JIRA_TOKEN_A])
  await captureState(page, "jira-healthy", {
    evidence: page.getByText("Connection healthy", { exact: true }).first(),
    landmark: page.getByRole("heading", { name: "Services", exact: true }),
    primaryAction: page.getByRole("button", { name: "Retry test", exact: true }).first(),
    exercise: async (action) => {
      await action.press("Enter")
    },
    expectOutcome: async () => {
      await expect(page.getByText("Connection healthy", { exact: true }).first()).toBeVisible()
    }
  })
  await expect(connectionCard(page, "Fixture Jira · Jira").getByText(/^Synced\b/u)).toBeVisible()
  const response = await page.request.get(`${visualRuntime.origin}/api/v1/portfolio/snapshot`)
  expect(response.ok()).toBe(true)
  const snapshot = Schema.decodeUnknownSync(PortfolioSnapshot)(await response.json())
  expect(snapshot.plugins).toHaveLength(1)
  expect(snapshot.releases).toHaveLength(1)
  expect(snapshot.plugins[0]?.health?._tag).toBe("healthy")
  expect(snapshot.releases[0]?.targetConfiguration).toMatchObject({
    verdict: "held",
    reason: "no-target-environment"
  })
  expect(snapshot.releases.every((release) => release.readiness === null || release.readiness.authority === "pending"))
    .toBe(true)
  await page.goto(visualRuntime.origin)
  await expect(page.getByRole("heading", { name: "Every release. One view." })).toBeVisible()
  const targetless = page.getByRole("heading", { name: "No target environment", exact: true })
  await expect(targetless).toBeVisible()
  await expect(page.getByText("Choose a target environment in Settings.", { exact: true })).toBeVisible()
  await expectNoProviderSecrets(page, [JIRA_TOKEN_A])
  await captureState(page, "first-portfolio", {
    evidence: targetless,
    landmark: page.getByRole("heading", { name: "Every release. One view." }),
    primaryAction: page.getByRole("navigation", { name: "Release filters" }).getByRole("link", { name: /^All\b/u }),
    exercise: async (action) => {
      await action.press("Enter")
    },
    expectOutcome: async () => {
      await expect(page.getByRole("heading", { name: "Every release. One view." })).toBeVisible()
    }
  })
})
