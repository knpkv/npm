/**
 * Narrow Confluence read boundary used by the Control Center adapter.
 *
 * The generated API owns HTTP request and wire-schema decoding. This module
 * translates its open error surface into a small, secret-free transport model
 * and keeps tests independent of the generated client's broad interface.
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

const Operation = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))

/** Secret-free failure emitted by the live Confluence read boundary. @internal */
export class ConfluencePageClientFailure extends Schema.TaggedErrorClass<ConfluencePageClientFailure>()(
  "ConfluencePageClientFailure",
  {
    operation: Operation,
    reason: Schema.Literals([
      "authentication",
      "authorization",
      "not-found",
      "rate-limit",
      "timeout",
      "malformed-response",
      "outage"
    ]),
    retryAfterSeconds: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400 })))
  }
) {}

/** Minimal provider reads needed for the first Confluence page vertical slice. @internal */
export interface ConfluencePageClientShape {
  readonly getCurrentUser: Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly getSystemInfo: Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly getPage: (pageId: string) => Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly getPageVersions: (
    pageId: string,
    cursor: string | null
  ) => Effect.Effect<unknown, ConfluencePageClientFailure>
  readonly getUsers: (
    accountIds: ReadonlyArray<string>
  ) => Effect.Effect<unknown, ConfluencePageClientFailure>
}

/** Injectable Confluence page-read client. @internal */
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
      api.v2.getPageById(pageId, {
        params: {
          "body-format": "atlas_doc_format",
          "include-version": true,
          status: ["current"]
        }
      })
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

/** Production page-read boundary backed by the supported generated API client. @internal */
export const confluencePageClientLayer: Layer.Layer<
  ConfluencePageClient,
  never,
  ConfluenceApiClient
> = Layer.effect(
  ConfluencePageClient,
  Effect.map(ConfluenceApiClient, makeConfluencePageClient)
)
