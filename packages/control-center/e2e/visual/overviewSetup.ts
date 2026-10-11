import { expect, type Page } from "@playwright/test"

import type { CreatePluginConnectionRequest } from "../../src/api/plugins.js"
import {
  type AuthenticatedVisualApi,
  configureReleaseTargets,
  createConnection,
  expectFirstSync,
  portfolio
} from "./api.js"
import { codeCommitInput, confluenceInput, pipelineInput } from "./connectionInputs.js"
import type { VisualRuntimeFixture } from "./visualRuntimeFixture.js"

/** Only connection configuration is administrative setup; delivery evidence enters through real plugins. */
export const setupSixVerdicts = async (page: Page | AuthenticatedVisualApi, runtime: VisualRuntimeFixture) => {
  runtime.providers.useReadinessPortfolio()
  const overviewPipeline = {
    ...pipelineInput,
    values: pipelineInput.values.map((field) =>
      field.key === "maximumExecutionPages" && field._tag === "integer" ? { ...field, value: 6 } : field
    )
  }
  for (
    const input of [codeCommitInput(false), overviewPipeline, confluenceInput, {
      pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000206",
      providerId: "jira",
      displayName: "Fixture Jira",
      values: [
        { _tag: "url", key: "webBaseUrl", value: "https://fixture.atlassian.net/" },
        { _tag: "text", key: "siteId", value: "fixture-site" },
        { _tag: "text", key: "projectId", value: "10001" },
        { _tag: "text", key: "email", value: "owner@example.com" },
        { _tag: "secret", key: "apiToken", value: "fixture-jira-token-a" }
      ]
    }] satisfies ReadonlyArray<typeof CreatePluginConnectionRequest.Encoded>
  ) {
    expect((await createConnection(page, runtime.origin, input)).test._tag).toBe("healthy")
    await expectFirstSync(page, runtime.origin, input.pluginConnectionId)
  }
  await configureReleaseTargets(page, runtime.origin)
  await expect.poll(async () =>
    (await portfolio(page, runtime.origin)).releases.map((release) => ({
      version: release.version,
      authority: release.readiness?.authority,
      verdict: release.readiness?.verdict
    })).sort((left, right) => left.version.localeCompare(right.version))
  ).toEqual([
    { version: "1.0.1", authority: "authoritative", verdict: "blocked" },
    { version: "1.0.2", authority: "authoritative", verdict: "ready" },
    { version: "1.0.3", authority: "authoritative", verdict: "deploying" },
    { version: "1.0.4", authority: "authoritative", verdict: "building" },
    { version: "1.0.5", authority: "authoritative", verdict: "shipped" },
    { version: "1.0.6", authority: "authoritative", verdict: "held" }
  ])
  return await portfolio(page, runtime.origin)
}
