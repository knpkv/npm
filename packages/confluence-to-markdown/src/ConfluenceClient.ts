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
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type { PageId } from "./Brand.js"
import type { RateLimitError } from "./ConfluenceError.js"
import { ApiError } from "./ConfluenceError.js"
import type {
  AtlassianUser,
  AttachmentReference,
  PageChildrenResponse,
  PageListItem,
  PageResponse,
  PageVersion
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

export interface UploadAttachmentInput {
  readonly filePath: string
  readonly filename?: string | undefined
  readonly mediaType?: string | undefined
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
     * Get attachments for a page.
     */
    readonly getPageAttachments: (
      id: PageId
    ) => Effect.Effect<ReadonlyArray<AttachmentReference>, ApiError | RateLimitError>

    /**
     * Upload or update an attachment on a page.
     */
    readonly uploadAttachmentToPage: (
      pageId: PageId,
      input: UploadAttachmentInput
    ) => Effect.Effect<AttachmentReference, ApiError | RateLimitError, FileSystem.FileSystem | Path.Path>

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

const isTransientApiError = (error: unknown): boolean => {
  if (Predicate.isTagged(error, "RateLimitError")) return true
  if (!Predicate.isTagged(error, "ApiError")) return false

  const status = (error as { readonly status?: unknown }).status
  return typeof status === "number" && (status === 0 || status === 408 || status === 429 || status >= 500)
}

/** @internal */
export const isConfluenceReadRetryError = isTransientApiError

/** @internal */
export const isConfluenceWriteRetryError = (error: unknown): boolean => {
  if (Predicate.isTagged(error, "RateLimitError")) return true
  if (!Predicate.isTagged(error, "ApiError")) return false

  const status = (error as { readonly status?: unknown }).status
  return status === 429
}

/**
 * Retry schedule for transient Confluence read failures.
 */
const readRequestRetry = {
  schedule: Schedule.exponential("1 second"),
  times: 3,
  while: isConfluenceReadRetryError
} as const

/**
 * Retry schedule for Confluence writes. Non-idempotent writes are retried only
 * when Atlassian explicitly rate-limits the request.
 */
const writeRequestRetry = {
  schedule: Schedule.spaced("30 seconds"),
  times: 3,
  while: isConfluenceWriteRetryError
} as const

/**
 * Map API client errors to domain errors.
 */
const mapApiError = (error: FetchClientError, endpoint: string, pageId?: string): ApiError =>
  new ApiError({
    status: error.status,
    message: `Confluence API request failed (${error.status}) ${endpoint}: ${error.message}`,
    endpoint,
    ...(pageId !== undefined && { pageId })
  })

interface AttachmentResponseLinks {
  readonly download?: string | undefined
  readonly downloadLink?: string | undefined
  readonly base?: string | undefined
  readonly context?: string | undefined
}

const trimTrailingSlash = (value: string): string => value.endsWith("/") ? value.slice(0, -1) : value

/** @internal */
export const makeConfluenceAttachmentUrl = (
  siteBaseUrl: string,
  href: string,
  links?: AttachmentResponseLinks | undefined
): string => {
  if (href.startsWith("http://") || href.startsWith("https://")) return href

  const context = links?.context && links.context !== "/" ? trimTrailingSlash(links.context) : undefined
  if (context && href.startsWith("/") && href !== context && !href.startsWith(`${context}/`)) {
    return new URL(`${context}${href}`, siteBaseUrl).toString()
  }

  const baseUrl = links?.base ?? siteBaseUrl
  if (href.startsWith("/")) {
    const base = new URL(baseUrl)
    const basePath = base.pathname === "/" ? undefined : trimTrailingSlash(base.pathname)
    if (basePath && href !== basePath && !href.startsWith(`${basePath}/`)) {
      return new URL(`${basePath}${href}`, base.origin).toString()
    }
    return new URL(href, base.origin).toString()
  }

  return new URL(href, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString()
}

const AttachmentResponseSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  filename: Schema.optional(Schema.String),
  downloadLink: Schema.optional(Schema.String),
  mediaType: Schema.optional(Schema.NullOr(Schema.String)),
  fileSize: Schema.optional(Schema.NullOr(Schema.Number)),
  size: Schema.optional(Schema.NullOr(Schema.Number)),
  fileId: Schema.optional(Schema.String),
  collectionName: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Struct({
    mediaType: Schema.optional(Schema.NullOr(Schema.String))
  })),
  extensions: Schema.optional(Schema.Struct({
    mediaType: Schema.optional(Schema.NullOr(Schema.String)),
    fileSize: Schema.optional(Schema.NullOr(Schema.Number)),
    fileId: Schema.optional(Schema.String),
    collectionName: Schema.optional(Schema.String)
  })),
  _links: Schema.optional(Schema.Struct({
    download: Schema.optional(Schema.String),
    downloadLink: Schema.optional(Schema.String),
    base: Schema.optional(Schema.String),
    context: Schema.optional(Schema.String)
  }))
})

const decodeAttachment = (
  raw: unknown,
  baseUrl: string,
  endpoint: string,
  pageId?: string
): Effect.Effect<AttachmentReference, ApiError> =>
  Schema.decodeUnknownEffect(AttachmentResponseSchema)(raw).pipe(
    Effect.mapError((cause) =>
      new ApiError({
        status: 0,
        message: `Confluence returned an invalid attachment response for ${endpoint}: ${cause}`,
        endpoint,
        ...(pageId !== undefined ? { pageId } : {})
      })
    ),
    Effect.flatMap((record) => {
      const download = record.downloadLink ?? record._links?.download ?? record._links?.downloadLink
      const filename = record.title ?? record.filename
      if (record.id.length === 0 || !filename || !download) {
        return Effect.fail(
          new ApiError({
            status: 0,
            message: `Confluence returned an attachment without id, filename, or download URL for ${endpoint}`,
            endpoint,
            ...(pageId !== undefined ? { pageId } : {})
          })
        )
      }
      const mediaType = record.mediaType ?? record.metadata?.mediaType ?? record.extensions?.mediaType ?? null
      const size = record.fileSize ?? record.size ?? record.extensions?.fileSize ?? null
      const fileId = record.fileId ?? record.extensions?.fileId
      const collectionName = record.collectionName ?? record.extensions?.collectionName
      return Effect.succeed({
        id: record.id,
        filename,
        url: makeConfluenceAttachmentUrl(baseUrl, download, record._links),
        mediaType,
        size,
        ...(fileId ? { fileId } : {}),
        ...(collectionName ? { collectionName } : {})
      })
    })
  )

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
        Effect.retry(readRequestRetry)
      ) as Effect.Effect<PageResponse, ApiError | RateLimitError>

    const getChildren = (id: PageId): Effect.Effect<PageChildrenResponse, ApiError | RateLimitError> =>
      toEffect(apiClient.v2.client.GET("/pages/{id}/children", {
        params: { path: { id: Number(id) } }
      })).pipe(
        Effect.mapError((e) => mapApiError(e, `/pages/${id}/children`, id)),
        Effect.retry(readRequestRetry)
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
            Effect.retry(readRequestRetry)
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
        Effect.retry(writeRequestRetry)
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
        Effect.retry(writeRequestRetry)
      ) as Effect.Effect<PageResponse, ApiError | RateLimitError>

    const deletePage = (id: PageId): Effect.Effect<void, ApiError | RateLimitError> =>
      toEffect(apiClient.v2.client.DELETE("/pages/{id}", {
        params: { path: { id: Number(id) } }
      })).pipe(
        Effect.map(() => void 0),
        Effect.mapError((e) => mapApiError(e, `/pages/${id}`, id)),
        Effect.retry(writeRequestRetry)
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
            Effect.retry(readRequestRetry)
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

    const getPageAttachments = (
      id: PageId
    ): Effect.Effect<ReadonlyArray<AttachmentReference>, ApiError | RateLimitError> =>
      Effect.gen(function*() {
        const allAttachments: Array<AttachmentReference> = []
        let cursor: string | undefined
        let iterations = 0

        do {
          if (iterations >= MAX_PAGINATION_ITERATIONS) {
            return yield* Effect.fail(
              new ApiError({
                status: 0,
                message: `Pagination limit exceeded: more than ${MAX_PAGINATION_ITERATIONS} pages of attachments`,
                endpoint: `/pages/${id}/attachments`,
                pageId: id
              })
            )
          }

          const response = yield* toEffect(apiClient.v2.client.GET("/pages/{id}/attachments", {
            params: { path: { id: Number(id) }, query: { ...(cursor ? { cursor } : {}), limit: 50 } }
          })).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${id}/attachments`, id)),
            Effect.retry(readRequestRetry)
          )

          for (const attachment of (response as { results?: Array<unknown> }).results ?? []) {
            allAttachments.push(yield* decodeAttachment(attachment, config.baseUrl, `/pages/${id}/attachments`, id))
          }

          cursor = (response as { _links?: { next?: string } })._links?.next
            ? new URL((response as { _links: { next: string } })._links.next, config.baseUrl).searchParams.get(
              "cursor"
            ) ?? undefined
            : undefined

          iterations++
        } while (cursor)

        return allAttachments
      })

    const uploadAttachmentToPage = (
      pageId: PageId,
      input: UploadAttachmentInput
    ): Effect.Effect<AttachmentReference, ApiError | RateLimitError, FileSystem.FileSystem | Path.Path> =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const bytes = yield* fs.readFile(input.filePath).pipe(
          Effect.mapError((cause) =>
            new ApiError({
              status: 0,
              message: `Failed to read attachment file ${input.filePath}: ${cause}`,
              endpoint: `/wiki/rest/api/content/${pageId}/child/attachment`,
              pageId
            })
          )
        )
        const buffer = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(buffer).set(bytes)
        const filename = input.filename ?? path.basename(input.filePath)
        const form = new FormData()
        form.append("file", new Blob([buffer], input.mediaType ? { type: input.mediaType } : undefined), filename)
        form.append("minorEdit", "true")

        const response = yield* toEffect(apiClient.v1.client.PUT("/wiki/rest/api/content/{id}/child/attachment", {
          params: { path: { id: pageId }, query: { status: "current" } },
          headers: { "X-Atlassian-Token": "nocheck" },
          body: form as never
        })).pipe(
          Effect.mapError((e) => mapApiError(e, `/wiki/rest/api/content/${pageId}/child/attachment`, pageId)),
          Effect.retry(writeRequestRetry)
        )

        const attachment = extractUploadedAttachment(response)
        if (attachment === null) {
          return yield* Effect.fail(
            new ApiError({
              status: 0,
              message: `Confluence did not return an attachment for ${filename}`,
              endpoint: `/wiki/rest/api/content/${pageId}/child/attachment`,
              pageId
            })
          )
        }
        const decodedAttachment = yield* decodeAttachment(
          attachment,
          config.baseUrl,
          `/wiki/rest/api/content/${pageId}/child/attachment`,
          pageId
        )
        return yield* getPageAttachments(pageId).pipe(
          Effect.map((attachments) =>
            attachments.find((candidate) =>
              candidate.id === decodedAttachment.id ||
              (candidate.filename === decodedAttachment.filename && candidate.fileId !== undefined)
            ) ?? decodedAttachment
          ),
          Effect.catchCause(() => Effect.succeed(decodedAttachment))
        )
      })

    const getUser = (accountId: string): Effect.Effect<AtlassianUser, ApiError | RateLimitError> =>
      toEffect(apiClient.v1.client.GET("/wiki/rest/api/user", {
        params: { query: { accountId } }
      })).pipe(
        Effect.mapError((e) => mapApiError(e, `/user?accountId=${accountId}`)),
        Effect.retry(readRequestRetry)
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
      }).pipe(Effect.retry(writeRequestRetry))

    return ConfluenceClient.of({
      getPage,
      getChildren,
      getAllChildren,
      createPage,
      updatePage,
      deletePage,
      getPageVersions,
      getPageAttachments,
      uploadAttachmentToPage,
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
export const layer = (config: ConfluenceClientConfig): Layer.Layer<ConfluenceClient> =>
  Layer.effect(ConfluenceClient, make(config))

const extractUploadedAttachment = (response: unknown): unknown | null => {
  if (response !== null && typeof response === "object") {
    const record = response as Record<string, unknown>
    const results = record["results"]
    if (Array.isArray(results) && results[0] !== undefined) return results[0]
    const page = record["page"]
    if (Array.isArray(page) && page[0] !== undefined) return page[0]
  }
  return null
}
