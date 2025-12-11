/**
 * Confluence Cloud REST API v2 client (minimal).
 *
 * Endpoints needed for confluence-to-markdown:
 * - GET /pages/{id}
 * - GET /pages/{id}/children
 * - GET /pages/{id}/versions
 * - POST /pages
 * - PUT /pages/{id}
 * - DELETE /pages/{id}
 *
 * @module
 */
import type * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as Effect from "effect/Effect"

// ============================================================================
// Types
// ============================================================================

export interface PageVersion {
  readonly number?: number | undefined
  readonly createdAt?: string | undefined
  readonly message?: string | undefined
  readonly authorId?: string | undefined
}

export interface PageBody {
  readonly storage?: {
    readonly value: string
    readonly representation?: string | undefined
  } | undefined
}

export interface PageLinks {
  readonly webui?: string | undefined
  readonly next?: string | undefined
}

export interface Page {
  readonly id: string
  readonly title: string
  readonly spaceId?: string | undefined
  readonly status?: string | undefined
  readonly version?: PageVersion | undefined
  readonly body?: PageBody | undefined
  readonly parentId?: string | undefined
  readonly position?: number | undefined
  readonly _links?: PageLinks | undefined
}

export interface PageListItem {
  readonly id: string
  readonly title: string
  readonly status?: string | undefined
  readonly spaceId?: string | undefined
  readonly parentId?: string | undefined
}

export interface PageChildrenResponse {
  readonly results: ReadonlyArray<PageListItem>
  readonly _links?: PageLinks | undefined
}

export interface PageVersionWithBody extends PageVersion {
  readonly page?: {
    readonly id?: string | undefined
    readonly title?: string | undefined
    readonly body?: PageBody | undefined
  } | undefined
}

export interface PageVersionsResponse {
  readonly results: ReadonlyArray<PageVersionWithBody>
  readonly _links?: PageLinks | undefined
}

export interface CreatePageRequest {
  readonly spaceId: string
  readonly title: string
  readonly parentId?: string | undefined
  readonly body: {
    readonly representation: "storage"
    readonly value: string
  }
}

export interface UpdatePageRequest {
  readonly id: string
  readonly title: string
  readonly status?: "current" | "draft" | undefined
  readonly version: {
    readonly number: number
    readonly message?: string | undefined
  }
  readonly body: {
    readonly representation: "storage"
    readonly value: string
  }
}

export interface GetPageParams {
  readonly bodyFormat?: "storage" | "atlas_doc_format" | "view" | undefined
}

export interface GetChildrenParams {
  readonly bodyFormat?: "storage" | "atlas_doc_format" | "view" | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

export interface GetVersionsParams {
  readonly bodyFormat?: "storage" | "atlas_doc_format" | "view" | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

/**
 * API error response.
 */
export interface ApiError {
  readonly _tag: "ApiError"
  readonly status: number
  readonly message: string
  readonly endpoint?: string | undefined
}

const ApiError = (status: number, message: string, endpoint?: string): ApiError => ({
  _tag: "ApiError",
  status,
  message,
  endpoint
})

/**
 * Confluence V2 API client interface.
 */
export interface ConfluenceV2Client {
  readonly getPageById: (
    id: string,
    params?: GetPageParams
  ) => Effect.Effect<Page, ApiError>

  readonly getPageChildren: (
    id: string,
    params?: GetChildrenParams
  ) => Effect.Effect<PageChildrenResponse, ApiError>

  readonly getPageVersions: (
    id: string,
    params?: GetVersionsParams
  ) => Effect.Effect<PageVersionsResponse, ApiError>

  readonly createPage: (
    request: CreatePageRequest
  ) => Effect.Effect<Page, ApiError>

  readonly updatePage: (
    id: string,
    request: UpdatePageRequest
  ) => Effect.Effect<Page, ApiError>

  readonly deletePage: (
    id: string
  ) => Effect.Effect<void, ApiError>
}

/**
 * Create Confluence V2 API client.
 */
export const make = (
  httpClient: HttpClient.HttpClient,
  options: {
    readonly transformClient?: (
      client: HttpClient.HttpClient
    ) => Effect.Effect<HttpClient.HttpClient>
  } = {}
): ConfluenceV2Client => {
  const getClient = options.transformClient
    ? options.transformClient(httpClient)
    : Effect.succeed(httpClient)

  const execute = <A>(
    request: HttpClientRequest.HttpClientRequest,
    endpoint: string
  ): Effect.Effect<A, ApiError> =>
    Effect.gen(function*() {
      const client = yield* getClient
      const response = yield* client.execute(request).pipe(
        Effect.mapError((e) => ApiError(0, `Request failed: ${e.message}`, endpoint))
      )

      if (response.status >= 400) {
        const text = yield* response.text.pipe(Effect.catchAll(() => Effect.succeed("")))
        return yield* Effect.fail(ApiError(response.status, text || `HTTP ${response.status}`, endpoint))
      }

      // Handle 204 No Content
      if (response.status === 204) {
        return undefined as A
      }

      const json = yield* response.json.pipe(
        Effect.mapError((e) => ApiError(0, `JSON parse failed: ${e}`, endpoint))
      )

      return json as A
    })

  const buildUrlParams = (params: Record<string, string | number | undefined>): Record<string, string> => {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        result[key] = String(value)
      }
    }
    return result
  }

  return {
    getPageById: (id, params = {}) =>
      execute<Page>(
        HttpClientRequest.get(`/pages/${id}`).pipe(
          HttpClientRequest.setUrlParams(buildUrlParams({
            "body-format": params.bodyFormat
          }))
        ),
        `/pages/${id}`
      ),

    getPageChildren: (id, params = {}) =>
      execute<PageChildrenResponse>(
        HttpClientRequest.get(`/pages/${id}/children`).pipe(
          HttpClientRequest.setUrlParams(buildUrlParams({
            "body-format": params.bodyFormat,
            cursor: params.cursor,
            limit: params.limit
          }))
        ),
        `/pages/${id}/children`
      ),

    getPageVersions: (id, params = {}) =>
      execute<PageVersionsResponse>(
        HttpClientRequest.get(`/pages/${id}/versions`).pipe(
          HttpClientRequest.setUrlParams(buildUrlParams({
            "body-format": params.bodyFormat,
            cursor: params.cursor,
            limit: params.limit
          }))
        ),
        `/pages/${id}/versions`
      ),

    createPage: (request) =>
      Effect.gen(function*() {
        const req = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post("/pages"),
          request
        ).pipe(Effect.mapError((e) => ApiError(0, `Body JSON error: ${e}`, "/pages")))
        return yield* execute<Page>(req, "/pages")
      }),

    updatePage: (id, request) =>
      Effect.gen(function*() {
        const req = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.put(`/pages/${id}`),
          request
        ).pipe(Effect.mapError((e) => ApiError(0, `Body JSON error: ${e}`, `/pages/${id}`)))
        return yield* execute<Page>(req, `/pages/${id}`)
      }),

    deletePage: (id) =>
      execute<void>(
        HttpClientRequest.del(`/pages/${id}`),
        `/pages/${id}`
      )
  }
}
