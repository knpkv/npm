/**
 * Confluence Cloud REST API v1 client (minimal).
 *
 * Only endpoints needed for confluence-to-markdown:
 * - GET /user?accountId={id}
 * - GET/POST/PUT /content/{pageId}/property/{key}
 *
 * @module
 */
import type * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as Effect from "effect/Effect"

/**
 * Atlassian user information.
 */
export interface User {
  readonly accountId: string
  readonly displayName: string
  readonly email?: string | undefined
  readonly publicName?: string | undefined
}

/**
 * Content property value.
 */
export interface ContentProperty {
  readonly key: string
  readonly value: unknown
  readonly version: {
    readonly number: number
  }
}

/**
 * Content property create/update request.
 */
export interface ContentPropertyRequest {
  readonly key: string
  readonly value: unknown
  readonly version: {
    readonly number: number
  }
}

/**
 * API error response.
 */
export interface ApiError {
  readonly _tag: "ApiError"
  readonly status: number
  readonly message: string
}

const ApiError = (status: number, message: string): ApiError => ({
  _tag: "ApiError",
  status,
  message
})

/**
 * Confluence V1 API client interface.
 */
export interface ConfluenceV1Client {
  readonly getUser: (options: {
    readonly accountId: string
  }) => Effect.Effect<User, ApiError>

  readonly getContentProperty: (
    contentId: string,
    key: string
  ) => Effect.Effect<ContentProperty, ApiError>

  readonly createContentProperty: (
    contentId: string,
    options: { readonly payload: ContentPropertyRequest }
  ) => Effect.Effect<ContentProperty, ApiError>

  readonly updateContentProperty: (
    contentId: string,
    key: string,
    options: { readonly payload: ContentPropertyRequest }
  ) => Effect.Effect<ContentProperty, ApiError>
}

/**
 * Create Confluence V1 API client.
 */
export const make = (
  httpClient: HttpClient.HttpClient,
  options: {
    readonly transformClient?: (
      client: HttpClient.HttpClient
    ) => Effect.Effect<HttpClient.HttpClient>
  } = {}
): ConfluenceV1Client => {
  const getClient = options.transformClient
    ? options.transformClient(httpClient)
    : Effect.succeed(httpClient)

  const execute = <A>(
    request: HttpClientRequest.HttpClientRequest
  ): Effect.Effect<A, ApiError> =>
    Effect.gen(function*() {
      const client = yield* getClient
      const response = yield* client.execute(request).pipe(
        Effect.mapError((e) => ApiError(0, `Request failed: ${e.message}`))
      )

      if (response.status >= 400) {
        const text = yield* response.text.pipe(Effect.catchAll(() => Effect.succeed("")))
        return yield* Effect.fail(ApiError(response.status, text || `HTTP ${response.status}`))
      }

      const json = yield* response.json.pipe(
        Effect.mapError((e) => ApiError(0, `JSON parse failed: ${e}`))
      )

      return json as A
    })

  return {
    getUser: ({ accountId }) =>
      execute<User>(
        HttpClientRequest.get("/user").pipe(
          HttpClientRequest.setUrlParams({ accountId })
        )
      ),

    getContentProperty: (contentId, key) =>
      execute<ContentProperty>(
        HttpClientRequest.get(`/content/${contentId}/property/${key}`)
      ),

    createContentProperty: (contentId, { payload }) =>
      Effect.gen(function*() {
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(`/content/${contentId}/property`),
          payload
        ).pipe(Effect.mapError((e) => ApiError(0, `Body JSON error: ${e}`)))
        return yield* execute<ContentProperty>(request)
      }),

    updateContentProperty: (contentId, key, { payload }) =>
      Effect.gen(function*() {
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.put(`/content/${contentId}/property/${key}`),
          payload
        ).pipe(Effect.mapError((e) => ApiError(0, `Body JSON error: ${e}`)))
        return yield* execute<ContentProperty>(request)
      })
  }
}
