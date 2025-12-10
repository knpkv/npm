/**
 * Confluence API client Layer wrapper.
 *
 * @module
 */
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { ConfluenceApiConfig } from "./ConfluenceApiConfig.js"
import { type ConfluenceV1Client, make as makeV1 } from "./generated/v1/Client.js"
import { type ConfluenceV2Client, make as makeV2 } from "./generated/v2/Client.js"

/**
 * Combined v1 + v2 client shape.
 *
 * @category Client
 */
export interface ConfluenceApiClientShape {
  readonly v1: ConfluenceV1Client
  readonly v2: ConfluenceV2Client
}

/**
 * Confluence API client service.
 *
 * @example
 * ```typescript
 * import { ConfluenceApiClient, ConfluenceApiConfig } from "@knpkv/confluence-api-client"
 * import { NodeHttpClient } from "@effect/platform-node"
 * import * as Redacted from "effect/Redacted"
 * import * as Effect from "effect/Effect"
 * import * as Layer from "effect/Layer"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* ConfluenceApiClient
 *   const page = yield* client.v2.getPageById("12345", { bodyFormat: "storage" })
 *   console.log(page.title)
 * })
 *
 * const configLayer = Layer.succeed(ConfluenceApiConfig, {
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
 *     Effect.provide(ConfluenceApiClient.layer),
 *     Effect.provide(configLayer),
 *     Effect.provide(NodeHttpClient.layer)
 *   )
 * )
 * ```
 *
 * @category Client
 */
export class ConfluenceApiClient extends Context.Tag(
  "@knpkv/confluence-api-client/ConfluenceApiClient"
)<ConfluenceApiClient, ConfluenceApiClientShape>() {
  /**
   * Layer that provides ConfluenceApiClient.
   *
   * Requires: HttpClient.HttpClient, ConfluenceApiConfig
   */
  static readonly layer: Layer.Layer<
    ConfluenceApiClient,
    never,
    HttpClient.HttpClient | ConfluenceApiConfig
  > = Layer.effect(
    ConfluenceApiClient,
    Effect.gen(function*() {
      const config = yield* ConfluenceApiConfig
      const httpClient = yield* HttpClient.HttpClient

      // Build auth header
      const authHeader = config.auth.type === "basic"
        ? `Basic ${Buffer.from(`${config.auth.email}:${Redacted.value(config.auth.apiToken)}`).toString("base64")}`
        : `Bearer ${Redacted.value(config.auth.accessToken)}`

      // Base URLs differ by auth type
      const v1BaseUrl = config.auth.type === "oauth2"
        ? `https://api.atlassian.com/ex/confluence/${config.auth.cloudId}/wiki/rest/api`
        : `${config.baseUrl}/wiki/rest/api`

      const v2BaseUrl = config.auth.type === "oauth2"
        ? `https://api.atlassian.com/ex/confluence/${config.auth.cloudId}/wiki/api/v2`
        : `${config.baseUrl}/wiki/api/v2`

      // Transform client to add auth + base URL
      const makeTransform = (baseUrl: string) => (client: HttpClient.HttpClient) =>
        Effect.succeed(
          client.pipe(
            HttpClient.mapRequest((req) =>
              req.pipe(
                HttpClientRequest.prependUrl(baseUrl),
                HttpClientRequest.setHeader("Authorization", authHeader),
                HttpClientRequest.setHeader("Accept", "application/json"),
                HttpClientRequest.setHeader("Content-Type", "application/json")
              )
            )
          )
        )

      return {
        v1: makeV1(httpClient, { transformClient: makeTransform(v1BaseUrl) }),
        v2: makeV2(httpClient, { transformClient: makeTransform(v2BaseUrl) })
      }
    })
  )
}

/**
 * Layer that provides ConfluenceApiClient.
 *
 * @category Layers
 */
export const layer = ConfluenceApiClient.layer
