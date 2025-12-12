/**
 * Jira API client Layer wrapper.
 *
 * @module
 */
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { type JiraV3Client, make as makeV3 } from "./generated/v3/Client.js"
import { JiraApiConfig } from "./JiraApiConfig.js"

/**
 * Jira API client shape (v3 only).
 *
 * @category Client
 */
export interface JiraApiClientShape {
  readonly v3: JiraV3Client
}

/**
 * Jira API client service.
 *
 * @example
 * ```typescript
 * import { JiraApiClient, JiraApiConfig } from "@knpkv/jira-api-client"
 * import { NodeHttpClient } from "@effect/platform-node"
 * import * as Redacted from "effect/Redacted"
 * import * as Effect from "effect/Effect"
 * import * as Layer from "effect/Layer"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* JiraApiClient
 *   const issue = yield* client.v3.getIssue("PROJ-123")
 *   console.log(issue.fields.summary)
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
 *     Effect.provide(configLayer),
 *     Effect.provide(NodeHttpClient.layer)
 *   )
 * )
 * ```
 *
 * @category Client
 */
export class JiraApiClient extends Context.Tag(
  "@knpkv/jira-api-client/JiraApiClient"
)<JiraApiClient, JiraApiClientShape>() {
  /**
   * Layer that provides JiraApiClient.
   *
   * Requires: HttpClient.HttpClient, JiraApiConfig
   */
  static readonly layer: Layer.Layer<
    JiraApiClient,
    never,
    HttpClient.HttpClient | JiraApiConfig
  > = Layer.effect(
    JiraApiClient,
    Effect.gen(function*() {
      const config = yield* JiraApiConfig
      const httpClient = yield* HttpClient.HttpClient

      // Build auth header
      const authHeader = config.auth.type === "basic"
        ? `Basic ${Buffer.from(`${config.auth.email}:${Redacted.value(config.auth.apiToken)}`).toString("base64")}`
        : `Bearer ${Redacted.value(config.auth.accessToken)}`

      // Base URL differs by auth type
      const baseUrl = config.auth.type === "oauth2"
        ? `https://api.atlassian.com/ex/jira/${config.auth.cloudId}`
        : config.baseUrl

      // Transform client to add auth + base URL
      const makeTransform = (url: string) => (client: HttpClient.HttpClient) =>
        Effect.succeed(
          client.pipe(
            HttpClient.mapRequest((req) =>
              req.pipe(
                HttpClientRequest.prependUrl(url),
                HttpClientRequest.setHeader("Authorization", authHeader),
                HttpClientRequest.setHeader("Accept", "application/json"),
                HttpClientRequest.setHeader("Content-Type", "application/json")
              )
            )
          )
        )

      return {
        v3: makeV3(httpClient, { transformClient: makeTransform(baseUrl) })
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
