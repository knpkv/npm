/**
 * Confluence REST API v2 client service.
 *
 * Wraps @knpkv/confluence-api-client with rate limit retry logic and pagination helpers.
 *
 * @module
 */
import { ConfluenceApiClient, ConfluenceApiConfig, FetchClientError, toEffect } from "@knpkv/confluence-api-client"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type { PageId } from "./Brand.js"
import { ApiError, RateLimitError } from "./ConfluenceError.js"
import {
  type AtlassianUser,
  AtlassianUserSchema,
  type PageChildrenResponse,
  PageChildrenResponseSchema,
  type PageListItem,
  type PageResponse,
  PageResponseSchema,
  type PageVersion,
  PageVersionsResponseSchema
} from "./Schemas.js"

/**
 * Request to create a new page.
 *
 * @category Types
 */
export interface CreatePageRequest {
  readonly spaceId: string
  readonly title: string
  readonly parentId?: string
  readonly body: {
    readonly representation: "atlas_doc_format"
    readonly value: string
  }
}

/**
 * Request to update an existing page.
 *
 * @category Types
 */
export interface UpdatePageRequest {
  readonly id: string
  readonly title: string
  readonly status?: "current" | "draft"
  readonly version: {
    readonly number: number
    readonly message?: string
  }
  readonly body: {
    readonly representation: "atlas_doc_format"
    readonly value: string
  }
}

/**
 * Confluence REST API v2 client service.
 *
 * @example
 * ```typescript
 * import { ConfluenceClient } from "@knpkv/confluence-to-markdown/ConfluenceClient"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* ConfluenceClient
 *   const page = yield* client.getPage("12345")
 *   console.log(page.title)
 * })
 * ```
 *
 * @category Client
 */
export class ConfluenceClient extends Context.Service<
  ConfluenceClient,
  {
    /**
     * Get a page by ID.
     */
    readonly getPage: (id: PageId) => Effect.Effect<PageResponse, ApiError | RateLimitError>

    /**
     * Get children of a page.
     */
    readonly getChildren: (id: PageId) => Effect.Effect<PageChildrenResponse, ApiError | RateLimitError>

    /**
     * Get all children recursively (handles pagination).
     */
    readonly getAllChildren: (id: PageId) => Effect.Effect<ReadonlyArray<PageListItem>, ApiError | RateLimitError>

    /**
     * Create a new page.
     */
    readonly createPage: (request: CreatePageRequest) => Effect.Effect<PageResponse, ApiError | RateLimitError>

    /**
     * Update an existing page.
     */
    readonly updatePage: (request: UpdatePageRequest) => Effect.Effect<PageResponse, ApiError | RateLimitError>

    /**
     * Delete a page.
     */
    readonly deletePage: (id: PageId) => Effect.Effect<void, ApiError | RateLimitError>

    /**
     * Get version history for a page.
     */
    readonly getPageVersions: (
      id: PageId,
      options?: { since?: number; includeBody?: boolean }
    ) => Effect.Effect<ReadonlyArray<PageVersion>, ApiError | RateLimitError>

    /**
     * Get user info by account ID.
     */
    readonly getUser: (accountId: string) => Effect.Effect<AtlassianUser, ApiError | RateLimitError>

    /**
     * Get space ID for a page.
     */
    readonly getSpaceId: (pageId: PageId) => Effect.Effect<string, ApiError | RateLimitError>

    /**
     * Set editor version for a page (v1 or v2).
     * Uses V2 page properties API.
     */
    readonly setEditorVersion: (pageId: PageId, version: "v1" | "v2") => Effect.Effect<void, ApiError | RateLimitError>
  }
>()("@knpkv/confluence-to-markdown/ConfluenceClient") {}

/**
 * Configuration for the Confluence client.
 *
 * @category Config
 */
export interface ConfluenceClientConfig {
  readonly baseUrl: string
  readonly auth: {
    readonly type: "token"
    readonly email: string
    readonly token: string
  } | {
    readonly type: "oauth2"
    readonly accessToken: string
    readonly cloudId: string
  }
}

/** Maximum pagination iterations to prevent infinite loops */
const MAX_PAGINATION_ITERATIONS = 100

/** Default page size for version fetching */
const VERSIONS_PAGE_SIZE = 50
const ATLAS_DOC_FORMAT: "atlas_doc_format" = "atlas_doc_format"

/**
 * Rate limit retry schedule with exponential backoff.
 */
const rateLimitRetry: {
  readonly schedule: Schedule.Schedule<unknown, unknown, unknown>
  readonly times: number
  readonly while: (error: ApiError | RateLimitError) => error is RateLimitError
} = {
  schedule: Schedule.exponential("1 second").pipe(
    Schedule.either(Schedule.spaced("30 seconds"))
  ),
  times: 3,
  while: (error: ApiError | RateLimitError): error is RateLimitError => Predicate.isTagged(error, "RateLimitError")
}

/**
 * Map API client errors to domain errors.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const recordOrNull = (value: unknown): Record<string, unknown> | null => isRecord(value) ? value : null

const stringOrUndefined = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const numberOrUndefined = (value: unknown): number | undefined => typeof value === "number" ? value : undefined

const fetchClientErrorFromUnknown = (error: unknown): FetchClientError =>
  (() => {
    const record = recordOrNull(error)
    if (record?._tag === "FetchClientError") {
      return new FetchClientError({
        error: record["error"],
        status: numberOrUndefined(record["status"]) ?? 0,
        message: stringOrUndefined(record["message"]) ?? String(record["error"] ?? error)
      })
    }
    return new FetchClientError({
      error,
      status: 0,
      message: String(error)
    })
  })()

const mapApiError = (error: unknown, endpoint: string, pageId?: string): ApiError | RateLimitError => {
  const fetchError = fetchClientErrorFromUnknown(error)
  if (fetchError.status === 429) {
    return new RateLimitError()
  }
  return new ApiError({
    status: fetchError.status,
    message: fetchError.message,
    endpoint,
    ...(pageId !== undefined && { pageId })
  })
}

const normalizeConfluenceError = (
  error: unknown,
  endpoint: string,
  pageId?: string
): ApiError | RateLimitError => {
  const record = recordOrNull(error)
  if (record?._tag === "ApiError") {
    const errorPageId = stringOrUndefined(record["pageId"])
    return new ApiError({
      status: numberOrUndefined(record["status"]) ?? 0,
      message: stringOrUndefined(record["message"]) ?? String(error),
      endpoint: stringOrUndefined(record["endpoint"]) ?? endpoint,
      ...(errorPageId !== undefined ? { pageId: errorPageId } : {})
    })
  }
  if (record?._tag === "RateLimitError") {
    const retryAfter = numberOrUndefined(record["retryAfter"])
    return new RateLimitError(retryAfter !== undefined ? { retryAfter } : undefined)
  }
  return mapApiError(error, endpoint, pageId)
}

const mapDecodeError = (cause: unknown, endpoint: string, pageId?: string): ApiError =>
  new ApiError({
    status: 0,
    message: `Invalid Confluence API response for ${endpoint}: ${String(cause)}`,
    endpoint,
    ...(pageId !== undefined && { pageId })
  })

const decodePageResponse = (
  value: unknown,
  endpoint: string,
  pageId?: string
): Effect.Effect<PageResponse, ApiError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PageResponseSchema)(value),
    catch: (cause) => mapDecodeError(cause, endpoint, pageId)
  })

const decodeChildrenResponse = (
  value: unknown,
  endpoint: string,
  pageId?: string
): Effect.Effect<PageChildrenResponse, ApiError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PageChildrenResponseSchema)(value),
    catch: (cause) => mapDecodeError(cause, endpoint, pageId)
  })

const decodeVersionsResponse = (
  value: unknown,
  endpoint: string,
  pageId?: string
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PageVersionsResponseSchema)(value),
    catch: (cause) => mapDecodeError(cause, endpoint, pageId)
  })

const decodeAtlassianUser = (
  value: unknown,
  endpoint: string
): Effect.Effect<AtlassianUser, ApiError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(AtlassianUserSchema)(value),
    catch: (cause) => mapDecodeError(cause, endpoint)
  })

interface EditorProperty {
  id?: string
  version?: {
    number?: number
  }
}

const firstEditorProperty = (value: unknown): EditorProperty | undefined => {
  const response = recordOrNull(value)
  const results = response?.["results"]
  if (!Array.isArray(results)) return undefined
  const first = recordOrNull(results[0])
  if (first === null) return undefined
  const property: EditorProperty = {}
  const id = stringOrUndefined(first["id"])
  if (id !== undefined) {
    property.id = id
  }
  const version = recordOrNull(first["version"])
  const versionNumber = version !== null ? numberOrUndefined(version["number"]) : undefined
  if (versionNumber !== undefined) {
    property.version = { number: versionNumber }
  }
  return property
}

/**
 * Create the Confluence client service.
 */
const make = (
  config: ConfluenceClientConfig
): Effect.Effect<Context.Service.Shape<typeof ConfluenceClient>> =>
  Effect.gen(function*() {
    // Create underlying API client
    const apiConfigLayer = Layer.succeed(ConfluenceApiConfig, {
      baseUrl: config.baseUrl,
      auth: config.auth.type === "token"
        ? { type: "basic", email: config.auth.email, apiToken: Redacted.make(config.auth.token) }
        : { type: "oauth2", accessToken: Redacted.make(config.auth.accessToken), cloudId: config.auth.cloudId }
    })

    const apiClient = yield* ConfluenceApiClient.pipe(
      Effect.provide(ConfluenceApiClient.layer),
      Effect.provide(apiConfigLayer)
    )

    const getPage = (id: PageId): Effect.Effect<PageResponse, ApiError | RateLimitError> =>
      toEffect(apiClient.v2.client.GET("/pages/{id}", {
        params: { path: { id: Number(id) }, query: { "body-format": ATLAS_DOC_FORMAT } }
      })).pipe(
        Effect.mapError((e) => mapApiError(e, `/pages/${id}`, id)),
        Effect.retry(rateLimitRetry),
        Effect.mapError((e) => normalizeConfluenceError(e, `/pages/${id}`, id)),
        Effect.flatMap((response) => decodePageResponse(response, `/pages/${id}`, id))
      )

    const getChildren = (id: PageId): Effect.Effect<PageChildrenResponse, ApiError | RateLimitError> =>
      toEffect(apiClient.v2.client.GET("/pages/{id}/children", {
        params: { path: { id: Number(id) } }
      })).pipe(
        Effect.mapError((e) => mapApiError(e, `/pages/${id}/children`, id)),
        Effect.retry(rateLimitRetry),
        Effect.mapError((e) => normalizeConfluenceError(e, `/pages/${id}/children`, id)),
        Effect.flatMap((response) => decodeChildrenResponse(response, `/pages/${id}/children`, id))
      )

    const getAllChildren = (id: PageId): Effect.Effect<ReadonlyArray<PageListItem>, ApiError | RateLimitError> =>
      Effect.gen(function*() {
        const allChildren: Array<PageListItem> = []
        let cursor: string | undefined
        let iterations = 0

        do {
          if (iterations >= MAX_PAGINATION_ITERATIONS) {
            return yield* Effect.fail(
              new ApiError({
                status: 0,
                message: `Pagination limit exceeded: more than ${MAX_PAGINATION_ITERATIONS} pages of children`,
                endpoint: `/pages/${id}/children`,
                pageId: id
              })
            )
          }

          const response = yield* toEffect(apiClient.v2.client.GET("/pages/{id}/children", {
            params: { path: { id: Number(id) }, query: { ...(cursor ? { cursor } : {}) } }
          })).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${id}/children`, id)),
            Effect.retry(rateLimitRetry),
            Effect.mapError((e) => normalizeConfluenceError(e, `/pages/${id}/children`, id)),
            Effect.flatMap((rawResponse) => decodeChildrenResponse(rawResponse, `/pages/${id}/children`, id))
          )

          for (const child of response.results) {
            allChildren.push(child)
          }

          cursor = response._links?.next
            ? new URL(response._links.next, config.baseUrl).searchParams.get("cursor") ?? undefined
            : undefined

          iterations++
        } while (cursor)

        return allChildren
      })

    const createPage = (req: CreatePageRequest): Effect.Effect<PageResponse, ApiError | RateLimitError> =>
      toEffect(apiClient.v2.client.POST("/pages", {
        body: {
          spaceId: req.spaceId,
          title: req.title,
          ...(req.parentId ? { parentId: req.parentId } : {}),
          body: { representation: req.body.representation, value: req.body.value },
          status: "current"
        }
      })).pipe(
        Effect.mapError((e) => mapApiError(e, "/pages")),
        Effect.retry(rateLimitRetry),
        Effect.mapError((e) => normalizeConfluenceError(e, "/pages")),
        Effect.flatMap((response) => decodePageResponse(response, "/pages"))
      )

    const updatePage = (req: UpdatePageRequest): Effect.Effect<PageResponse, ApiError | RateLimitError> =>
      toEffect(apiClient.v2.client.PUT("/pages/{id}", {
        params: { path: { id: Number(req.id) } },
        body: {
          id: req.id,
          title: req.title,
          status: req.status ?? "current",
          body: { representation: req.body.representation, value: req.body.value },
          version: { number: req.version.number, ...(req.version.message ? { message: req.version.message } : {}) }
        }
      })).pipe(
        Effect.mapError((e) => mapApiError(e, `/pages/${req.id}`, req.id)),
        Effect.retry(rateLimitRetry),
        Effect.mapError((e) => normalizeConfluenceError(e, `/pages/${req.id}`, req.id)),
        Effect.flatMap((response) => decodePageResponse(response, `/pages/${req.id}`, req.id))
      )

    const deletePage = (id: PageId): Effect.Effect<void, ApiError | RateLimitError> =>
      toEffect(apiClient.v2.client.DELETE("/pages/{id}", {
        params: { path: { id: Number(id) } }
      })).pipe(
        Effect.map(() => void 0),
        Effect.mapError((e) => mapApiError(e, `/pages/${id}`, id)),
        Effect.retry(rateLimitRetry),
        Effect.mapError((e) => normalizeConfluenceError(e, `/pages/${id}`, id))
      )

    const getPageVersions = (
      id: PageId,
      options?: { since?: number; includeBody?: boolean }
    ): Effect.Effect<ReadonlyArray<PageVersion>, ApiError | RateLimitError> =>
      Effect.gen(function*() {
        const allVersions: Array<PageVersion> = []
        let cursor: string | undefined
        let iterations = 0

        do {
          if (iterations >= MAX_PAGINATION_ITERATIONS) {
            return yield* Effect.fail(
              new ApiError({
                status: 0,
                message: `Pagination limit exceeded: more than ${MAX_PAGINATION_ITERATIONS} pages of versions`,
                endpoint: `/pages/${id}/versions`,
                pageId: id
              })
            )
          }

          const response = yield* toEffect(apiClient.v2.client.GET("/pages/{id}/versions", {
            params: {
              path: { id: Number(id) },
              query: {
                ...(options?.includeBody ? { "body-format": ATLAS_DOC_FORMAT } : {}),
                ...(cursor ? { cursor } : {}),
                limit: VERSIONS_PAGE_SIZE
              }
            }
          })).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${id}/versions`, id)),
            Effect.retry(rateLimitRetry),
            Effect.mapError((e) => normalizeConfluenceError(e, `/pages/${id}/versions`, id)),
            Effect.flatMap((rawResponse) => decodeVersionsResponse(rawResponse, `/pages/${id}/versions`, id))
          )

          for (const version of response.results) {
            if (options?.since === undefined || (version.number ?? 0) > options.since) {
              allVersions.push(version)
            }
          }

          cursor = response._links?.next
            ? new URL(response._links.next, config.baseUrl).searchParams.get("cursor") ?? undefined
            : undefined

          iterations++
        } while (cursor)

        return allVersions
      })

    const getUser = (accountId: string): Effect.Effect<AtlassianUser, ApiError | RateLimitError> =>
      toEffect(apiClient.v1.client.GET("/wiki/rest/api/user", {
        params: { query: { accountId } }
      })).pipe(
        Effect.mapError((e) => mapApiError(e, `/user?accountId=${accountId}`)),
        Effect.retry(rateLimitRetry),
        Effect.mapError((e) => normalizeConfluenceError(e, `/user?accountId=${accountId}`)),
        Effect.flatMap((response) => decodeAtlassianUser(response, `/user?accountId=${accountId}`))
      )

    const getSpaceId = (pageId: PageId): Effect.Effect<string, ApiError | RateLimitError> =>
      Effect.gen(function*() {
        const page = yield* getPage(pageId)
        if (!page.spaceId) {
          return yield* Effect.fail(
            new ApiError({
              status: 0,
              message: `Page ${pageId} does not have spaceId`,
              endpoint: `/pages/${pageId}`,
              pageId
            })
          )
        }
        return page.spaceId
      })

    const setEditorVersion = (pageId: PageId, version: "v1" | "v2"): Effect.Effect<void, ApiError | RateLimitError> =>
      Effect.gen(function*() {
        // Try to get existing property by key, treat 404 as "not exists"
        const existing = yield* toEffect(apiClient.v2.client.GET("/pages/{page-id}/properties", {
          params: { path: { "page-id": Number(pageId) }, query: { key: "editor" } }
        })).pipe(
          Effect.map(firstEditorProperty),
          Effect.catchIf(
            (e: unknown) => {
              const record = recordOrNull(e)
              return record?._tag === "FetchClientError" && record["status"] === 404
            },
            () => Effect.succeed(undefined)
          ),
          Effect.mapError((e) => mapApiError(e, `/pages/${pageId}/properties?key=editor`, pageId))
        )

        if (existing?.id) {
          // Update existing property
          const nextVersion = (existing.version?.number ?? 0) + 1
          yield* toEffect(apiClient.v2.client.PUT("/pages/{page-id}/properties/{property-id}", {
            params: {
              path: { "page-id": Number(pageId), "property-id": Number(existing.id) }
            },
            body: { key: "editor", value: version, version: { number: nextVersion } }
          })).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${pageId}/properties/editor`, pageId))
          )
        } else {
          // Create new property
          yield* toEffect(apiClient.v2.client.POST("/pages/{page-id}/properties", {
            params: { path: { "page-id": Number(pageId) } },
            body: { key: "editor", value: version }
          })).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${pageId}/properties/editor`, pageId))
          )
        }
      }).pipe(
        Effect.retry(rateLimitRetry),
        Effect.mapError((e) => normalizeConfluenceError(e, `/pages/${pageId}/properties/editor`, pageId))
      )

    return ConfluenceClient.of({
      getPage,
      getChildren,
      getAllChildren,
      createPage,
      updatePage,
      deletePage,
      getPageVersions,
      getUser,
      getSpaceId,
      setEditorVersion
    })
  })

/**
 * Layer that provides ConfluenceClient with direct configuration.
 *
 * @example
 * ```typescript
 * import { ConfluenceClient } from "@knpkv/confluence-to-markdown/ConfluenceClient"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* ConfluenceClient
 *   const page = yield* client.getPage("12345")
 *   console.log(page.title)
 * })
 *
 * Effect.runPromise(
 *   program.pipe(
 *     Effect.provide(ConfluenceClient.layer({
 *       baseUrl: "https://yoursite.atlassian.net",
 *       auth: {
 *         type: "token",
 *         email: "you@example.com",
 *         token: "<api-token>"
 *       }
 *     }))
 *   )
 * )
 * ```
 *
 * @category Layers
 */
export const layer = (
  config: ConfluenceClientConfig
): Layer.Layer<ConfluenceClient> => Layer.effect(ConfluenceClient, make(config))
