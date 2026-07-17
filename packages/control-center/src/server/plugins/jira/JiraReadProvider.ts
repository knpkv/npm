/**
 * Production Jira read boundary.
 *
 * The generated client owns HTTP construction and OpenAPI decoding. This
 * module translates its provider-specific failures into the closed plugin
 * taxonomy before data reaches the adapter.
 *
 * @internal
 */
import type { JiraApi, JiraApiClientShape } from "@knpkv/jira-api-client"
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

/** One provider page request; limits are validated by adapter configuration. @internal */
export interface JiraPageRequest {
  readonly startAt: number
  readonly maxResults: number
}

/** Narrow provider surface required by the production issue-read adapter. @internal */
export interface JiraReadProvider {
  readonly getCurrentUser: Effect.Effect<JiraApi.User, PluginFailure>
  readonly getServerInfo: Effect.Effect<JiraApi.ServerInformation, PluginFailure>
  readonly getIssue: (
    issueId: string
  ) => Effect.Effect<Option.Option<JiraApi.IssueBean>, PluginFailure>
  readonly getComments: (
    issueId: string,
    request: JiraPageRequest
  ) => Effect.Effect<JiraApi.PageOfComments, PluginFailure>
  readonly getChangelogs: (
    issueId: string,
    request: JiraPageRequest
  ) => Effect.Effect<JiraApi.PageBeanChangelog, PluginFailure>
}

const StatusResponse = Schema.Struct({
  response: Schema.Struct({ status: Schema.Number })
})

const statusOf = (error: unknown): number | undefined => {
  if (HttpClientError.isHttpClientError(error)) return error.response?.status
  const decoded = Schema.decodeUnknownResult(StatusResponse)(error)
  return Result.isSuccess(decoded) ? decoded.success.response.status : undefined
}

const isNotFound = (error: unknown): boolean => statusOf(error) === 404

const retryAfterSeconds = (error: unknown, now: DateTime.DateTime): number => {
  if (!HttpClientError.isHttpClientError(error)) return 60
  const value = error.response?.headers["retry-after"]
  if (value === undefined) return 60
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3_600)
  const retryAt = DateTime.make(value)
  if (Option.isNone(retryAt)) return 60
  const delayMillis = DateTime.toEpochMillis(retryAt.value) - DateTime.toEpochMillis(now)
  return Math.min(Math.max(Math.ceil(delayMillis / 1_000), 0), 3_600)
}

const mapFailure = Effect.fn("JiraReadProvider.mapFailure")(function*(
  operation: string,
  error: unknown
): Effect.fn.Return<never, PluginFailure> {
  const status = statusOf(error)
  if (status === 401) return yield* new PluginAuthenticationFailure({ operation })
  if (status === 403) return yield* new PluginAuthorizationFailure({ operation })
  if (status === 408 || status === 504) return yield* new PluginTimeoutFailure({ operation })
  if (status === 429) {
    const now = yield* DateTime.now
    const retryAt = DateTime.add(now, { seconds: retryAfterSeconds(error, now) })
    return yield* new PluginRateLimitFailure({ operation, retryAt })
  }
  if (Schema.isSchemaError(error)) {
    return yield* new PluginMalformedResponseFailure({
      operation,
      diagnosticCode: "jira-openapi-response-invalid"
    })
  }
  if (
    HttpClientError.isHttpClientError(error) &&
    (error.reason._tag === "DecodeError" || error.reason._tag === "EmptyBodyError")
  ) {
    return yield* new PluginMalformedResponseFailure({
      operation,
      diagnosticCode: "jira-http-response-invalid"
    })
  }
  return yield* new PluginOutageFailure({ operation })
})

/** Translate a generated-client failure at the provider boundary. @internal */
export const mapJiraReadProviderFailure = mapFailure

const providerCall = <Value, Error>(
  operation: string,
  effect: Effect.Effect<Value, Error>
): Effect.Effect<Value, PluginFailure> => Effect.catch(effect, (error) => mapFailure(operation, error))

const ISSUE_FIELDS = [
  "summary",
  "description",
  "environment",
  "status",
  "priority",
  "issuetype",
  "project",
  "assignee",
  "reporter",
  "creator",
  "labels",
  "components",
  "fixVersions",
  "resolution",
  "created",
  "updated",
  "duedate",
  "resolutiondate",
  "parent",
  "subtasks"
]

/** Build the production provider boundary from the shared generated Jira client. @internal */
export const makeJiraReadProvider = (client: JiraApiClientShape): JiraReadProvider => ({
  getCurrentUser: providerCall("jira-current-user", client.getCurrentUser(undefined)),
  getServerInfo: providerCall("jira-server-info", client.getServerInfo(undefined)),
  getIssue: (issueId) =>
    client.getIssue(issueId, { params: { fields: ISSUE_FIELDS } }).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        isNotFound(error)
          ? Effect.succeed(Option.none())
          : mapFailure("jira-get-issue", error)
      )
    ),
  getComments: (issueId, request) =>
    providerCall(
      "jira-get-comments",
      client.getComments(issueId, {
        params: { ...request, orderBy: "created" }
      })
    ),
  getChangelogs: (issueId, request) =>
    providerCall(
      "jira-get-changelogs",
      client.getChangeLogs(issueId, { params: request })
    )
})
