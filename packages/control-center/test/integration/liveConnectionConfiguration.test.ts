import { assert, describe, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import { HttpApiClient } from "effect/unstable/httpapi"

import { ControlCenterApi } from "../../src/api/controlCenterApi.js"
import { PluginConfigurationKey } from "../../src/api/plugins.js"
import { PluginConnectionId } from "../../src/domain/identifiers.js"
import { LiveConnectionConfigurationError, loadLiveConnectionConfiguration } from "./liveConnectionConfiguration.js"
import {
  assertSensitiveTextAbsent,
  LiveIntegrationRequestError,
  makeSecretSafeLiveHttpClient,
  redactAuthenticatedLiveResponse
} from "./liveSecretAssertions.js"

const completeEnvironment = {
  CONTROL_CENTER_LIVE_INTEGRATION: "1",
  CONTROL_CENTER_TEST_ATLASSIAN_SITE_ID: "site-123",
  CONTROL_CENTER_TEST_ATLASSIAN_SITE_URL: "https://knpkv.atlassian.net/",
  CONTROL_CENTER_TEST_AWS_REGION: "eu-west-1",
  CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY: "control-center-live",
  CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE: "control-center-live",
  CONTROL_CENTER_TEST_CONFLUENCE_PAGE_ID: "123456",
  CONTROL_CENTER_TEST_CONFLUENCE_SPACE_ID: "654321",
  CONTROL_CENTER_TEST_JIRA_PROJECT_ID: "10000",
  CONFLUENCE_API_KEY: "confluence-token",
  CONFLUENCE_EMAIL: "owner@example.com",
  JIRA_API_KEY: "jira-token",
  JIRA_EMAIL: "owner@example.com"
}

const provideEnvironment = (environment: Readonly<Record<string, string>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: environment }))

describe("live connection configuration", () => {
  it.effect("decodes one complete configuration while retaining provider tokens as redacted values", () =>
    Effect.gen(function*() {
      const configuration = yield* loadLiveConnectionConfiguration

      assert.strictEqual(configuration.awsRegion, "eu-west-1")
      assert.strictEqual(configuration.atlassianSiteUrl, "https://knpkv.atlassian.net/")
      assert.strictEqual(configuration.jiraApiKey.toString(), "<redacted>")
      assert.strictEqual(configuration.confluenceApiKey.toString(), "<redacted>")
      assert.strictEqual(Redacted.value(configuration.jiraApiKey), "jira-token")
    }).pipe(Effect.provide(provideEnvironment(completeEnvironment))))

  it.effect("fails before allocation when an enabled run omits required configuration", () =>
    Effect.gen(function*() {
      const result = yield* loadLiveConnectionConfiguration.pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, LiveConnectionConfigurationError)
        assert.include(result.failure.requiredVariables, "CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE")
        assertSensitiveTextAbsent(JSON.stringify(result.failure), "jira-token")
      }
    }).pipe(
      Effect.provide(
        provideEnvironment({
          ...completeEnvironment,
          CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE: ""
        })
      )
    ))

  it.effect("requires the explicit activation value even when every provider fixture is configured", () =>
    Effect.gen(function*() {
      const result = yield* loadLiveConnectionConfiguration.pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.diagnosticCode, "live-integration-configuration-incomplete")
      }
    }).pipe(
      Effect.provide(
        provideEnvironment({
          ...completeEnvironment,
          CONTROL_CENTER_LIVE_INTEGRATION: "0"
        })
      )
    ))

  it.effect("rejects malformed credential values before allocating live resources", () =>
    Effect.gen(function*() {
      for (
        const environment of [
          { ...completeEnvironment, JIRA_API_KEY: "   " },
          { ...completeEnvironment, CONFLUENCE_API_KEY: "x".repeat(16_385) },
          { ...completeEnvironment, JIRA_EMAIL: "not-an-email" }
        ]
      ) {
        const result = yield* loadLiveConnectionConfiguration.pipe(
          Effect.provide(provideEnvironment(environment)),
          Effect.result
        )
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, LiveConnectionConfigurationError)
        }
      }
    }))

  it("does not echo sensitive operands when a redaction assertion fails", () => {
    const canary = "live-secret-assertion-canary"
    let renderedFailure = ""
    try {
      assertSensitiveTextAbsent(`prefix-${canary}-suffix`, canary)
    } catch (cause) {
      renderedFailure = String(cause)
    }
    assert.isFalse(renderedFailure.includes(canary))
    assert.include(renderedFailure, "redaction boundary")
  })

  it.effect("replaces transport failures at the credential-bearing HTTP client boundary", () =>
    Effect.gen(function*() {
      const tokenCanary = "live-http-request-token-canary"
      const cookieCanary = "live-http-cookie-canary"
      const csrfCanary = "live-http-csrf-canary"
      const failingClient = HttpClient.make((request) => {
        const rawFailure = new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: "fixture transport failed"
          })
        })
        const rawSerialization = JSON.stringify(rawFailure)
        assert.isTrue([tokenCanary, csrfCanary].every((canary) => rawSerialization.includes(canary)))
        assert.isFalse(rawSerialization.includes(cookieCanary))
        return Effect.fail(rawFailure)
      })
      const authenticatedClient = failingClient.pipe(
        makeSecretSafeLiveHttpClient("authenticated-api", {
          cookie: `cc_session=${cookieCanary}`,
          "x-csrf-token": csrfCanary
        })
      )
      const apiClient = yield* HttpApiClient.makeWith(ControlCenterApi, {
        baseUrl: "http://127.0.0.1",
        httpClient: authenticatedClient,
        transformResponse: redactAuthenticatedLiveResponse
      })

      const result = yield* apiClient.plugins
        .createConnection({
          payload: {
            pluginConnectionId: PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-0000000000ff"),
            providerId: "jira",
            displayName: "Transport failure fixture",
            values: [
              {
                _tag: "secret",
                key: PluginConfigurationKey.make("apiToken"),
                value: tokenCanary
              }
            ]
          }
        })
        .pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, LiveIntegrationRequestError)
        assert.strictEqual(result.failure.operation, "authenticated-api")
        for (const canary of [tokenCanary, cookieCanary, csrfCanary]) {
          assertSensitiveTextAbsent(JSON.stringify(result.failure), canary)
          assertSensitiveTextAbsent(String(result.failure), canary)
        }
      }
    }))
})
