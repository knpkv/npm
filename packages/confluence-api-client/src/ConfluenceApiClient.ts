/**
 * Confluence API client Layer wrapper.
 *
 * Uses openapi-fetch + Effect for type-safe Confluence REST API access.
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { ConfluenceApiConfig } from "./ConfluenceApiConfig.js"
import type { paths as V1Paths } from "./generated/v1/schema.js"
import type { paths as V2Paths } from "./generated/v2/schema.js"
import { makeOpenApiFetchClient, type OpenApiFetchClient } from "./OpenApiFetchClient.js"

/**
 * Combined v1 + v2 client shape.
 *
 * @example
 * ```typescript
 * import { toEffect } from "@knpkv/confluence-api-client"
 *
 * // V2: get page by ID
 * toEffect(client.v2.client.GET("/pages/{id}", {
 *   params: { path: { id: 123 } }
 * }))
 *
 * // V2: create page with body
 * toEffect(client.v2.client.POST("/pages", {
 *   body: { spaceId: "...", title: "...", body: { ... } }
 * }))
 *
 * // V1: get user
 * toEffect(client.v1.client.GET("/wiki/rest/api/user", {
 *   params: { query: { accountId: "..." } }
 * }))
 * ```
 *
 * @category Client
 */
export interface ConfluenceApiClientShape {
  readonly v1: OpenApiFetchClient<V1Paths>
  readonly v2: OpenApiFetchClient<V2Paths>
}

/**
 * Confluence API client service.
 *
 * @example
 * ```typescript
 * import { ConfluenceApiClient, ConfluenceApiConfig } from "@knpkv/confluence-api-client"
 * import * as Redacted from "effect/Redacted"
 * import * as Effect from "effect/Effect"
 * import * as Layer from "effect/Layer"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* ConfluenceApiClient
 *   const page = yield* toEffect(client.v2.client.GET("/pages/{id}", {
 *     params: { path: { id: 12345 } }
 *   }))
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
 *     Effect.provide(configLayer)
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
   * Requires: ConfluenceApiConfig
   */
  static readonly layer: Layer.Layer<ConfluenceApiClient, never, ConfluenceApiConfig> = Layer.effect(
    ConfluenceApiClient,
    Effect.gen(function*() {
      const config = yield* ConfluenceApiConfig

      // Build auth header
      const authHeader = config.auth.type === "basic"
        ? `Basic ${Encoding.encodeBase64(`${config.auth.email}:${Redacted.value(config.auth.apiToken)}`)}`
        : `Bearer ${Redacted.value(config.auth.accessToken)}`

      // V1 schema paths include /wiki/rest/api prefix, so base URL is just the origin
      const v1BaseUrl = config.auth.type === "oauth2"
        ? `https://api.atlassian.com/ex/confluence/${config.auth.cloudId}`
        : config.baseUrl

      const v2BaseUrl = config.auth.type === "oauth2"
        ? `https://api.atlassian.com/ex/confluence/${config.auth.cloudId}/wiki/api/v2`
        : `${config.baseUrl}/wiki/api/v2`

      const headers = {
        Authorization: authHeader,
        Accept: "application/json",
        "Content-Type": "application/json"
      }

      return {
        v1: makeOpenApiFetchClient<V1Paths>(v1BaseUrl, headers),
        v2: makeOpenApiFetchClient<V2Paths>(v2BaseUrl, headers)
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
