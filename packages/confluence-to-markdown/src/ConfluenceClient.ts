/**
 * Confluence REST API v2 client service.
 *
 * @module
 */
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type { PageId } from "./Brand.js"
import { ApiError, RateLimitError } from "./ConfluenceError.js"
import type { AtlassianUser, PageChildrenResponse, PageListItem, PageResponse, PageVersion } from "./Schemas.js"
import {
  AtlassianUserSchema,
  PageChildrenResponseSchema,
  PageResponseSchema,
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

/**
 * Rate limit retry schedule with exponential backoff.
 */
const rateLimitSchedule = Schedule.exponential("1 second").pipe(
  Schedule.union(Schedule.spaced("30 seconds")),
  Schedule.whileInput<RateLimitError | ApiError>((error) => error._tag === "RateLimitError"),
  Schedule.intersect(Schedule.recurs(3))
)

/**
 * Create the Confluence client service.
 */
const make = (
  config: ConfluenceClientConfig
): Effect.Effect<Context.Tag.Service<typeof ConfluenceClient>, never, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const httpClient = yield* HttpClient.HttpClient

    const authHeader = config.auth.type === "token"
      ? `Basic ${Buffer.from(`${config.auth.email}:${config.auth.token}`).toString("base64")}`
      : `Bearer ${config.auth.accessToken}`

    // OAuth uses different API base URL with cloud_id
    const apiBaseUrl = config.auth.type === "oauth2"
      ? `https://api.atlassian.com/ex/confluence/${config.auth.cloudId}/wiki/api/v2`
      : `${config.baseUrl}/wiki/api/v2`

    const baseRequest = HttpClientRequest.get(apiBaseUrl).pipe(
      HttpClientRequest.setHeader("Authorization", authHeader),
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.setHeader("Content-Type", "application/json")
    )

    /**
     * Make an HTTP request to the Confluence API.
     * Returns raw JSON - callers must validate with Schema.decodeUnknown.
     */
    const request = (
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      body?: unknown
    ): Effect.Effect<unknown, ApiError | RateLimitError, never> =>
      Effect.gen(function*() {
        let req = baseRequest.pipe(
          HttpClientRequest.setMethod(method),
          HttpClientRequest.setUrl(`${apiBaseUrl}${path}`)
        )

        if (body !== undefined) {
          req = HttpClientRequest.bodyJson(req, body).pipe(
            Effect.catchAll(() => Effect.succeed(req)),
            Effect.runSync
          )
        }

        const response = yield* httpClient.execute(req).pipe(
          Effect.mapError((error) =>
            new ApiError({
              status: 0,
              message: `Request failed: ${error.message}`,
              endpoint: path
            })
          )
        )

        if (response.status === 429) {
          const retryAfterHeader = response.headers["retry-after"]
          const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined
          return yield* Effect.fail(
            retryAfter !== undefined
              ? new RateLimitError({ retryAfter })
              : new RateLimitError({})
          )
        }

        if (response.status >= 400) {
          const text = yield* response.text.pipe(
            Effect.catchAll(() => Effect.succeed(""))
          )
          const fullUrl = `${apiBaseUrl}${path}`
          return yield* Effect.fail(
            new ApiError({
              status: response.status,
              message: `${text || `HTTP ${response.status}`} [${method} ${fullUrl}]`,
              endpoint: path
            })
          )
        }

        if (method === "DELETE" && response.status === 204) {
          return undefined
        }

        const json = yield* response.json.pipe(
          Effect.mapError((error) =>
            new ApiError({
              status: response.status,
              message: `Failed to parse response: ${error}`,
              endpoint: path
            })
          )
        )

        return json
      }).pipe(
        Effect.retry(rateLimitSchedule)
      )

    const getPage = (id: PageId): Effect.Effect<PageResponse, ApiError | RateLimitError> =>
      Effect.gen(function*() {
        const raw = yield* request(
          "GET",
          `/pages/${id}?body-format=storage`
        )
        return yield* Schema.decodeUnknown(PageResponseSchema)(raw).pipe(
          Effect.mapError((error) =>
            new ApiError({
              status: 0,
              message: `Invalid response schema: ${error.message}`,
              endpoint: `/pages/${id}`,
              pageId: id
            })
          )
        )
      })

    const getChildren = (id: PageId): Effect.Effect<PageChildrenResponse, ApiError | RateLimitError> =>
      Effect.gen(function*() {
        const raw = yield* request(
          "GET",
          `/pages/${id}/children?body-format=storage`
        )
        return yield* Schema.decodeUnknown(PageChildrenResponseSchema)(raw).pipe(
          Effect.mapError((error) =>
            new ApiError({
              status: 0,
              message: `Invalid response schema: ${error.message}`,
              endpoint: `/pages/${id}/children`,
              pageId: id
            })
          )
        )
      })

    const getAllChildren = (id: PageId): Effect.Effect<ReadonlyArray<PageListItem>, ApiError | RateLimitError> =>
      Effect.gen(function*() {
        const allChildren: Array<PageListItem> = []
        let cursor: string | undefined
        let iterations = 0
        const maxIterations = 100 // Prevent unbounded pagination

        do {
          if (iterations >= maxIterations) {
            return yield* Effect.fail(
              new ApiError({
                status: 0,
                message: `Pagination limit exceeded: more than ${maxIterations} pages of children`,
                endpoint: `/pages/${id}/children`,
                pageId: id
              })
            )
          }

          const path = cursor
            ? `/pages/${id}/children?body-format=storage&cursor=${cursor}`
            : `/pages/${id}/children?body-format=storage`

          const raw = yield* request("GET", path)
          const response = yield* Schema.decodeUnknown(PageChildrenResponseSchema)(raw).pipe(
            Effect.mapError((error) =>
              new ApiError({
                status: 0,
                message: `Invalid response schema: ${error.message}`,
                endpoint: path,
                pageId: id
              })
            )
          )

          for (const child of response.results) {
            allChildren.push(child)
          }

          // Extract cursor from next link if present
          cursor = response._links?.next
            ? new URL(response._links.next, config.baseUrl).searchParams.get("cursor") ?? undefined
            : undefined

          iterations++
        } while (cursor)

        return allChildren
      })

    const createPage = (req: CreatePageRequest): Effect.Effect<PageResponse, ApiError | RateLimitError> =>
      Effect.gen(function*() {
        const raw = yield* request("POST", "/pages", req)
        return yield* Schema.decodeUnknown(PageResponseSchema)(raw).pipe(
          Effect.mapError((error) =>
            new ApiError({
              status: 0,
              message: `Invalid response schema: ${error.message}`,
              endpoint: "/pages"
            })
          )
        )
      })

    const updatePage = (req: UpdatePageRequest): Effect.Effect<PageResponse, ApiError | RateLimitError> =>
      Effect.gen(function*() {
        const raw = yield* request("PUT", `/pages/${req.id}`, req)
        return yield* Schema.decodeUnknown(PageResponseSchema)(raw).pipe(
          Effect.mapError((error) =>
            new ApiError({
              status: 0,
              message: `Invalid response schema: ${error.message}`,
              endpoint: `/pages/${req.id}`,
              pageId: req.id
            })
          )
        )
      })

    const deletePage = (id: PageId): Effect.Effect<void, ApiError | RateLimitError> =>
      request("DELETE", `/pages/${id}`).pipe(Effect.asVoid)

    const getPageVersions = (
      id: PageId,
      options?: { since?: number; includeBody?: boolean }
    ): Effect.Effect<ReadonlyArray<PageVersion>, ApiError | RateLimitError> =>
      Effect.gen(function*() {
        const allVersions: Array<PageVersion> = []
        let cursor: string | undefined
        let iterations = 0
        const maxIterations = 100

        do {
          if (iterations >= maxIterations) {
            return yield* Effect.fail(
              new ApiError({
                status: 0,
                message: `Pagination limit exceeded: more than ${maxIterations} pages of versions`,
                endpoint: `/pages/${id}/versions`,
                pageId: id
              })
            )
          }

          let path = `/pages/${id}/versions?limit=50`
          if (options?.includeBody) {
            path += `&body-format=storage`
          }
          if (cursor) {
            path += `&cursor=${cursor}`
          }

          const raw = yield* request("GET", path)
          const response = yield* Schema.decodeUnknown(PageVersionsResponseSchema)(raw).pipe(
            Effect.mapError((error) =>
              new ApiError({
                status: 0,
                message: `Invalid response schema: ${error.message}`,
                endpoint: path,
                pageId: id
              })
            )
          )

          for (const version of response.results) {
            // Filter by since if provided
            if (options?.since === undefined || version.number > options.since) {
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
      Effect.gen(function*() {
        // User API is at /wiki/rest/api (v1), not v2
        const userApiBaseUrl = config.auth.type === "oauth2"
          ? `https://api.atlassian.com/ex/confluence/${config.auth.cloudId}/wiki/rest/api`
          : `${config.baseUrl}/wiki/rest/api`

        const req = HttpClientRequest.get(`${userApiBaseUrl}/user?accountId=${accountId}`).pipe(
          HttpClientRequest.setHeader("Authorization", authHeader),
          HttpClientRequest.setHeader("Accept", "application/json")
        )

        const response = yield* httpClient.execute(req).pipe(
          Effect.mapError((error) =>
            new ApiError({
              status: 0,
              message: `Request failed: ${error.message}`,
              endpoint: `/user?accountId=${accountId}`
            })
          )
        )

        if (response.status >= 400) {
          const text = yield* response.text.pipe(Effect.catchAll(() => Effect.succeed("")))
          return yield* Effect.fail(
            new ApiError({
              status: response.status,
              message: text || `HTTP ${response.status}`,
              endpoint: `/user?accountId=${accountId}`
            })
          )
        }

        const json = yield* response.json.pipe(
          Effect.mapError((error) =>
            new ApiError({
              status: response.status,
              message: `Failed to parse response: ${error}`,
              endpoint: `/user?accountId=${accountId}`
            })
          )
        )

        return yield* Schema.decodeUnknown(AtlassianUserSchema)(json).pipe(
          Effect.mapError((error) =>
            new ApiError({
              status: 0,
              message: `Invalid response schema: ${error.message}`,
              endpoint: `/user?accountId=${accountId}`
            })
          )
        )
      })

    return ConfluenceClient.of({
      getPage,
      getChildren,
      getAllChildren,
      createPage,
      updatePage,
      deletePage,
      getPageVersions,
      getUser
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
