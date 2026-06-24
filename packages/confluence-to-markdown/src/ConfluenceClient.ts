/**
 * Confluence REST API v2 client service.
 *
 * Wraps @knpkv/confluence-api-client with rate limit retry logic and pagination helpers.
 *
 * @module
 */
import { ConfluenceApiClient, ConfluenceApiConfig, type FetchClientError, toEffect } from "@knpkv/confluence-api-client"
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

/**
 * Rate limit retry schedule with exponential backoff.
 */
const rateLimitRetry = {
  schedule: Schedule.exponential("1 second").pipe(
    Schedule.either(Schedule.spaced("30 seconds"))
  ),
  times: 3,
  while: (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "RateLimitError"
} as const

/**
 * Map API client errors to domain errors.
 */
const mapApiError = (error: FetchClientError, endpoint: string, pageId?: string): ApiError =>
  new ApiError({
    status: error.status,
    message: error.message,
    endpoint,
    ...(pageId !== undefined && { pageId })
  })

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
        params: { path: { id: Number(id) }, query: { "body-format": "atlas_doc_format" } }
      })).pipe(
        Effect.mapError((e) => mapApiError(e, `/pages/${id}`, id)),
        Effect.retry(rateLimitRetry)
      ) as Effect.Effect<PageResponse, ApiError | RateLimitError>

    const getChildren = (id: PageId): Effect.Effect<PageChildrenResponse, ApiError | RateLimitError> =>
      toEffect(apiClient.v2.client.GET("/pages/{id}/children", {
        params: { path: { id: Number(id) } }
      })).pipe(
        Effect.mapError((e) => mapApiError(e, `/pages/${id}/children`, id)),
        Effect.retry(rateLimitRetry)
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

          const response = yield* toEffect(apiClient.v2.client.GET("/pages/{id}/children", {
            params: { path: { id: Number(id) }, query: { ...(cursor ? { cursor } : {}) } }
          })).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${id}/children`, id)),
            Effect.retry(rateLimitRetry)
          )

          for (const child of (response as { results?: Array<PageListItem> }).results ?? []) {
            allChildren.push(child)
          }

          cursor = (response as { _links?: { next?: string } })._links?.next
            ? new URL((response as { _links: { next: string } })._links.next, config.baseUrl).searchParams.get(
              "cursor"
            ) ?? undefined
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
        Effect.retry(rateLimitRetry)
      ) as Effect.Effect<PageResponse, ApiError | RateLimitError>

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
        Effect.retry(rateLimitRetry)
      ) as Effect.Effect<PageResponse, ApiError | RateLimitError>

    const deletePage = (id: PageId): Effect.Effect<void, ApiError | RateLimitError> =>
      toEffect(apiClient.v2.client.DELETE("/pages/{id}", {
        params: { path: { id: Number(id) } }
      })).pipe(
        Effect.map(() => void 0),
        Effect.mapError((e) => mapApiError(e, `/pages/${id}`, id)),
        Effect.retry(rateLimitRetry)
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
                ...(options?.includeBody ? { "body-format": "atlas_doc_format" as const } : {}),
                ...(cursor ? { cursor } : {}),
                limit: VERSIONS_PAGE_SIZE
              }
            }
          })).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${id}/versions`, id)),
            Effect.retry(rateLimitRetry)
          )

          for (const version of (response as { results?: Array<PageVersion> }).results ?? []) {
            if (options?.since === undefined || (version.number ?? 0) > options.since) {
              allVersions.push(version)
            }
          }

          cursor = (response as { _links?: { next?: string } })._links?.next
            ? new URL((response as { _links: { next: string } })._links.next, config.baseUrl).searchParams.get(
              "cursor"
            ) ?? undefined
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
        Effect.retry(rateLimitRetry)
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
        // Try to get existing property by key, treat 404 as "not exists"
        const existing = yield* toEffect(apiClient.v2.client.GET("/pages/{page-id}/properties", {
          params: { path: { "page-id": Number(pageId) }, query: { key: "editor" } }
        })).pipe(
          Effect.map((resp) => {
            const results = (resp as { results?: Array<{ id?: string; version?: { number?: number } }> }).results
            return results?.[0]
          }),
          Effect.catchIf(
            (e: FetchClientError) => e.status === 404,
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
      }).pipe(Effect.retry(rateLimitRetry))

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
