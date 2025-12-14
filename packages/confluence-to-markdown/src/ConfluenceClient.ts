/**
 * Confluence REST API v2 client service.
 *
 * Wraps @knpkv/confluence-api-client with rate limit retry logic and pagination helpers.
 *
 * @module
 */
import * as HttpClient from "@effect/platform/HttpClient"
import {
  ConfluenceApiClient,
  ConfluenceApiConfig,
  type V1ApiError,
  type V2ApiError
} from "@knpkv/confluence-api-client"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import type { PageId, SpaceId } from "./Brand.js"
import type { RateLimitError } from "./ConfluenceError.js"
import { ApiError } from "./ConfluenceError.js"
import type {
  AtlassianUser,
  PageChildrenResponse,
  PageListItem,
  PageResponse,
  PageVersion,
  SpacesResponse
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

    /**
     * Get all spaces the user has access to.
     */
    readonly getSpaces: (options?: {
      type?: "global" | "collaboration" | "knowledge_base" | "personal"
    }) => Effect.Effect<SpacesResponse, ApiError | RateLimitError>

    /**
     * Get root pages in a space.
     */
    readonly getRootPagesInSpace: (
      spaceId: SpaceId
    ) => Effect.Effect<ReadonlyArray<PageListItem>, ApiError | RateLimitError>
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
const mapApiError = (error: V1ApiError | V2ApiError, endpoint: string, pageId?: string): ApiError =>
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

    const apiClient = yield* ConfluenceApiClient.pipe(
      Effect.provide(ConfluenceApiClient.layer),
      Effect.provide(apiConfigLayer),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, httpClient))
    )

    const getPage = (id: PageId): Effect.Effect<PageResponse, ApiError | RateLimitError> =>
      apiClient.v2.getPageById(id, { bodyFormat: "storage" }).pipe(
        Effect.mapError((e) => mapApiError(e, `/pages/${id}`, id)),
        Effect.retry(rateLimitSchedule)
      ) as Effect.Effect<PageResponse, ApiError | RateLimitError>

    const getChildren = (id: PageId): Effect.Effect<PageChildrenResponse, ApiError | RateLimitError> =>
      apiClient.v2.getPageChildren(id, { bodyFormat: "storage" }).pipe(
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

          const response = yield* apiClient.v2.getPageChildren(id, {
            bodyFormat: "storage",
            cursor
          }).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${id}/children`, id)),
            Effect.retry(rateLimitSchedule)
          )

          for (const child of response.results) {
            allChildren.push(child as PageListItem)
          }

          cursor = response._links?.next
            ? new URL(response._links.next, config.baseUrl).searchParams.get("cursor") ?? undefined
            : undefined

          iterations++
        } while (cursor)

        return allChildren
      })

    const createPage = (req: CreatePageRequest): Effect.Effect<PageResponse, ApiError | RateLimitError> =>
      apiClient.v2.createPage(req).pipe(
        Effect.mapError((e) => mapApiError(e, "/pages")),
        Effect.retry(rateLimitSchedule)
      ) as Effect.Effect<PageResponse, ApiError | RateLimitError>

    const updatePage = (req: UpdatePageRequest): Effect.Effect<PageResponse, ApiError | RateLimitError> =>
      apiClient.v2.updatePage(req.id, req).pipe(
        Effect.mapError((e) => mapApiError(e, `/pages/${req.id}`, req.id)),
        Effect.retry(rateLimitSchedule)
      ) as Effect.Effect<PageResponse, ApiError | RateLimitError>

    const deletePage = (id: PageId): Effect.Effect<void, ApiError | RateLimitError> =>
      apiClient.v2.deletePage(id).pipe(
        Effect.mapError((e) => mapApiError(e, `/pages/${id}`, id)),
        Effect.retry(rateLimitSchedule)
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

          const response = yield* apiClient.v2.getPageVersions(id, {
            bodyFormat: options?.includeBody ? "storage" : undefined,
            cursor,
            limit: VERSIONS_PAGE_SIZE
          }).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${id}/versions`, id)),
            Effect.retry(rateLimitSchedule)
          )

          for (const version of response.results) {
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
        const propertyVersion = yield* apiClient.v1.getContentProperty(pageId, "editor").pipe(
          Effect.map((prop) => prop.version.number + 1),
          Effect.catchIf(
            (e) => e.status === 404,
            () => Effect.succeed(1)
          ),
          Effect.mapError((e) => mapApiError(e, `/content/${pageId}/property/editor`, pageId))
        )

        const payload = {
          key: "editor",
          value: version,
          version: { number: propertyVersion }
        }

        if (propertyVersion === 1) {
          yield* apiClient.v1.createContentProperty(pageId, { payload }).pipe(
            Effect.mapError((e) => mapApiError(e, `/content/${pageId}/property/editor`, pageId))
          )
        } else {
          yield* apiClient.v1.updateContentProperty(pageId, "editor", { payload }).pipe(
            Effect.mapError((e) => mapApiError(e, `/content/${pageId}/property/editor`, pageId))
          )
        }
      }).pipe(Effect.retry(rateLimitSchedule))

    const getSpaces = (
      options?: { type?: "global" | "collaboration" | "knowledge_base" | "personal" }
    ): Effect.Effect<SpacesResponse, ApiError | RateLimitError> =>
      apiClient.v2.getSpaces({
        type: options?.type,
        status: "current",
        limit: 250
      }).pipe(
        Effect.mapError((e) => mapApiError(e, "/spaces")),
        Effect.retry(rateLimitSchedule)
      ) as Effect.Effect<SpacesResponse, ApiError | RateLimitError>

    const getRootPagesInSpace = (
      spaceId: SpaceId
    ): Effect.Effect<ReadonlyArray<PageListItem>, ApiError | RateLimitError> =>
      apiClient.v2.getPagesInSpace(spaceId, {
        depth: "root",
        limit: 250
      }).pipe(
        Effect.map((r) => r.results as ReadonlyArray<PageListItem>),
        Effect.mapError((e) => mapApiError(e, `/spaces/${spaceId}/pages`)),
        Effect.retry(rateLimitSchedule)
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
      setEditorVersion,
      getSpaces,
      getRootPagesInSpace
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
