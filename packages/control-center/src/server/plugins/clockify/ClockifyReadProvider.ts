/**
 * Production Clockify read boundary.
 *
 * The shared client owns authenticated request construction and generated
 * OpenAPI decoding. This boundary keeps its raw failures and response shapes
 * out of the plugin contract.
 *
 * @internal
 */
import type { ClockifyApiClientShape } from "@knpkv/clockify-api-client"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as HttpClientError from "effect/unstable/http/HttpClientError"

import {
  PluginAuthenticationFailure,
  PluginAuthorizationFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginRateLimitFailure,
  PluginTimeoutFailure
} from "../failures.js"

/** One bounded time-entry page request. @internal */
export interface ClockifyTimeEntryPageRequest {
  readonly page: number
  readonly pageSize: number
}

/** Narrow provider surface required by the production Clockify reader. @internal */
export interface ClockifyReadProvider {
  readonly getCurrentUser: Effect.Effect<unknown, PluginFailure>
  readonly getWorkspaces: Effect.Effect<unknown, PluginFailure>
  readonly getTimeEntry: (
    workspaceId: string,
    timeEntryId: string
  ) => Effect.Effect<Option.Option<unknown>, PluginFailure>
  readonly getTimeEntries: (
    workspaceId: string,
    userId: string,
    request: ClockifyTimeEntryPageRequest
  ) => Effect.Effect<unknown, PluginFailure>
}

const StatusResponse = Schema.Struct({
  response: Schema.Struct({ status: Schema.Number })
})

const statusOf = (error: unknown): number | undefined => {
  if (HttpClientError.isHttpClientError(error)) return error.response?.status
  const decoded = Schema.decodeUnknownResult(StatusResponse)(error)
  return Result.isSuccess(decoded) ? decoded.success.response.status : undefined
}

const retryAfterSeconds = (error: unknown): number => {
  if (!HttpClientError.isHttpClientError(error)) return 60
  const value = error.response?.headers["retry-after"]
  if (value === undefined) return 60
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3_600) : 60
}

const mapFailure = Effect.fn("ClockifyReadProvider.mapFailure")(function*(
  operation: string,
  error: unknown
): Effect.fn.Return<never, PluginFailure> {
  const status = statusOf(error)
  if (status === 401) return yield* new PluginAuthenticationFailure({ operation })
  if (status === 403) return yield* new PluginAuthorizationFailure({ operation })
  if (status === 408 || status === 504) return yield* new PluginTimeoutFailure({ operation })
  if (status === 429) {
    const retryAt = DateTime.add(yield* DateTime.now, { seconds: retryAfterSeconds(error) })
    return yield* new PluginRateLimitFailure({ operation, retryAt })
  }
  if (Schema.isSchemaError(error)) {
    return yield* new PluginMalformedResponseFailure({
      operation,
      diagnosticCode: "clockify-openapi-response-invalid"
    })
  }
  if (
    HttpClientError.isHttpClientError(error) &&
    (error.reason._tag === "DecodeError" || error.reason._tag === "EmptyBodyError")
  ) {
    return yield* new PluginMalformedResponseFailure({
      operation,
      diagnosticCode: "clockify-http-response-invalid"
    })
  }
  return yield* new PluginOutageFailure({ operation })
})

const providerCall = <Value, Error>(
  operation: string,
  effect: Effect.Effect<Value, Error>
): Effect.Effect<Value, PluginFailure> => Effect.catch(effect, (error) => mapFailure(operation, error))

/** Build the production provider boundary from the shared Clockify client. @internal */
export const makeClockifyReadProvider = (client: ClockifyApiClientShape): ClockifyReadProvider => ({
  getCurrentUser: providerCall("clockify-current-user", client.getUser()),
  getWorkspaces: providerCall("clockify-workspaces", client.getWorkspaces()),
  getTimeEntry: (workspaceId, timeEntryId) =>
    client.getTimeEntry(workspaceId, timeEntryId).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        statusOf(error) === 404
          ? Effect.succeed(Option.none())
          : mapFailure("clockify-get-time-entry", error)
      )
    ),
  getTimeEntries: (workspaceId, userId, request) =>
    providerCall(
      "clockify-get-time-entries",
      client.getTimeEntries(workspaceId, userId, {
        page: request.page,
        pageSize: request.pageSize
      })
    )
})
