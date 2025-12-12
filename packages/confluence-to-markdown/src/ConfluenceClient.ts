/**
 * Confluence REST API v2 client service.
 *
 * Wraps @knpkv/confluence-api-client with rate limit retry logic and pagination helpers.
 *
 * @module
 */
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import { ConfluenceApiClient, ConfluenceApiConfig } from "@knpkv/confluence-api-client"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import type { PageId } from "./Brand.js"
import type { RateLimitError } from "./ConfluenceError.js"
import { ApiError } from "./ConfluenceError.js"
import type { AtlassianUser, PageChildrenResponse, PageListItem, PageResponse, PageVersion } from "./Schemas.js"

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
    readonly representation: "storage"
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
    readonly representation: "storage"
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
export class ConfluenceClient extends Context.Tag(
  "@knpkv/confluence-to-markdown/ConfluenceClient"
)<
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
     * Uses V1 API to set page property.
     */
    readonly setEditorVersion: (pageId: PageId, version: "v1" | "v2") => Effect.Effect<void, ApiError | RateLimitError>
  }
>() {}

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

/**
 * Rate limit retry schedule with exponential backoff.
 */
const rateLimitSchedule = Schedule.exponential("1 second").pipe(
  Schedule.union(Schedule.spaced("30 seconds")),
  Schedule.whileInput<RateLimitError | ApiError>((error) => error._tag === "RateLimitError"),
  Schedule.intersect(Schedule.recurs(3))
)

/**
 * Map API client errors to domain errors.
 */
const mapApiError = (error: unknown, endpoint: string, pageId?: string): ApiError => {
  if (error instanceof Error) {
    // Extract status from error if available
    const status = (error as { response?: { status?: number } }).response?.status ?? 0
    return new ApiError({
      status,
      message: error.message,
      endpoint,
      ...(pageId !== undefined && { pageId })
    })
  }
  return new ApiError({
    status: 0,
    message: String(error),
    endpoint,
    ...(pageId !== undefined && { pageId })
  })
}

/**
 * Check if an error is a 404 response.
 */
const is404Error = (error: unknown): boolean => {
  if (error instanceof Error) {
    const status = (error as { response?: { status?: number } }).response?.status
    return status === 404
  }
  return false
}

/**
 * Create the Confluence client service.
 */
const make = (
  config: ConfluenceClientConfig
): Effect.Effect<Context.Tag.Service<typeof ConfluenceClient>, never, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    // Create underlying API client
    const apiConfigLayer = Layer.succeed(ConfluenceApiConfig, {
      baseUrl: config.baseUrl,
      auth: config.auth.type === "token"
        ? { type: "basic", email: config.auth.email, apiToken: Redacted.make(config.auth.token) }
        : { type: "oauth2", accessToken: Redacted.make(config.auth.accessToken), cloudId: config.auth.cloudId }
    })

    const httpClient = yield* HttpClient.HttpClient

    // Build auth header for raw HTTP calls
    const authHeader = config.auth.type === "token"
      ? `Basic ${Buffer.from(`${config.auth.email}:${config.auth.token}`).toString("base64")}`
      : `Bearer ${config.auth.accessToken}`

    // Base URL for v2 API
    const v2BaseUrl = config.auth.type === "oauth2"
      ? `https://api.atlassian.com/ex/confluence/${config.auth.cloudId}/wiki/api/v2`
      : `${config.baseUrl}/wiki/api/v2`

    const apiClient = yield* ConfluenceApiClient.pipe(
      Effect.provide(ConfluenceApiClient.layer),
      Effect.provide(apiConfigLayer),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, httpClient))
    )

    const getPage = (id: PageId): Effect.Effect<PageResponse, ApiError | RateLimitError> =>
      apiClient.v2.getPageById(id, { "body-format": "storage" }).pipe(
        Effect.mapError((e) => mapApiError(e, `/pages/${id}`, id)),
        Effect.retry(rateLimitSchedule)
      ) as Effect.Effect<PageResponse, ApiError | RateLimitError>

    const getChildren = (id: PageId): Effect.Effect<PageChildrenResponse, ApiError | RateLimitError> =>
      apiClient.v2.getChildPages(id).pipe(
        Effect.mapError((e) => mapApiError(e, `/pages/${id}/children`, id)),
        Effect.retry(rateLimitSchedule)
      ) as Effect.Effect<PageChildrenResponse, ApiError | RateLimitError>

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

          const response = yield* apiClient.v2.getChildPages(id, {
            cursor
          }).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${id}/children`, id)),
            Effect.retry(rateLimitSchedule)
          )

          for (const child of response.results ?? []) {
            allChildren.push(child as PageListItem)
          }

          cursor = response._links?.next
            ? new URL(response._links.next, config.baseUrl).searchParams.get("cursor") ?? undefined
            : undefined

          iterations++
        } while (cursor)

        return allChildren
      })

    // Use raw HTTP calls for createPage/updatePage since openapi-gen doesn't generate request bodies
    const createPage = (req: CreatePageRequest): Effect.Effect<PageResponse, ApiError | RateLimitError> =>
      Effect.gen(function*() {
        const request = HttpClientRequest.post(`${v2BaseUrl}/pages`).pipe(
          HttpClientRequest.setHeader("Authorization", authHeader),
          HttpClientRequest.setHeader("Accept", "application/json"),
          HttpClientRequest.setHeader("Content-Type", "application/json"),
          HttpClientRequest.bodyUnsafeJson(req)
        )
        const response = yield* httpClient.execute(request).pipe(
          Effect.mapError((e) => mapApiError(e, "/pages"))
        )
        if (response.status >= 400) {
          return yield* Effect.fail(
            new ApiError({
              status: response.status,
              message: `Create page failed with status ${response.status}`,
              endpoint: "/pages"
            })
          )
        }
        const body = yield* response.json.pipe(
          Effect.mapError((e) => mapApiError(e, "/pages"))
        )
        return body as PageResponse
      }).pipe(Effect.retry(rateLimitSchedule))

    const updatePage = (req: UpdatePageRequest): Effect.Effect<PageResponse, ApiError | RateLimitError> =>
      Effect.gen(function*() {
        const request = HttpClientRequest.put(`${v2BaseUrl}/pages/${req.id}`).pipe(
          HttpClientRequest.setHeader("Authorization", authHeader),
          HttpClientRequest.setHeader("Accept", "application/json"),
          HttpClientRequest.setHeader("Content-Type", "application/json"),
          HttpClientRequest.bodyUnsafeJson(req)
        )
        const response = yield* httpClient.execute(request).pipe(
          Effect.mapError((e) => mapApiError(e, `/pages/${req.id}`, req.id))
        )
        if (response.status >= 400) {
          return yield* Effect.fail(
            new ApiError({
              status: response.status,
              message: `Update page failed with status ${response.status}`,
              endpoint: `/pages/${req.id}`,
              pageId: req.id
            })
          )
        }
        const body = yield* response.json.pipe(
          Effect.mapError((e) => mapApiError(e, `/pages/${req.id}`, req.id))
        )
        return body as PageResponse
      }).pipe(Effect.retry(rateLimitSchedule))

    // Use raw HTTP call for deletePage since generated code doesn't handle 204 properly
    const deletePage = (id: PageId): Effect.Effect<void, ApiError | RateLimitError> =>
      Effect.gen(function*() {
        const request = HttpClientRequest.del(`${v2BaseUrl}/pages/${id}`).pipe(
          HttpClientRequest.setHeader("Authorization", authHeader),
          HttpClientRequest.setHeader("Accept", "application/json")
        )
        const response = yield* httpClient.execute(request).pipe(
          Effect.mapError((e) => mapApiError(e, `/pages/${id}`, id))
        )
        if (response.status >= 400) {
          return yield* Effect.fail(
            new ApiError({
              status: response.status,
              message: `Delete page failed with status ${response.status}`,
              endpoint: `/pages/${id}`,
              pageId: id
            })
          )
        }
        // 204 No Content is success
      }).pipe(Effect.retry(rateLimitSchedule))

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

          const response = yield* apiClient.v2.getPageVersions(id, {
            "body-format": options?.includeBody ? "storage" : undefined,
            cursor,
            limit: VERSIONS_PAGE_SIZE
          }).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${id}/versions`, id)),
            Effect.retry(rateLimitSchedule)
          )

          for (const version of response.results ?? []) {
            if (options?.since === undefined || (version.number ?? 0) > options.since) {
              allVersions.push(version as PageVersion)
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
      apiClient.v1.getUser({ accountId }).pipe(
        Effect.mapError((e) => mapApiError(e, `/user?accountId=${accountId}`)),
        Effect.retry(rateLimitSchedule)
      ) as Effect.Effect<AtlassianUser, ApiError | RateLimitError>

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
        // Try to get current property version, only treat 404 as "not exists"
        const propertyVersion = yield* apiClient.v2.getPageContentPropertiesById(pageId, "editor").pipe(
          Effect.map((prop) => (prop.version?.number ?? 0) + 1),
          Effect.catchIf(is404Error, () => Effect.succeed(1)),
          Effect.mapError((e) => mapApiError(e, `/pages/${pageId}/properties/editor`, pageId))
        )

        // The v2 API takes the property payload as the body.
        // Schema only defines key/version but API accepts value too.
        const payload = {
          key: "editor",
          value: version,
          version: { number: propertyVersion }
        } as Record<string, unknown>

        if (propertyVersion === 1) {
          yield* apiClient.v2.createPageProperty(pageId, payload as never).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${pageId}/properties`, pageId))
          )
        } else {
          yield* apiClient.v2.updatePagePropertyById(pageId, "editor", payload as never).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${pageId}/properties/editor`, pageId))
          )
        }
      }).pipe(Effect.retry(rateLimitSchedule))

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
 * import { NodeHttpClient } from "@effect/platform-node"
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
 *         token: process.env.CONFLUENCE_API_KEY
 *       }
 *     })),
 *     Effect.provide(NodeHttpClient.layer)
 *   )
 * )
 * ```
 *
 * @category Layers
 */
export const layer = (
  config: ConfluenceClientConfig
): Layer.Layer<ConfluenceClient, never, HttpClient.HttpClient> => Layer.effect(ConfluenceClient, make(config))
