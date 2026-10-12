import { expect } from "@playwright/test"

import { createConnection, expectFirstSync, portfolio } from "./api.js"
import { clockifyInput, codeCommitInput, confluenceInput, pipelineInput } from "./connectionInputs.js"
import { addJiraConnection, JIRA_TOKEN_A } from "./jiraUi.js"
import { test } from "./visualRuntimeFixture.js"

test("all five first-party plugins decode and synchronize fake provider transports", async ({ page, visualRuntime }) => {
  await visualRuntime.pairThroughUi(page)
  await addJiraConnection(page, visualRuntime.origin, JIRA_TOKEN_A, "Fixture Jira")
  const jira = (await portfolio(page, visualRuntime.origin)).plugins[0]
  expect(jira?.providerId).toBe("jira")
  if (jira === undefined) return
  await expectFirstSync(page, visualRuntime.origin, jira.pluginConnectionId)
  for (const input of [codeCommitInput(false), confluenceInput, pipelineInput, clockifyInput]) {
    expect((await createConnection(page, visualRuntime.origin, input)).test._tag).toBe("healthy")
    await expectFirstSync(page, visualRuntime.origin, input.pluginConnectionId)
  }
  expect(new Set(visualRuntime.providers.requests().map((request) => request.provider))).toEqual(
    new Set(["jira", "confluence", "clockify", "codecommit", "codepipeline"])
  )
  expect(visualRuntime.providers.unhandled()).toEqual([])
})
