import { type APIRequestContext, expect, type Page, test } from "@playwright/test"
import * as Schema from "effect/Schema"

import {
  CreatePluginConnectionRequest,
  CreatePluginConnectionResponse,
  PluginConnectionTestResult,
  PluginSynchronizationState
} from "../../src/api/plugins.js"
import { PortfolioSnapshot } from "../../src/api/portfolio.js"
import { CsrfToken } from "../../src/api/session.js"
import { UpdateWorkspaceSettingsRequest, WorkspaceSettingsReadModel } from "../../src/api/workspaceSettings.js"
import { ReleaseTargetCatalog } from "../../src/domain/releaseTargets.js"

export interface AuthenticatedVisualApi {
  readonly request: APIRequestContext
  readonly csrfToken: CsrfToken
}

const csrfToken = async (client: Page | AuthenticatedVisualApi) =>
  "csrfToken" in client
    ? client.csrfToken
    : Schema.decodeUnknownSync(CsrfToken)(await client.evaluate("sessionStorage.getItem('cc_csrf')"))

/** API setup still passes through the real owner mutation, secret store, plugin health and discovery boundary. */
export const createConnection = async (
  page: Page | AuthenticatedVisualApi,
  origin: string,
  input: typeof CreatePluginConnectionRequest.Encoded
) => {
  const csrf = await csrfToken(page)
  const response = await page.request.post(`${origin}/api/v1/plugins/connections`, {
    headers: { origin, "x-csrf-token": csrf },
    data: Schema.decodeUnknownSync(CreatePluginConnectionRequest)(input)
  })
  expect(response.ok(), await response.text()).toBe(true)
  const created = Schema.decodeUnknownSync(CreatePluginConnectionResponse)(await response.json())
  await test.info().attach(`${input.providerId}-connection-health`, {
    body: JSON.stringify(Schema.encodeSync(PluginConnectionTestResult)(created.test), null, 2),
    contentType: "application/json"
  })
  return created
}

export const portfolio = async (page: Pick<Page, "request">, origin: string) => {
  const response = await page.request.get(`${origin}/api/v1/portfolio/snapshot`)
  expect(response.ok()).toBe(true)
  return Schema.decodeUnknownSync(PortfolioSnapshot)(await response.json())
}

export const synchronize = async (page: Page | AuthenticatedVisualApi, origin: string, connectionId: string) => {
  const csrf = await csrfToken(page)
  const response = await page.request.post(`${origin}/api/v1/plugins/${connectionId}/sync`, {
    headers: { origin, "x-csrf-token": csrf }
  })
  expect(response.ok(), await response.text()).toBe(true)
  return Schema.decodeUnknownSync(PluginSynchronizationState)(await response.json())
}

/** Observe server-owned onboarding completion without creating a manual synchronization attempt. */
export const expectFirstSync = async (
  page: Pick<Page, "request">,
  origin: string,
  connectionId: string
): Promise<void> => {
  await expect.poll(async () => {
    const response = await page.request.get(`${origin}/api/v1/plugins/${connectionId}/synchronization`)
    expect(response.ok(), await response.text()).toBe(true)
    const state = Schema.decodeUnknownSync(PluginSynchronizationState)(await response.json())
    return { result: state.result, failure: state.failure }
  }, { message: `First sync completes for connection ${connectionId}`, timeout: 30_000 })
    .toEqual({ result: "synchronized", failure: null })
}

/** Configure the observed topology through the real governed, revision-checked settings route. */
export const configureReleaseTargets = async (page: Page | AuthenticatedVisualApi, origin: string) => {
  const settingsResponse = await page.request.get(`${origin}/api/v1/settings/`)
  expect(settingsResponse.ok(), await settingsResponse.text()).toBe(true)
  const settings = Schema.decodeUnknownSync(WorkspaceSettingsReadModel)(await settingsResponse.json())
  const catalogueResponse = await page.request.get(`${origin}/api/v1/settings/release-target-catalog`)
  expect(catalogueResponse.ok(), await catalogueResponse.text()).toBe(true)
  const catalogue = Schema.decodeUnknownSync(ReleaseTargetCatalog)(await catalogueResponse.json())
  expect(catalogue.complete).toBe(true)
  expect(catalogue.pipelines).toHaveLength(1)
  const request = Schema.decodeUnknownSync(UpdateWorkspaceSettingsRequest)({
    mutationId: "01890f6f-6d6a-7cc0-98d2-000000000301",
    expectedRevision: settings.revision,
    acknowledgedGovernedSections: ["pipeline"],
    settings: {
      ...settings.settings,
      pipeline: {
        ...settings.settings.pipeline,
        releaseTargets: catalogue.pipelines.map((pipeline) => ({
          pluginConnectionId: pipeline.pluginConnectionId,
          pipelineName: pipeline.pipelineName,
          topologyDigest: pipeline.topologyDigest,
          environments: [{
            key: "production",
            name: "Production",
            firstStage: "Build",
            lastStage: "Deploy",
            requiresManualGate: true
          }]
        }))
      }
    }
  })
  const response = await page.request.put(`${origin}/api/v1/settings/`, {
    headers: { origin, "x-csrf-token": await csrfToken(page) },
    data: Schema.encodeSync(UpdateWorkspaceSettingsRequest)(request)
  })
  expect(response.ok(), await response.text()).toBe(true)
}

export const checkConnection = async (page: Page, origin: string, connectionId: string) => {
  const csrf = Schema.decodeUnknownSync(CsrfToken)(await page.evaluate("sessionStorage.getItem('cc_csrf')"))
  const response = await page.request.post(`${origin}/api/v1/plugins/${connectionId}/test`, {
    headers: { origin, "x-csrf-token": csrf }
  })
  expect(response.ok(), await response.text()).toBe(true)
  return Schema.decodeUnknownSync(PluginConnectionTestResult)(await response.json())
}
