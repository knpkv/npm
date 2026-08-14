/**
 * Production Clockify boundary for bounded reads and governed correction writes.
 *
 * The shared client owns authenticated request construction and generated
 * OpenAPI decoding. This boundary keeps its raw failures and response shapes
 * out of the plugin contract.
 *
 * @internal
 */
import type { ClockifyApiClientContract, UpdateTimeEntryParams } from "@knpkv/clockify-api-client"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as HttpClientError from "effect/unstable/http/HttpClientError"

import {
  PluginAuthenticationFailure,
  PluginAuthorizationFailure,
  PluginConflictFailure,
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

/** Narrow provider surface required by the production Clockify integration. @internal */
export interface ClockifyReadProvider {
  readonly getCurrentUser: Effect.Effect<unknown, PluginFailure>
  readonly getWorkspaceUsers: (
    workspaceId: string,
    request?: { readonly page: number; readonly pageSize: number }
  ) => Effect.Effect<unknown, PluginFailure>
  readonly getWorkspaces: Effect.Effect<unknown, PluginFailure>
  readonly getTimeEntry: (
    workspaceId: string,
    timeEntryId: string,
    request?: { readonly hydrated: boolean }
  ) => Effect.Effect<Option.Option<unknown>, PluginFailure>
  readonly getTimeEntries: (
    workspaceId: string,
    userId: string,
    request: ClockifyTimeEntryPageRequest
  ) => Effect.Effect<unknown, PluginFailure>
  readonly updateTimeEntry: (
    workspaceId: string,
    timeEntryId: string,
    request: UpdateTimeEntryParams
  ) => Effect.Effect<unknown, PluginFailure>
}

const StatusResponse = Schema.Struct({
  response: Schema.Struct({ status: Schema.Number })
})
const RetryAfterDeltaSeconds = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
)

const statusOf = <UnparsedInput>(error: UnparsedInput): number | undefined => {
  if (HttpClientError.isHttpClientError(error)) return error.response?.status
  const decoded = Schema.decodeUnknownResult(StatusResponse)(error)
  return Result.isSuccess(decoded) ? decoded.success.response.status : undefined
}

const retryAtForFailure = Effect.fn("ClockifyReadProvider.retryAtForFailure")(
  function*<UnparsedInput>(error: UnparsedInput) {
    const now = yield* DateTime.now
    if (!HttpClientError.isHttpClientError(error)) return DateTime.add(now, { seconds: 60 })
    const value = error.response?.headers["retry-after"]
    if (value === undefined) return DateTime.add(now, { seconds: 60 })
    const seconds = Schema.decodeUnknownOption(RetryAfterDeltaSeconds)(value)
    if (Option.isSome(seconds)) return DateTime.add(now, { seconds: Math.min(seconds.value, 3_600) })
    return Option.getOrElse(DateTime.make(value), () => DateTime.add(now, { seconds: 60 }))
  }
)

const mapFailure = Effect.fn("ClockifyReadProvider.mapFailure")(function*<UnparsedInput>(
  operation: string,
  error: UnparsedInput
): Effect.fn.Return<never, PluginFailure> {
  const status = statusOf(error)
  if (status === 401) return yield* new PluginAuthenticationFailure({ operation })
  if (status === 403) return yield* new PluginAuthorizationFailure({ operation })
  if (status === 408 || status === 504) return yield* new PluginTimeoutFailure({ operation })
  if (status === 429) {
    const retryAt = yield* retryAtForFailure(error)
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

const mutationCall = <Value, Error>(
  operation: string,
  diagnosticCode: string,
  effect: Effect.Effect<Value, Error>
): Effect.Effect<Value, PluginFailure> =>
  Effect.catch(effect, (error) => {
    const status = statusOf(error)
    return status === 400 || status === 404 || status === 409 || status === 422
      ? Effect.fail(
        new PluginConflictFailure({
          operation,
          diagnosticCode
        })
      )
      : mapFailure(operation, error)
  })

/** Build the production provider boundary from the shared Clockify client. @internal */
export const makeClockifyReadProvider = (client: ClockifyApiClientContract): ClockifyReadProvider => ({
  getCurrentUser: providerCall("clockify-current-user", client.getUser()),
  getWorkspaceUsers: (workspaceId, request) =>
    request !== undefined && client.getWorkspaceUsersPage !== undefined
      ? providerCall(
        "clockify-workspace-users",
        client.getWorkspaceUsersPage(workspaceId, request.page, request.pageSize)
      )
      : client.getWorkspaceUsers === undefined
      ? providerCall("clockify-workspace-users", client.getUser()).pipe(Effect.map((user) => [user]))
      : providerCall("clockify-workspace-users", client.getWorkspaceUsers(workspaceId)),
  getWorkspaces: providerCall("clockify-workspaces", client.getWorkspaces()),
  getTimeEntry: (workspaceId, timeEntryId, request) =>
    client.getTimeEntry(workspaceId, timeEntryId, request).pipe(
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
        hydrated: true,
        page: request.page,
        pageSize: request.pageSize
      })
    ),
  updateTimeEntry: (workspaceId, timeEntryId, request) =>
    mutationCall(
      "clockify-update-time-entry",
      "clockify-time-entry-update-rejected",
      client.updateTimeEntry(workspaceId, timeEntryId, request)
    )
})
