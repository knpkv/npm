/**
 * Narrow Confluence transport boundary used by the Control Center adapter.
 *
 * The generated API owns most HTTP request and wire-schema decoding. It keeps
 * watcher reads narrow because Atlassian can return redacted
 * identities and numeric content IDs that its generated schema rejects. It
 * also owns the revision-guarded page update and translates the open error
 * surface into a small, secret-free transport model.
 *
 * @module
 */
import { ConfluenceApiClient, type ConfluenceApiClientShape } from "@knpkv/confluence-api-client"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import {
  RawConfluenceDraftPage,
  RawConfluencePage,
  RawConfluenceSpacePage,
  RawConfluenceWatcherPage
} from "./ConfluencePageSchemas.js"

const Operation = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))

/** Secret-free failure emitted by the live Confluence transport boundary. @internal */
export class ConfluencePageClientFailure extends Schema.TaggedErrorClass<ConfluencePageClientFailure>()(
  "ConfluencePageClientFailure",
  {
    operation: Operation,
    reason: Schema.Literals([
      "authentication",
      "authorization",
      "conflict",
      "invalid-request",
      "not-found",
      "rate-limit",
      "timeout",
      "malformed-response",
      "outage"
    ]),
    retryAfterSeconds: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400 })))
  }
) {}

/** Minimal provider operations needed for the Confluence page vertical slice. @internal */
export interface ConfluencePageClientShape {
  readonly getCurrentUser: Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly getSystemInfo: Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly getPage: (pageId: string) => Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly getPageDraft: (pageId: string) => Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly getPageVersion: (
    pageId: string,
    version: number
  ) => Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly updatePage: (
    pageId: string,
    input: {
      readonly title: string
      readonly adf: string
      readonly version: number
      readonly versionMessage: string
    }
  ) => Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly createPage: (input: {
    readonly spaceId: string
    readonly title: string
    readonly adf: string
    readonly parentId: string | null
  }) => Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly getSpacePages: (
    spaceId: string,
    cursor: string | null
  ) => Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly getPageAttachments: (
    pageId: string,
    cursor: string | null
  ) => Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly getPageWatchers: (
    pageId: string,
    start: number
  ) => Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly getPageVersions: (
    pageId: string,
    cursor: string | null
  ) => Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly getUsers: (
    accountIds: ReadonlyArray<string>
  ) => Effect.Effect<unknown, ConfluencePageClientFailure>
}

/** Injectable Confluence page client. @internal */
export class ConfluencePageClient extends Context.Service<ConfluencePageClient, ConfluencePageClientShape>()(
  "@knpkv/control-center/internal/ConfluencePageClient"
) {}

const retryAfterSeconds = (error: HttpClientError.HttpClientError): number | null => {
  const response = error.response
  if (response === undefined) return null
  const value = Option.getOrNull(Headers.get(response.headers, "retry-after"))
  if (value === null || !/^\d{1,5}$/u.test(value)) return null
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds <= 86_400 ? seconds : null
}

const translateFailure = (operation: string, cause: unknown): ConfluencePageClientFailure => {
  if (!HttpClientError.isHttpClientError(cause)) {
    return new ConfluencePageClientFailure({
      operation,
      reason: Predicate.isTagged(cause, "TimeoutException")
        ? "timeout"
        : "malformed-response",
      retryAfterSeconds: null
    })
  }
  const status = cause.response?.status
  const reason = status === 401
    ? "authentication"
    : status === 403
    ? "authorization"
    : status === 409
    ? "conflict"
    : status === 400
    ? "invalid-request"
    : status === 404
    ? "not-found"
    : status === 429
    ? "rate-limit"
    : cause.reason._tag === "DecodeError" || cause.reason._tag === "EmptyBodyError"
    ? "malformed-response"
    : "outage"
  return new ConfluencePageClientFailure({
    operation,
    reason,
    retryAfterSeconds: reason === "rate-limit" ? retryAfterSeconds(cause) : null
  })
}

const bounded = <Success, Failure>(
  operation: string,
  effect: Effect.Effect<Success, Failure>
): Effect.Effect<Success, ConfluencePageClientFailure> =>
  effect.pipe(
    Effect.timeout("15 seconds"),
    Effect.mapError((cause) => translateFailure(operation, cause))
  )

/** Build the narrow production boundary from the supported generated client. @internal */
export const makeConfluencePageClient = (
  api: ConfluenceApiClientShape
): ConfluencePageClientShape => ({
  getCurrentUser: bounded("confluence-current-user", api.v1.getCurrentUser(undefined)),
  getSystemInfo: bounded("confluence-system-info", api.v1.getSystemInfo(undefined)),
  getPage: (pageId) =>
    bounded(
      "confluence-page-read",
      // Atlassian returns `parentId: null` for a space homepage even though
      // the generated OpenAPI schema currently models the field as a string.
      // Decode this read at the narrow adapter boundary until the upstream
      // contract describes the documented null case faithfully.
      api.v2.httpClient.execute(
        HttpClientRequest.get(`/pages/${encodeURIComponent(pageId)}`).pipe(
          HttpClientRequest.setUrlParams({
            "body-format": "atlas_doc_format",
            "include-version": true,
            status: ["current"]
          })
        )
      ).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(RawConfluencePage))
      )
    ),
  getPageDraft: (pageId) =>
    bounded(
      "confluence-page-draft-read",
      api.v2.httpClient.execute(
        HttpClientRequest.get(`/pages/${encodeURIComponent(pageId)}`).pipe(
          HttpClientRequest.setUrlParams({
            "body-format": "atlas_doc_format",
            "get-draft": true,
            status: ["draft"]
          })
        )
      ).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(RawConfluenceDraftPage))
      )
    ),
  getPageVersion: (pageId, version) =>
    bounded(
      "confluence-page-version",
      api.v2.getPageVersionDetails(pageId, String(version), undefined)
    ),
  updatePage: (pageId, input) =>
    bounded(
      "confluence-page-update",
      api.v2.httpClient.execute(
        HttpClientRequest.put(`/pages/${encodeURIComponent(pageId)}`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            id: pageId,
            status: "current",
            title: input.title,
            body: {
              representation: "atlas_doc_format",
              value: input.adf
            },
            version: {
              number: input.version,
              message: input.versionMessage
            }
          })
        )
      ).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(RawConfluencePage))
      )
    ),
  createPage: (input) =>
    bounded(
      "confluence-page-create",
      api.v2.createPage({
        payload: {
          spaceId: input.spaceId,
          status: "current",
          title: input.title,
          ...(input.parentId === null ? {} : { parentId: input.parentId }),
          body: {
            representation: "atlas_doc_format",
            value: input.adf
          }
        }
      })
    ),
  getSpacePages: (spaceId, cursor) =>
    bounded(
      "confluence-space-pages",
      api.v2.httpClient.execute(
        HttpClientRequest.get(`/spaces/${encodeURIComponent(spaceId)}/pages`).pipe(
          HttpClientRequest.setUrlParams({
            ...(cursor === null ? {} : { cursor }),
            "body-format": "atlas_doc_format",
            depth: "all",
            limit: 25,
            sort: "-modified-date",
            status: ["current"]
          })
        )
      ).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(RawConfluenceSpacePage))
      )
    ),
  getPageAttachments: (pageId, cursor) =>
    bounded(
      "confluence-page-attachments",
      api.v2.getPageAttachments(pageId, {
        params: {
          ...(cursor === null ? {} : { cursor }),
          limit: 25,
          sort: "-modified-date",
          status: ["current"]
        }
      })
    ),
  getPageWatchers: (pageId, start) =>
    bounded(
      "confluence-page-watchers",
      // Atlassian redacts account IDs and rounds int64 content IDs in JSON, so
      // this endpoint intentionally uses the adapter's more faithful schema.
      api.v1.httpClient.execute(
        HttpClientRequest.get(
          `/wiki/rest/api/content/${encodeURIComponent(pageId)}/notification/child-created`
        ).pipe(HttpClientRequest.setUrlParams({ limit: 50, start }))
      ).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(RawConfluenceWatcherPage))
      )
    ),
  getPageVersions: (pageId, cursor) =>
    bounded(
      "confluence-page-versions",
      api.v2.getPageVersions(pageId, {
        params: {
          ...(cursor === null ? {} : { cursor }),
          limit: 100,
          sort: "-modified-date"
        }
      })
    ),
  getUsers: (accountIds) =>
    bounded(
      "confluence-user-lookup",
      api.v2.createBulkUserLookup({ payload: { accountIds } })
    )
})

/** Production page boundary backed by the supported generated API client. @internal */
export const confluencePageClientLayer: Layer.Layer<
  ConfluencePageClient,
  never,
  ConfluenceApiClient
> = Layer.effect(
  ConfluencePageClient,
  Effect.map(ConfluenceApiClient, makeConfluencePageClient)
)
