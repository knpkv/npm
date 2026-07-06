/**
 * Effect Layer wrapping openapi-fetch Jira V3 client with auth and base URL.
 *
 * **Mental model**
 *
 * - **Auth-polymorphic**: Supports both Basic (email + API token) and OAuth2 (access token +
 *   cloud ID) auth. The layer reads {@link JiraApiConfig} to build the Authorization header
 *   and derive the correct base URL.
 * - **openapi-fetch wrapper**: Uses {@link OpenApiFetchClient} for Effect-based methods.
 *
 * **Common tasks**
 *
 * - Use the client: `const jira = yield* JiraApiClient; jira.v3.GET(...)`
 * - Provide the layer: `Effect.provide(JiraApiClient.layer)`
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type { paths as V3Paths } from "./generated/v3/schema.js"
import { JiraApiConfig } from "./JiraApiConfig.js"
import { makeOpenApiFetchClient, type OpenApiFetchClient } from "./OpenApiFetchClient.js"

/**
 * Jira API client shape (v3 only).
 *
 * @example
 * ```typescript
 * import { toEffect } from "@knpkv/jira-api-client"
 *
 * // Get issue by key
 * toEffect(client.v3.client.GET("/rest/api/3/issue/{issueIdOrKey}", {
 *   params: { path: { issueIdOrKey: "PROJ-123" } }
 * }))
 *
 * // Search issues with JQL
 * toEffect(client.v3.client.POST("/rest/api/3/search/jql", {
 *   body: { jql: "project = PROJ", maxResults: 50 }
 * }))
 * ```
 *
 * @category Client
 */
export interface JiraApiClientShape {
  readonly v3: OpenApiFetchClient<V3Paths>
}

/**
 * Jira API client service.
 *
 * @example
 * ```typescript
 * import { JiraApiClient, JiraApiConfig } from "@knpkv/jira-api-client"
 * import * as Redacted from "effect/Redacted"
 * import * as Effect from "effect/Effect"
 * import * as Layer from "effect/Layer"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* JiraApiClient
 *   const issue = yield* toEffect(client.v3.client.GET("/rest/api/3/issue/{issueIdOrKey}", {
 *     params: { path: { issueIdOrKey: "PROJ-123" } }
 *   }))
 *   console.log(issue.fields?.summary)
 * })
 *
 * const configLayer = Layer.succeed(JiraApiConfig, {
 *   baseUrl: "https://mysite.atlassian.net",
 *   auth: {
 *     type: "basic",
 *     email: "user@example.com",
 *     apiToken: Redacted.make("token")
 *   }
 * })
 *
 * Effect.runPromise(
 *   program.pipe(
 *     Effect.provide(JiraApiClient.layer),
 *     Effect.provide(configLayer)
 *   )
 * )
 * ```
 *
 * @category Client
 */
export class JiraApiClient extends Context.Service<JiraApiClient, JiraApiClientShape>()(
  "@knpkv/jira-api-client/JiraApiClient"
) {
  /**
   * Layer that provides JiraApiClient.
   *
   * Requires: JiraApiConfig
   */
  static readonly layer: Layer.Layer<JiraApiClient, never, JiraApiConfig> = Layer.effect(
    JiraApiClient,
    Effect.gen(function*() {
      const config = yield* JiraApiConfig

      // Build auth header
      const authHeader = config.auth.type === "basic"
        ? `Basic ${Encoding.encodeBase64(`${config.auth.email}:${Redacted.value(config.auth.apiToken)}`)}`
        : `Bearer ${Redacted.value(config.auth.accessToken)}`

      // Base URL differs by auth type
      const baseUrl = config.auth.type === "oauth2"
        ? `https://api.atlassian.com/ex/jira/${config.auth.cloudId}`
        : config.baseUrl

      const headers = {
        Authorization: authHeader,
        Accept: "application/json"
      }

      return {
        v3: makeOpenApiFetchClient<V3Paths>(baseUrl, headers)
      }
    })
  )
}

/**
 * Layer that provides JiraApiClient.
 *
 * @category Layers
 */
export const layer = JiraApiClient.layer
