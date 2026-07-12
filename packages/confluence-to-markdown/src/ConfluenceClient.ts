/**
 * Confluence REST API v2 client service.
 *
 * Wraps @knpkv/confluence-api-client with rate limit retry logic and pagination helpers.
 *
 * @module
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { ConfluenceApiClient, ConfluenceApiConfig } from "@knpkv/confluence-api-client"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import type { PageId } from "./Brand.js"
import { ApiError, RateLimitError } from "./ConfluenceError.js"
import {
  type AtlassianUser,
  AtlassianUserSchema,
  type AttachmentReference,
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
const ATLAS_DOC_FORMAT: "atlas_doc_format" = "atlas_doc_format"

const recordOrNull = (value: unknown): Record<PropertyKey, unknown> | null => Predicate.isObject(value) ? value : null

const stringOrUndefined = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const numberOrUndefined = (value: unknown): number | undefined => typeof value === "number" ? value : undefined

const isTransientApiError = (error: unknown): boolean => {
  if (Predicate.isTagged(error, "RateLimitError")) return true
  if (!Predicate.isTagged(error, "ApiError")) return false

  const status = numberOrUndefined(recordOrNull(error)?.["status"])
  return typeof status === "number" && (status === 0 || status === 408 || status === 429 || status >= 500)
}

/** @internal */
export const isConfluenceReadRetryError = isTransientApiError

/** @internal */
export const isConfluenceWriteRetryError = (error: unknown): boolean => {
  if (Predicate.isTagged(error, "RateLimitError")) return true
  if (!Predicate.isTagged(error, "ApiError")) return false

  const status = numberOrUndefined(recordOrNull(error)?.["status"])
  return status === 429
}

/**
 * Retry schedule for transient Confluence read failures.
 */
const readRequestRetry: {
  readonly schedule: Schedule.Schedule<unknown, unknown, unknown>
  readonly times: number
  readonly while: (error: unknown) => boolean
} = {
  schedule: Schedule.exponential("1 second"),
  times: 3,
  while: isConfluenceReadRetryError
}

/**
 * Retry schedule for Confluence writes. Non-idempotent writes are retried only
 * when Atlassian explicitly rate-limits the request.
 */
const writeRequestRetry: {
  readonly schedule: Schedule.Schedule<unknown, unknown, unknown>
  readonly times: number
  readonly while: (error: unknown) => boolean
} = {
  schedule: Schedule.spaced("30 seconds"),
  times: 3,
  while: isConfluenceWriteRetryError
}

/**
 * Map API client errors to domain errors.
 */
const mapApiError = (error: unknown, endpoint: string, pageId?: string): ApiError | RateLimitError => {
  const record = recordOrNull(error)
  const response = HttpClientError.isHttpClientError(error)
    ? error.response
    : recordOrNull(record?.["response"])
  const status = response === undefined || response === null
    ? Schema.isSchemaError(error) ? 200 : 0
    : numberOrUndefined(response["status"]) ?? 0
  if (status === 429) {
    return new RateLimitError()
  }
  return new ApiError({
    status,
    message: Predicate.isError(error) ? error.message : String(record?.["cause"] ?? error),
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

const normalizePagePosition = (value: unknown): unknown => {
  if (!Predicate.isObject(value)) return value
  const position = typeof value.position === "number"
    ? value.position
    : typeof value.childPosition === "number"
    ? value.childPosition
    : undefined
  return {
    ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "position" && key !== "childPosition")),
    ...(position === undefined ? {} : { position })
  }
}

const normalizeNullPagePositions = (value: unknown): unknown => {
  if (!Predicate.isObject(value) || !Array.isArray(value.results)) return normalizePagePosition(value)
  return {
    ...value,
    results: value.results.map(normalizePagePosition)
  }
}

const decodePageResponse = (
  value: unknown,
  endpoint: string,
  pageId?: string
): Effect.Effect<PageResponse, ApiError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PageResponseSchema)(normalizePagePosition(value)),
    catch: (cause) => mapDecodeError(cause, endpoint, pageId)
  })

const decodeChildrenResponse = (
  value: unknown,
  endpoint: string,
  pageId?: string
): Effect.Effect<PageChildrenResponse, ApiError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(PageChildrenResponseSchema)(normalizeNullPagePositions(value)),
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
): Effect.Effect<Context.Service.Shape<typeof ConfluenceClient>, never, HttpClient.HttpClient> =>
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
      apiClient.v2.getPageById(id, {
        params: { "body-format": ATLAS_DOC_FORMAT }
      }).pipe(
        Effect.mapError((e) => mapApiError(e, `/pages/${id}`, id)),
        Effect.retry(readRequestRetry),
        Effect.mapError((e) => normalizeConfluenceError(e, `/pages/${id}`, id)),
        Effect.flatMap((response) => decodePageResponse(response, `/pages/${id}`, id))
      )

    const getChildren = (id: PageId): Effect.Effect<PageChildrenResponse, ApiError | RateLimitError> =>
      apiClient.v2.getChildPages(id, undefined).pipe(
        Effect.mapError((e) => mapApiError(e, `/pages/${id}/children`, id)),
        Effect.retry(readRequestRetry),
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

          const response = yield* apiClient.v2.getChildPages(id, {
            params: { ...(cursor ? { cursor } : {}) }
          }).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${id}/children`, id)),
            Effect.retry(readRequestRetry),
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
      apiClient.v2.createPage({
        payload: {
          spaceId: req.spaceId,
          title: req.title,
          ...(req.parentId ? { parentId: req.parentId } : {}),
          body: { representation: req.body.representation, value: req.body.value },
          status: "current"
        }
      }).pipe(
        Effect.mapError((e) => mapApiError(e, "/pages")),
        Effect.retry(writeRequestRetry),
        Effect.mapError((e) => normalizeConfluenceError(e, "/pages")),
        Effect.flatMap((response) => decodePageResponse(response, "/pages"))
      )

    const updatePage = (req: UpdatePageRequest): Effect.Effect<PageResponse, ApiError | RateLimitError> =>
      apiClient.v2.updatePage(req.id, {
        payload: {
          id: req.id,
          title: req.title,
          status: req.status ?? "current",
          body: { representation: req.body.representation, value: req.body.value },
          version: { number: req.version.number, ...(req.version.message ? { message: req.version.message } : {}) }
        }
      }).pipe(
        Effect.mapError((e) => mapApiError(e, `/pages/${req.id}`, req.id)),
        Effect.retry(writeRequestRetry),
        Effect.mapError((e) => normalizeConfluenceError(e, `/pages/${req.id}`, req.id)),
        Effect.flatMap((response) => decodePageResponse(response, `/pages/${req.id}`, req.id))
      )

    const deletePage = (id: PageId): Effect.Effect<void, ApiError | RateLimitError> =>
      apiClient.v2.deletePage(id, undefined).pipe(
        Effect.map(() => void 0),
        Effect.mapError((e) => mapApiError(e, `/pages/${id}`, id)),
        Effect.retry(writeRequestRetry),
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

          const response = yield* apiClient.v2.getPageVersions(id, {
            params: {
              ...(options?.includeBody ? { "body-format": ATLAS_DOC_FORMAT } : {}),
              ...(cursor ? { cursor } : {}),
              limit: VERSIONS_PAGE_SIZE
            }
          }).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${id}/versions`, id)),
            Effect.retry(readRequestRetry),
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

          const response = yield* apiClient.v2.getPageAttachments(id, {
            params: { ...(cursor ? { cursor } : {}), limit: 50 }
          }).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${id}/attachments`, id)),
            Effect.retry(readRequestRetry),
            Effect.mapError((e) => normalizeConfluenceError(e, `/pages/${id}/attachments`, id))
          )

          const responseRecord = recordOrNull(response)
          const results = responseRecord?.["results"]
          if (Array.isArray(results)) {
            for (const attachment of results) {
              allAttachments.push(yield* decodeAttachment(attachment, config.baseUrl, `/pages/${id}/attachments`, id))
            }
          }

          const nextLink = stringOrUndefined(recordOrNull(responseRecord?.["_links"])?.["next"])
          cursor = nextLink
            ? new URL(nextLink, config.baseUrl).searchParams.get("cursor") ?? undefined
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
        const filename = input.filename ?? path.basename(input.filePath)

        const response = yield* apiClient.uploadAttachment(pageId, {
          bytes,
          filename,
          ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType })
        }).pipe(
          Effect.mapError((e) => mapApiError(e, `/wiki/rest/api/content/${pageId}/child/attachment`, pageId)),
          Effect.retry(writeRequestRetry),
          Effect.mapError((e) =>
            normalizeConfluenceError(e, `/wiki/rest/api/content/${pageId}/child/attachment`, pageId)
          )
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
      apiClient.v1.getUser({ params: { accountId } }).pipe(
        Effect.mapError((e) => mapApiError(e, `/user?accountId=${accountId}`)),
        Effect.retry(readRequestRetry),
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
        const existing = yield* apiClient.v2.getPageContentProperties(pageId, {
          params: { key: "editor" }
        }).pipe(
          Effect.map(firstEditorProperty),
          Effect.catchIf(
            (e: unknown) => HttpClientError.isHttpClientError(e) && e.response?.status === 404,
            () => Effect.succeed(undefined)
          ),
          Effect.mapError((e) => mapApiError(e, `/pages/${pageId}/properties?key=editor`, pageId))
        )

        if (existing?.id) {
          // Update existing property
          const nextVersion = (existing.version?.number ?? 0) + 1
          yield* apiClient.v2.updatePagePropertyById(pageId, existing.id, {
            payload: { key: "editor", value: version, version: { number: nextVersion } }
          }).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${pageId}/properties/editor`, pageId))
          )
        } else {
          // Create new property
          yield* apiClient.v2.createPageProperty(pageId, {
            payload: { key: "editor", value: version }
          }).pipe(
            Effect.mapError((e) => mapApiError(e, `/pages/${pageId}/properties/editor`, pageId))
          )
        }
      }).pipe(
        Effect.retry(writeRequestRetry),
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
export const layerWithHttpClient = (
  config: ConfluenceClientConfig
): Layer.Layer<ConfluenceClient, never, HttpClient.HttpClient> => Layer.effect(ConfluenceClient, make(config))

export const layer = (config: ConfluenceClientConfig): Layer.Layer<ConfluenceClient> =>
  layerWithHttpClient(config).pipe(
    Layer.provide(NodeHttpClient.layerFetch)
  )

const extractUploadedAttachment = (response: unknown): unknown | null => {
  const record = recordOrNull(response)
  if (record === null) return null
  const results = record["results"]
  if (Array.isArray(results) && results[0] !== undefined) return results[0]
  const page = record["page"]
  if (Array.isArray(page) && page[0] !== undefined) return page[0]
  return null
}
