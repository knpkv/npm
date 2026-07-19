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

/** Stable provider-independent lower bound for one incremental project query. @internal */
export interface JiraIssueWatermark {
  readonly updatedAt: string
  readonly issueKey: string | null
}

/** One bounded project search request. @internal */
export interface JiraProjectIssuePageRequest {
  readonly projectId: string
  readonly watermark: JiraIssueWatermark | null
  readonly nextPageToken: string | null
  readonly maxResults: number
  readonly timeZone: string
}

const JiraProviderIdentifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512)
)
const JiraProviderIssueId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
  Schema.makeFilter((value) => /^\d+$/u.test(value), { expected: "a numeric Jira issue ID" })
)
const JiraProjectIssue = Schema.Struct({
  id: JiraProviderIssueId,
  key: JiraProviderIdentifier,
  fields: Schema.Record(Schema.String, Schema.Json)
})

/** Schema-decoded issue shape crossing the bounded project iteration boundary. @internal */
export type JiraProjectIssue = typeof JiraProjectIssue.Type

const JiraProjectIssuePageResponse = Schema.Struct({
  issues: Schema.Array(JiraProjectIssue),
  isLast: Schema.optionalKey(Schema.Boolean),
  nextPageToken: Schema.optionalKey(Schema.NullOr(JiraProviderIdentifier))
})

/** Schema-decoded page shape crossing the bounded project iteration boundary. @internal */
export interface JiraProjectIssuePage {
  readonly issues: ReadonlyArray<JiraProjectIssue>
  readonly nextPageToken: string | null
}

/** Narrow provider surface required by the production issue-read adapter. @internal */
export interface JiraReadProvider {
  readonly getCurrentUser: Effect.Effect<JiraApi.User, PluginFailure>
  readonly getServerInfo: Effect.Effect<JiraApi.ServerInformation, PluginFailure>
  readonly getProject: (projectId: string) => Effect.Effect<JiraApi.Project, PluginFailure>
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
  readonly searchProjectIssues: (
    request: JiraProjectIssuePageRequest
  ) => Effect.Effect<JiraProjectIssuePage, PluginFailure>
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

const escapeJqlString = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")

const twoDigits = (value: number): string => String(value).padStart(2, "0")

const projectJql = Effect.fn("JiraReadProvider.projectJql")(function*(
  request: JiraProjectIssuePageRequest
): Effect.fn.Return<string, PluginMalformedResponseFailure> {
  const project = `project = "${escapeJqlString(request.projectId)}"`
  if (request.watermark === null) return `${project} ORDER BY updated ASC, key ASC`
  const updated = yield* Effect.fromOption(
    DateTime.make(request.watermark.updatedAt),
    () =>
      new PluginMalformedResponseFailure({
        operation: "jira-search-project-issues",
        diagnosticCode: "jira-project-search-watermark-invalid"
      })
  )
  const zoned = yield* Effect.fromOption(
    DateTime.makeZoned(updated, { timeZone: request.timeZone }),
    () =>
      new PluginMalformedResponseFailure({
        operation: "jira-search-project-issues",
        diagnosticCode: "jira-project-search-time-zone-invalid"
      })
  )
  const parts = DateTime.toParts(zoned)
  const updatedAt = `${String(parts.year).padStart(4, "0")}-${twoDigits(parts.month)}-${twoDigits(parts.day)} ${
    twoDigits(parts.hour)
  }:${twoDigits(parts.minute)}`
  return `${project} AND updated >= "${updatedAt}" ORDER BY updated ASC, key ASC`
})

const decodeProjectIssuePage = Effect.fn("JiraReadProvider.decodeProjectIssuePage")(function*(
  response: unknown
): Effect.fn.Return<JiraProjectIssuePage, PluginMalformedResponseFailure> {
  const decoded = yield* Schema.decodeUnknownEffect(JiraProjectIssuePageResponse)(response).pipe(
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation: "jira-search-project-issues",
        diagnosticCode: "jira-project-search-response-invalid"
      })
    )
  )
  const nextPageToken = decoded.nextPageToken ?? null
  if (
    (decoded.isLast === false && nextPageToken === null) ||
    (decoded.isLast === true && nextPageToken !== null)
  ) {
    return yield* new PluginMalformedResponseFailure({
      operation: "jira-search-project-issues",
      diagnosticCode: "jira-project-search-cursor-invalid"
    })
  }
  return { issues: decoded.issues, nextPageToken }
})

/** Build the production provider boundary from the shared generated Jira client. @internal */
export const makeJiraReadProvider = (client: JiraApiClientShape): JiraReadProvider => ({
  getCurrentUser: providerCall("jira-current-user", client.getCurrentUser(undefined)),
  getServerInfo: providerCall("jira-server-info", client.getServerInfo(undefined)),
  getProject: (projectId) => providerCall("jira-get-project", client.getProject(projectId, undefined)),
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
    ),
  searchProjectIssues: (request) =>
    projectJql(request).pipe(
      Effect.flatMap((jql) =>
        providerCall(
          "jira-search-project-issues",
          client.searchIssuesUsingJql({
            params: {
              jql,
              maxResults: request.maxResults,
              fields: ISSUE_FIELDS,
              ...(request.nextPageToken === null ? {} : { nextPageToken: request.nextPageToken })
            }
          })
        )
      ),
      Effect.flatMap(decodeProjectIssuePage)
    )
})
