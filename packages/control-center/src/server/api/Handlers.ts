import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpEffect from "effect/unstable/http/HttpEffect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder, HttpApiSecurity } from "effect/unstable/httpapi"

import { ReleaseAgentThreadCursor } from "../../api/agent.js"
import { ControlCenterApi } from "../../api/controlCenterApi.js"
import type {
  ConflictApiError,
  ForbiddenApiError,
  InvalidRequestApiError,
  ServiceUnavailableApiError
} from "../../api/errors.js"
import { SafeMediaContentType } from "../../api/media.js"
import { CsrfToken, CurrentSession } from "../../api/session.js"
import { WorkspacePresentationReadModel } from "../../api/workspaceSettings.js"
import { PrReviewSuggestionRevisionPageSize } from "../../domain/prReviewRevision.js"
import type { TimelineActorKind } from "../../domain/timeline.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import {
  type ClockifyActionSubmissionError,
  ClockifyActionSubmissions
} from "../application/clockifyActionSubmissions.js"
import { listFirstPartyServiceMetadata } from "../application/pluginAdministration.js"
import { collectTimelineExport, encodeTimelineCsv, encodeTimelineJson } from "../application/timelineExports.js"
import { Auth } from "../auth/Auth.js"
import { ServerLifecycle } from "../runtime/ServerLifecycle.js"
import { sessionCookiePolicy } from "../security/RequestSecurity.js"
import { ApiBindConfiguration } from "./ApiConfiguration.js"
import { authorizePairingRequest } from "./ApiMiddleware.js"
import {
  ApplicationConflict,
  type ApplicationRateLimited,
  type ApplicationResourceNotFound,
  type ApplicationServiceUnavailable,
  AuthorizedShares,
  CodePipelineReads,
  CompleteDiffReads,
  DeliveryGraphInspection,
  LiveEvents,
  MediaReads,
  PluginAdministration,
  PortfolioSnapshots,
  PullRequestReviews,
  RelationshipRepairProposals,
  ReleaseAgentJobs,
  ReleaseAgentTurns,
  TimelineExportAudits,
  TimelineReads,
  WorkspaceSettingsAdministration
} from "./ApplicationServices.js"
import {
  forbiddenApiError,
  invalidRequestApiError,
  liveStreamCapacityApiError,
  mapApplicationConflict,
  mapApplicationInvalidRequest,
  mapApplicationNotFound,
  mapApplicationRateLimited,
  mapApplicationUnavailable,
  mapAuthenticationFailures,
  mapCredentialAuthenticationFailures,
  notFoundApiError,
  serviceUnavailableApiError
} from "./ErrorMapping.js"
import { LiveStreamAdmission } from "./LiveStreamAdmission.js"

const sessionCookie = HttpApiSecurity.apiKey({ in: "cookie", key: "cc_session" })

const currentSessionToken = (request: { readonly cookies: Readonly<Record<string, string | undefined>> }) =>
  Redacted.make(request.cookies.cc_session ?? "")

const SESSION_REAUTHENTICATION_INTERVAL = Duration.seconds(25)
const INITIAL_AGENT_THREAD_CURSOR = ReleaseAgentThreadCursor.make(0)
const DEFAULT_AGENT_THREAD_EVENT_LIMIT = 128
const DEFAULT_REVIEW_SUGGESTION_REVISION_LIMIT = PrReviewSuggestionRevisionPageSize.make(20)

const requireWorkspaceRead = (session: CurrentSession["Service"]) =>
  session.permission === "workspace-owner" || session.permission === "workspace-approver"
    ? Effect.void
    : Effect.flatMap(forbiddenApiError, Effect.fail)

const appendWorkspaceSettingsHeaders = (etag: string) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, {
      "cache-control": "private, no-store",
      etag
    }))
  )

const mapClockifyActionSubmissionError = (
  error: ClockifyActionSubmissionError
): Effect.Effect<never, ConflictApiError | ForbiddenApiError | InvalidRequestApiError | ServiceUnavailableApiError> => {
  switch (error.reason) {
    case "conflict":
      return mapApplicationConflict(new ApplicationConflict())
    case "forbidden":
      return Effect.flatMap(forbiddenApiError, Effect.fail)
    case "invalid-request":
      return Effect.flatMap(invalidRequestApiError, Effect.fail)
    case "unavailable":
      return Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
  }
}

interface TimelineExportQuery {
  readonly actor?: TimelineActorKind | undefined
  readonly from?: UtcTimestamp | undefined
  readonly limit: number
  readonly to?: UtcTimestamp | undefined
}

type TimelineExportFormat = "csv" | "json"

const timelineRangeIsInverted = (query: Pick<TimelineExportQuery, "from" | "to">): boolean =>
  query.from !== undefined &&
  query.to !== undefined &&
  DateTime.toEpochMillis(query.from) > DateTime.toEpochMillis(query.to)

const appendTimelineExportHeaders = (
  format: TimelineExportFormat,
  metadata: { readonly eventCount: number; readonly eventLimit: number; readonly truncated: boolean }
) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="timeline-export.${format}"`,
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-timeline-export-count": String(metadata.eventCount),
      "x-timeline-export-limit": String(metadata.eventLimit),
      "x-timeline-export-truncated": String(metadata.truncated)
    }))
  )

const revalidateSession = (
  auth: Auth["Service"],
  token: Redacted.Redacted<string>,
  expected: CurrentSession["Service"]
): Effect.Effect<boolean> =>
  auth.authenticate(token).pipe(
    Effect.result,
    Effect.map(
      (authenticated) =>
        Result.isSuccess(authenticated) &&
        authenticated.success.sessionId === expected.sessionId &&
        authenticated.success.workspaceId === expected.workspaceId
    ),
    Effect.catchDefect(() =>
      Effect.logWarning("Closing Control Center live event stream after session revalidation defect", {
        sessionId: expected.sessionId,
        workspaceId: expected.workspaceId
      }).pipe(Effect.as(false))
    )
  )

const awaitSessionEnd = (
  auth: Auth["Service"],
  token: Redacted.Redacted<string>,
  expected: CurrentSession["Service"]
): Effect.Effect<void> =>
  Effect.sleep(SESSION_REAUTHENTICATION_INTERVAL).pipe(
    Effect.andThen(revalidateSession(auth, token, expected)),
    Effect.flatMap((isCurrentSession) =>
      isCurrentSession ? Effect.suspend(() => awaitSessionEnd(auth, token, expected)) : Effect.void
    )
  )

/** Session pairing, inspection, administration, and logout handlers. */
export const sessionHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "session",
  (handlers) =>
    Effect.gen(function*() {
      const auth = yield* Auth
      const config = yield* ApiBindConfiguration
      const cookie = sessionCookiePolicy(config)
      const lifecycle = yield* ServerLifecycle
      return handlers
        .handle("pair", ({ payload }) =>
          lifecycle.runMutation(
            Effect.gen(function*() {
              yield* authorizePairingRequest()
              const issued = yield* mapCredentialAuthenticationFailures(
                auth.consumePairingCode(Redacted.make(payload.pairingCode))
              )
              yield* HttpApiBuilder.securitySetCookie(sessionCookie, issued.sessionToken, cookie)
              return {
                csrfToken: CsrfToken.make(Redacted.value(issued.csrfToken)),
                session: issued.session
              }
            })
          ).pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          ))
        .handle("current", ({ request }) =>
          Effect.gen(function*() {
            const recovered = yield* mapAuthenticationFailures(
              auth.recoverCsrfToken(currentSessionToken(request))
            )
            return {
              csrfToken: CsrfToken.make(Redacted.value(recovered.csrfToken)),
              session: recovered.session
            }
          }))
        .handle("list", ({ request }) =>
          Effect.gen(function*() {
            return yield* mapAuthenticationFailures(
              auth.listSessions(currentSessionToken(request))
            )
          }))
        .handle("revoke", ({ params, request }) =>
          Effect.gen(function*() {
            yield* mapAuthenticationFailures(
              auth.revokeSession(currentSessionToken(request), params.sessionId)
            )
          }))
        .handle("logout", ({ request }) =>
          Effect.gen(function*() {
            yield* mapAuthenticationFailures(auth.logout(currentSessionToken(request)))
            yield* HttpApiBuilder.securitySetCookie(sessionCookie, "", {
              ...cookie,
              maxAge: 0
            })
          }))
    })
)

/** Authenticated read and owner-only CAS mutation handlers for workspace settings. */
export const workspaceSettingsHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "workspaceSettings",
  (handlers) =>
    Effect.gen(function*() {
      const administration = yield* Effect.serviceOption(WorkspaceSettingsAdministration)
      const lifecycle = yield* ServerLifecycle
      return handlers
        .handle("read", () =>
          lifecycle.runMutation(
            Effect.gen(function*() {
              const session = yield* CurrentSession
              yield* requireWorkspaceRead(session)
              if (Option.isNone(administration)) {
                return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
              }
              const result = yield* administration.value.read(session.workspaceId).pipe(
                Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable)
              )
              yield* appendWorkspaceSettingsHeaders(result.etag)
              return result
            })
          ).pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          ))
        .handle("readPresentation", () =>
          lifecycle.runMutation(
            Effect.gen(function*() {
              const session = yield* CurrentSession
              if (Option.isNone(administration)) {
                return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
              }
              const result = yield* administration.value.read(session.workspaceId).pipe(
                Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable)
              )
              yield* appendWorkspaceSettingsHeaders(result.etag)
              return WorkspacePresentationReadModel.make({
                workspaceId: result.workspaceId,
                revision: result.revision,
                presentation: result.settings.presentation
              })
            })
          ).pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          ))
        .handle("update", ({ payload }) =>
          lifecycle.runMutation(
            Effect.gen(function*() {
              const session = yield* CurrentSession
              if (session.permission !== "workspace-owner" || session.actor._tag !== "human") {
                return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
              }
              if (Option.isNone(administration)) {
                return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
              }
              const result = yield* administration.value.update({
                workspaceId: session.workspaceId,
                request: payload,
                session
              }).pipe(Effect.catchTags({
                ApplicationConflict: mapApplicationConflict,
                ApplicationInvalidRequest: mapApplicationInvalidRequest,
                ApplicationServiceUnavailable: mapApplicationUnavailable
              }))
              yield* appendWorkspaceSettingsHeaders(result.etag)
              return result
            })
          ).pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          ))
    })
)

/** Exact-scope authenticated entity-share handlers. */
export const shareHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "shares",
  (handlers) =>
    Effect.gen(function*() {
      const shares = yield* AuthorizedShares
      return handlers
        .handle("create", ({ payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner" || session.actor._tag !== "human") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            return yield* shares.create({
              workspaceId: session.workspaceId,
              request: payload,
              createdByPersonId: session.actor.personId,
              sessionId: session.sessionId
            }).pipe(Effect.catchTags({
              ApplicationConflict: mapApplicationConflict,
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("resolve", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.workspaceId !== params.workspaceId) {
              return yield* Effect.flatMap(notFoundApiError, Effect.fail)
            }
            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "private, no-store"))
            )
            return yield* shares.resolve({
              workspaceId: params.workspaceId,
              shareId: params.shareId,
              actor: session.actor
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("revoke", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.workspaceId !== params.workspaceId) {
              return yield* Effect.flatMap(notFoundApiError, Effect.fail)
            }
            if (session.permission !== "workspace-owner" || session.actor._tag !== "human") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            return yield* shares.revoke({
              workspaceId: params.workspaceId,
              shareId: params.shareId,
              revokedByPersonId: session.actor.personId,
              sessionId: session.sessionId
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
    })
)

/** Secret-free plugin list, health, and configuration metadata handlers. */
export const pluginHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "plugins",
  (handlers) =>
    Effect.gen(function*() {
      const plugins = yield* PluginAdministration
      return handlers
        .handle("list", () =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* plugins.list(session.workspaceId).pipe(
              Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable)
            )
          }))
        .handle("overview", () =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            const connections = yield* plugins.list(session.workspaceId).pipe(
              Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable)
            )
            const accounts = plugins.accounts === undefined
              ? []
              : yield* plugins.accounts(session.workspaceId).pipe(
                Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable)
              )
            return { catalog: listFirstPartyServiceMetadata(), connections, accounts }
          }))
        .handle("patchProviderAccount", ({ params, payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            const patchProviderAccount = plugins.patchProviderAccount
            if (patchProviderAccount === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* patchProviderAccount({
              workspaceId: session.workspaceId,
              providerAccountId: params.providerAccountId,
              patch: payload
            }).pipe(Effect.catchTags({
              ApplicationConflict: mapApplicationConflict,
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("discoverAwsProfiles", () =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            const discoverAwsProfiles = plugins.discoverAwsProfiles
            if (discoverAwsProfiles === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* discoverAwsProfiles().pipe(
              Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable)
            )
          }))
        .handle("discoverAwsResources", ({ payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            const discoverAwsResources = plugins.discoverAwsResources
            if (discoverAwsResources === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* discoverAwsResources(payload).pipe(Effect.catchTags({
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("discoverAtlassianProfiles", () =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            const discoverAtlassianProfiles = plugins.discoverAtlassianProfiles
            if (discoverAtlassianProfiles === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* discoverAtlassianProfiles().pipe(
              Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable)
            )
          }))
        .handle("createAtlassianOAuthGrant", ({ payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            const startAtlassianOAuthGrant = plugins.startAtlassianOAuthGrant
            if (startAtlassianOAuthGrant === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* startAtlassianOAuthGrant({
              workspaceId: session.workspaceId,
              sessionId: session.sessionId,
              providers: payload.providers,
              ...(payload.configuration === undefined ? {} : { configuration: payload.configuration })
            }).pipe(Effect.catchTags({
              ApplicationConflict: mapApplicationConflict,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("exchangeAtlassianOAuthGrant", ({ params, payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            const exchangeAtlassianOAuthGrant = plugins.exchangeAtlassianOAuthGrant
            if (exchangeAtlassianOAuthGrant === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* exchangeAtlassianOAuthGrant({
              workspaceId: session.workspaceId,
              sessionId: session.sessionId,
              grantId: params.grantId,
              code: payload.code
            }).pipe(Effect.catchTags({
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("completeAtlassianOAuthGrant", ({ params, payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            const completeAtlassianOAuthGrant = plugins.completeAtlassianOAuthGrant
            if (completeAtlassianOAuthGrant === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* completeAtlassianOAuthGrant({
              workspaceId: session.workspaceId,
              sessionId: session.sessionId,
              grantId: params.grantId,
              cloudId: payload.cloudId
            }).pipe(Effect.catchTags({
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("createConnection", ({ payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            const connectAndTest = plugins.connectAndTest
            if (connectAndTest === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* connectAndTest({
              request: payload,
              workspaceId: session.workspaceId
            }).pipe(Effect.catchTags({
              ApplicationConflict: mapApplicationConflict,
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("createConnections", ({ payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            const connectAndTestBatch = plugins.connectAndTestBatch
            if (connectAndTestBatch === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* connectAndTestBatch({
              requests: payload.connections,
              workspaceId: session.workspaceId
            })
          }))
        .handle("setConnectionEnabled", ({ params, payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            const setEnabled = plugins.setConnectionEnabled
            if (setEnabled === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* setEnabled({
              workspaceId: session.workspaceId,
              pluginConnectionId: params.pluginConnectionId,
              isEnabled: payload.isEnabled
            }).pipe(Effect.catchTags({
              ApplicationConflict: mapApplicationConflict,
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("health", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* plugins.health({
              pluginConnectionId: params.pluginConnectionId,
              workspaceId: session.workspaceId
            }).pipe(Effect.catchTags({
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("testConnection", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            return yield* plugins.testConnection({
              pluginConnectionId: params.pluginConnectionId,
              workspaceId: session.workspaceId
            }).pipe(Effect.catchTags({
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("synchronization", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            const synchronization = plugins.synchronization
            if (synchronization === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* synchronization({
              pluginConnectionId: params.pluginConnectionId,
              workspaceId: session.workspaceId
            }).pipe(Effect.catchTags({
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("synchronizeConnection", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            const synchronizeConnection = plugins.synchronizeConnection
            if (synchronizeConnection === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* synchronizeConnection({
              pluginConnectionId: params.pluginConnectionId,
              workspaceId: session.workspaceId
            }).pipe(Effect.catchTags({
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("administration", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            const administration = plugins.administration
            if (administration === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* administration({
              pluginConnectionId: params.pluginConnectionId,
              workspaceId: session.workspaceId
            }).pipe(Effect.catchTags({
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("reauthorizeConnection", ({ params, payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            const reauthorizeConnection = plugins.reauthorizeConnection
            if (reauthorizeConnection === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* reauthorizeConnection({
              workspaceId: session.workspaceId,
              pluginConnectionId: params.pluginConnectionId,
              expectedRevision: payload.expectedRevision,
              credentials: payload.credentials
            }).pipe(Effect.catchTags({
              ApplicationConflict: mapApplicationConflict,
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("revokeConnection", ({ params, payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            const revokeConnection = plugins.revokeConnection
            if (revokeConnection === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* revokeConnection({
              workspaceId: session.workspaceId,
              pluginConnectionId: params.pluginConnectionId,
              expectedRevision: payload.expectedRevision
            }).pipe(Effect.catchTags({
              ApplicationConflict: mapApplicationConflict,
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("configurationMetadata", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* plugins.configurationMetadata({
              pluginConnectionId: params.pluginConnectionId,
              workspaceId: session.workspaceId
            }).pipe(Effect.catchTags({
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("configuration", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* plugins.configuration({
              pluginConnectionId: params.pluginConnectionId,
              workspaceId: session.workspaceId
            }).pipe(Effect.catchTags({
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("patchConfiguration", ({ params, payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            return yield* plugins.patchConfiguration({
              patch: payload,
              pluginConnectionId: params.pluginConnectionId,
              workspaceId: session.workspaceId
            }).pipe(Effect.catchTags({
              ApplicationConflict: mapApplicationConflict,
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
    })
)

/** Complete, immutable, workspace-scoped diff inventory and lazy content handlers. */
export const diffHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "diff",
  (handlers) =>
    Effect.gen(function*() {
      const reads = yield* Effect.serviceOption(CompleteDiffReads)
      const diffReads = Option.getOrUndefined(reads)
      return handlers
        .handle("inventory", ({ params, query }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            if (diffReads === undefined) return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "private, no-store"))
            )
            return yield* diffReads.inventory({
              workspaceId: session.workspaceId,
              pluginConnectionId: params.pluginConnectionId,
              vendorImmutableId: params.vendorImmutableId,
              revision: query.revision
            }).pipe(Effect.catchTags({
              ApplicationConflict: mapApplicationConflict,
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("content", ({ params, payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            if (diffReads === undefined) return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "private, no-store"))
            )
            return yield* diffReads.content({
              workspaceId: session.workspaceId,
              pluginConnectionId: params.pluginConnectionId,
              vendorImmutableId: params.vendorImmutableId,
              revision: payload.revision,
              anchor: payload.anchor,
              path: payload.path,
              previousPath: payload.previousPath,
              status: payload.status,
              side: payload.side,
              offset: payload.offset,
              length: payload.length
            }).pipe(Effect.catchTags({
              ApplicationConflict: mapApplicationConflict,
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
    })
)

/** Authenticated bird's-eye portfolio snapshot handler. */
export const portfolioHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "portfolio",
  (handlers) =>
    Effect.gen(function*() {
      const portfolio = yield* PortfolioSnapshots
      return handlers.handle("snapshot", () =>
        Effect.gen(function*() {
          const session = yield* CurrentSession
          yield* requireWorkspaceRead(session)
          return yield* portfolio.snapshot(session.workspaceId).pipe(
            Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable)
          )
        }))
    })
)

/** Authenticated, default-redacted durable activity Timeline handler. */
export const timelineHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "timeline",
  (handlers) =>
    Effect.gen(function*() {
      const timeline = yield* TimelineReads
      const exportAudits = yield* TimelineExportAudits
      const download = Effect.fn("Timeline.download")(
        function*(query: TimelineExportQuery, format: TimelineExportFormat) {
          const session = yield* CurrentSession
          yield* requireWorkspaceRead(session)
          if (session.actor._tag !== "human") {
            return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
          }
          if (timelineRangeIsInverted(query)) {
            return yield* Effect.flatMap(invalidRequestApiError, Effect.fail)
          }
          const timelineExport = yield* collectTimelineExport(timeline, {
            workspaceId: session.workspaceId,
            actorKind: query.actor ?? null,
            eventLimit: query.limit,
            from: query.from ?? null,
            to: query.to ?? null
          }).pipe(Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable))
          yield* exportAudits.record({
            workspaceId: session.workspaceId,
            personId: session.actor.personId,
            sessionId: session.sessionId,
            format,
            actorKind: query.actor ?? null,
            from: query.from ?? null,
            to: query.to ?? null,
            requestedLimit: query.limit,
            returnedCount: timelineExport.metadata.eventCount,
            truncated: timelineExport.metadata.truncated
          }).pipe(Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable))
          yield* appendTimelineExportHeaders(format, timelineExport.metadata)
          return format === "csv" ? encodeTimelineCsv(timelineExport) : encodeTimelineJson(timelineExport)
        }
      )
      return handlers
        .handle("page", ({ query }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            const hasCursorKey = query.beforeEventKey !== undefined
            const hasCursorTime = query.beforeOccurredAt !== undefined
            if (hasCursorKey !== hasCursorTime || timelineRangeIsInverted(query)) {
              return yield* Effect.flatMap(invalidRequestApiError, Effect.fail)
            }
            return yield* timeline.page({
              workspaceId: session.workspaceId,
              actorKind: query.actor ?? null,
              before: query.beforeEventKey === undefined || query.beforeOccurredAt === undefined
                ? null
                : { eventKey: query.beforeEventKey, occurredAt: query.beforeOccurredAt },
              from: query.from ?? null,
              limit: query.limit ?? 50,
              to: query.to ?? null
            }).pipe(Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable))
          }))
        .handle("detail", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            return yield* timeline.detail({
              workspaceId: session.workspaceId,
              eventKey: params.eventKey
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("exportCsv", ({ query }) => download(query, "csv"))
        .handle("exportJson", ({ query }) => download(query, "json"))
    })
)

/** Authenticated workspace-scoped delivery relationship and evidence handlers. */
export const deliveryGraphHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "deliveryGraph",
  (handlers) =>
    Effect.gen(function*() {
      const inspection = yield* DeliveryGraphInspection
      const repairProposals = yield* RelationshipRepairProposals
      const clockifyActions = Option.getOrUndefined(yield* Effect.serviceOption(ClockifyActionSubmissions))
      return handlers
        .handle("workspaceEntity", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* inspection.workspaceEntity({
              workspaceId: session.workspaceId,
              entityId: params.entityId
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("submitClockifyAction", ({ params, payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (clockifyActions === undefined) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* clockifyActions.submit({
              workspaceId: session.workspaceId,
              entityId: params.entityId,
              request: payload,
              session
            }).pipe(Effect.catchTag(
              "ClockifyActionSubmissionError",
              mapClockifyActionSubmissionError
            ))
          }))
        .handle("workspaceEntityProjections", ({ query }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            return yield* inspection.workspaceEntityProjections({
              workspaceId: session.workspaceId,
              owner: query.owner ?? null,
              query: query.q ?? null,
              service: query.service ?? null,
              status: query.status ?? null,
              type: query.type ?? null
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("releaseSlice", ({ params, query }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* inspection.releaseSlice({
              workspaceId: session.workspaceId,
              releaseId: params.releaseId,
              environmentId: query.environmentId ?? null
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("repairCandidates", ({ params, query }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* inspection.repairCandidates({
              workspaceId: session.workspaceId,
              releaseId: params.releaseId,
              environmentId: query.environmentId ?? null
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("repairProposalDraft", ({ params, query }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* inspection.repairProposalDraft({
              workspaceId: session.workspaceId,
              releaseId: params.releaseId,
              environmentId: query.environmentId ?? null,
              relationshipId: params.relationshipId,
              revision: query.revision
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("createRepairProposal", ({ params, payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            return yield* repairProposals.create({
              workspaceId: session.workspaceId,
              releaseId: params.releaseId,
              relationshipId: params.relationshipId,
              request: payload,
              actor: session.actor,
              sessionId: session.sessionId
            }).pipe(Effect.catchTags({
              ApplicationConflict: mapApplicationConflict,
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("listRepairProposals", ({ params, query }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* repairProposals.list({
              workspaceId: session.workspaceId,
              releaseId: params.releaseId,
              environmentId: query.environmentId ?? null,
              status: query.status ?? null
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("getRepairProposal", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* repairProposals.get({
              workspaceId: session.workspaceId,
              proposalId: params.proposalId
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("reviewRepairProposal", ({ params, payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (
              session.permission !== "workspace-owner" &&
              session.permission !== "workspace-approver"
            ) {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            return yield* repairProposals.review({
              workspaceId: session.workspaceId,
              proposalId: params.proposalId,
              request: payload,
              actor: session.actor,
              sessionId: session.sessionId
            }).pipe(Effect.catchTags({
              ApplicationConflict: mapApplicationConflict,
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("applyRepairProposal", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            if (session.permission !== "workspace-owner") {
              return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            }
            return yield* repairProposals.apply({
              workspaceId: session.workspaceId,
              proposalId: params.proposalId,
              actor: session.actor,
              sessionId: session.sessionId
            }).pipe(Effect.catchTags({
              ApplicationConflict: mapApplicationConflict,
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("relationship", ({ params, query }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* inspection.relationship({
              workspaceId: session.workspaceId,
              relationshipId: params.relationshipId,
              revision: query.revision ?? null
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("relationshipHistory", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* inspection.relationshipHistory({
              workspaceId: session.workspaceId,
              relationshipId: params.relationshipId
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("evidence", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* inspection.evidence({
              workspaceId: session.workspaceId,
              evidenceId: params.evidenceId
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
    })
)

/** Authenticated, workspace-scoped local model turn for one exact release. */
export const agentHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "agent",
  (handlers) =>
    Effect.gen(function*() {
      const agent = yield* ReleaseAgentTurns
      const jobs = yield* ReleaseAgentJobs
      const reviews = yield* PullRequestReviews
      const lifecycle = yield* ServerLifecycle
      return handlers
        .handle("providers", () =>
          lifecycle.runMutation(
            Effect.gen(function*() {
              const session = yield* CurrentSession
              if (session.permission !== "workspace-owner") {
                return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
              }
              return yield* jobs.providers(session.workspaceId).pipe(
                Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable)
              )
            })
          ).pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          ))
        .handle("turn", ({ params, payload }) =>
          lifecycle.runMutation(
            Effect.gen(function*() {
              const session = yield* CurrentSession
              if (session.permission !== "workspace-owner") {
                return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
              }
              return yield* agent.runTurn({
                history: payload.history,
                prompt: payload.prompt,
                provider: payload.provider,
                releaseId: params.releaseId,
                workspaceId: session.workspaceId
              }).pipe(Effect.catchTags({
                ApplicationInvalidRequest: mapApplicationInvalidRequest,
                ApplicationResourceNotFound: mapApplicationNotFound,
                ApplicationServiceUnavailable: mapApplicationUnavailable
              }))
            })
          ).pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          ))
        .handle("enqueueJob", ({ params, payload }) =>
          lifecycle.runMutation(
            Effect.gen(function*() {
              const session = yield* CurrentSession
              if (session.permission !== "workspace-owner") {
                return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
              }
              return yield* jobs.enqueue({
                workspaceId: session.workspaceId,
                releaseId: params.releaseId,
                request: payload
              }).pipe(Effect.catchTags({
                ApplicationInvalidRequest: mapApplicationInvalidRequest,
                ApplicationResourceNotFound: mapApplicationNotFound,
                ApplicationServiceUnavailable: mapApplicationUnavailable
              }))
            })
          ).pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          ))
        .handle("replayThread", ({ params, query }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* jobs.replay({
              workspaceId: session.workspaceId,
              releaseId: params.releaseId,
              after: query.after ?? INITIAL_AGENT_THREAD_CURSOR,
              limit: query.limit ?? DEFAULT_AGENT_THREAD_EVENT_LIMIT
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("pullRequestReview", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* reviews.current({
              workspaceId: session.workspaceId,
              entityId: params.entityId
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("pullRequestReviewThread", ({ params, query }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            if (query.after !== undefined && query.before !== undefined) {
              return yield* Effect.flatMap(invalidRequestApiError, Effect.fail)
            }
            return yield* reviews.thread({
              workspaceId: session.workspaceId,
              entityId: params.entityId,
              after: query.after ?? null,
              before: query.before ?? null,
              limit: query.limit ?? DEFAULT_AGENT_THREAD_EVENT_LIMIT
            }).pipe(Effect.catchTags({
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("enqueuePullRequestReview", ({ params, payload }) =>
          lifecycle.runMutation(
            Effect.gen(function*() {
              const session = yield* CurrentSession
              if (session.permission !== "workspace-owner") {
                return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
              }
              return yield* reviews.enqueue({
                workspaceId: session.workspaceId,
                entityId: params.entityId,
                request: payload
              }).pipe(Effect.catchTags({
                ApplicationInvalidRequest: mapApplicationInvalidRequest,
                ApplicationResourceNotFound: mapApplicationNotFound,
                ApplicationServiceUnavailable: mapApplicationUnavailable
              }))
            })
          ).pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          ))
        .handle("cancelPullRequestReview", ({ params }) =>
          lifecycle.runMutation(
            Effect.gen(function*() {
              const session = yield* CurrentSession
              if (session.permission !== "workspace-owner") {
                return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
              }
              return yield* reviews.cancel({
                workspaceId: session.workspaceId,
                entityId: params.entityId,
                jobId: params.jobId
              }).pipe(Effect.catchTags({
                ApplicationInvalidRequest: mapApplicationInvalidRequest,
                ApplicationResourceNotFound: mapApplicationNotFound,
                ApplicationServiceUnavailable: mapApplicationUnavailable
              }))
            })
          ).pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          ))
        .handle("extendPullRequestReviewBudget", ({ params }) =>
          lifecycle.runMutation(
            Effect.gen(function*() {
              const session = yield* CurrentSession
              if (session.permission !== "workspace-owner") {
                return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
              }
              return yield* reviews.extendBudget({
                workspaceId: session.workspaceId,
                entityId: params.entityId,
                jobId: params.jobId
              }).pipe(Effect.catchTags({
                ApplicationInvalidRequest: mapApplicationInvalidRequest,
                ApplicationResourceNotFound: mapApplicationNotFound,
                ApplicationServiceUnavailable: mapApplicationUnavailable
              }))
            })
          ).pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          ))
        .handle("reviewSuggestionRevisions", ({ params, query }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            return yield* reviews.revisions({
              workspaceId: session.workspaceId,
              entityId: params.entityId,
              jobId: params.jobId,
              suggestionId: params.suggestionId,
              beforeSequence: query.before ?? null,
              limit: query.limit ?? DEFAULT_REVIEW_SUGGESTION_REVISION_LIMIT
            }).pipe(Effect.catchTags({
              ApplicationInvalidRequest: mapApplicationInvalidRequest,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("editReviewSuggestion", ({ params, payload }) =>
          lifecycle.runMutation(
            Effect.gen(function*() {
              const session = yield* CurrentSession
              if (
                session.actor._tag !== "human" ||
                session.permission !== "workspace-owner"
              ) {
                return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
              }
              return yield* reviews.editSuggestion({
                workspaceId: session.workspaceId,
                entityId: params.entityId,
                jobId: params.jobId,
                suggestionId: params.suggestionId,
                request: payload,
                session
              }).pipe(Effect.catchTags({
                ApplicationConflict: mapApplicationConflict,
                ApplicationInvalidRequest: mapApplicationInvalidRequest,
                ApplicationResourceNotFound: mapApplicationNotFound,
                ApplicationServiceUnavailable: mapApplicationUnavailable
              }))
            })
          ).pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          ))
        .handle("dismissReviewSuggestion", ({ params, payload }) =>
          lifecycle.runMutation(
            Effect.gen(function*() {
              const session = yield* CurrentSession
              if (
                session.actor._tag !== "human" ||
                session.permission !== "workspace-owner"
              ) {
                return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
              }
              return yield* reviews.dismissSuggestion({
                workspaceId: session.workspaceId,
                entityId: params.entityId,
                jobId: params.jobId,
                suggestionId: params.suggestionId,
                request: payload,
                session
              }).pipe(Effect.catchTags({
                ApplicationConflict: mapApplicationConflict,
                ApplicationInvalidRequest: mapApplicationInvalidRequest,
                ApplicationResourceNotFound: mapApplicationNotFound,
                ApplicationServiceUnavailable: mapApplicationUnavailable
              }))
            })
          ).pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          ))
        .handle("previewReviewSuggestionPublication", ({ params, query }) =>
          lifecycle.runMutation(
            Effect.gen(function*() {
              const session = yield* CurrentSession
              if (session.actor._tag !== "human") {
                return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
              }
              yield* requireWorkspaceRead(session)
              return yield* reviews.previewPublication({
                workspaceId: session.workspaceId,
                entityId: params.entityId,
                jobId: params.jobId,
                suggestionId: params.suggestionId,
                revisionId: query.revisionId,
                publishingOperator: session.actor.personId
              }).pipe(Effect.catchTags({
                ApplicationInvalidRequest: mapApplicationInvalidRequest,
                ApplicationResourceNotFound: mapApplicationNotFound,
                ApplicationServiceUnavailable: mapApplicationUnavailable
              }))
            })
          ).pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          ))
        .handle("publishReviewSuggestion", ({ params, payload }) =>
          lifecycle.runMutation(
            Effect.gen(function*() {
              const session = yield* CurrentSession
              if (
                session.actor._tag !== "human" ||
                session.permission !== "workspace-owner"
              ) {
                return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
              }
              return yield* reviews.publishSuggestion({
                workspaceId: session.workspaceId,
                entityId: params.entityId,
                request: payload,
                session
              }).pipe(Effect.catchTags({
                ApplicationInvalidRequest: mapApplicationInvalidRequest,
                ApplicationResourceNotFound: mapApplicationNotFound,
                ApplicationServiceUnavailable: mapApplicationUnavailable
              }))
            })
          ).pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          ))
    })
)

/** Authenticated durable event replay with bounded wakeups and periodic session revalidation. */
export const liveEventHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "liveEvents",
  (handlers) =>
    Effect.gen(function*() {
      const events = yield* LiveEvents
      const auth = yield* Auth
      const admission = yield* LiveStreamAdmission
      const lifecycle = yield* ServerLifecycle
      return handlers.handle("stream", ({ headers, query, request }) =>
        Effect.gen(function*() {
          const session = yield* CurrentSession
          yield* requireWorkspaceRead(session)
          yield* lifecycle.acquireStream.pipe(
            Effect.catchTag(
              "ServerDraining",
              () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            )
          )
          const queryCursor = query.after
          const headerCursor = headers["last-event-id"]
          if (queryCursor !== undefined && headerCursor !== undefined && queryCursor !== headerCursor) {
            return yield* Effect.flatMap(invalidRequestApiError, Effect.fail)
          }
          yield* admission.acquire(session.sessionId).pipe(
            Effect.catchTag(
              "LiveStreamAdmissionExceeded",
              () => Effect.flatMap(liveStreamCapacityApiError, Effect.fail)
            )
          )
          const eventStream = yield* events.open({
            workspaceId: session.workspaceId,
            after: queryCursor ?? headerCursor
          }).pipe(Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable))
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(HttpServerResponse.setHeaders(response, {
              "cache-control": "private, no-store",
              "x-accel-buffering": "no"
            }))
          )
          const token = currentSessionToken(request)
          return eventStream.pipe(
            Stream.interruptWhen(Effect.race(awaitSessionEnd(auth, token, session), lifecycle.awaitDrain))
          )
        }))
    })
)

const validMediaMetadata = (contentLength: number, contentType: string): boolean =>
  Number.isSafeInteger(contentLength) &&
  contentLength >= 0 &&
  Schema.is(SafeMediaContentType)(contentType)

/** Authenticated opaque media handler with no-store and nosniff response policy. */
export const mediaHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "media",
  (handlers) =>
    Effect.gen(function*() {
      const mediaReads = yield* MediaReads
      return handlers.handle("read", ({ params }) =>
        Effect.gen(function*() {
          const session = yield* CurrentSession
          yield* requireWorkspaceRead(session)
          const media = yield* mediaReads.read({
            mediaId: params.mediaId,
            workspaceId: session.workspaceId
          }).pipe(Effect.catchTags({
            ApplicationResourceNotFound: mapApplicationNotFound,
            ApplicationServiceUnavailable: mapApplicationUnavailable
          }))
          if (!validMediaMetadata(media.contentLength, media.contentType)) {
            return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
          }
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(HttpServerResponse.setHeaders(response, {
              "cache-control": "private, no-store",
              "content-length": String(media.contentLength),
              "content-type": media.contentType,
              "x-content-type-options": "nosniff"
            }))
          )
          return media.body
        }))
    })
)

/** Authenticated workspace-scoped CodePipeline log and artifact proxy handlers. */
export const codePipelineHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "codepipeline",
  (handlers) =>
    Effect.gen(function*() {
      const reads = yield* Effect.serviceOption(CodePipelineReads)
      const mapReadErrors = <A, R>(
        effect: Effect.Effect<
          A,
          | ApplicationConflict
          | ApplicationRateLimited
          | ApplicationResourceNotFound
          | ApplicationServiceUnavailable,
          R
        >
      ) =>
        effect.pipe(Effect.catchTags({
          ApplicationConflict: mapApplicationConflict,
          ApplicationRateLimited: mapApplicationRateLimited,
          ApplicationResourceNotFound: mapApplicationNotFound,
          ApplicationServiceUnavailable: mapApplicationUnavailable
        }))
      return handlers
        .handle("logs", ({ payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            if (Option.isNone(reads)) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            return yield* mapReadErrors(reads.value.logs({
              workspaceId: session.workspaceId,
              pluginConnectionId: payload.pluginConnectionId,
              request: payload.request
            }))
          }))
        .handle("artifact", ({ payload }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            yield* requireWorkspaceRead(session)
            if (Option.isNone(reads)) {
              return yield* Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
            }
            const artifact = yield* mapReadErrors(reads.value.artifact({
              workspaceId: session.workspaceId,
              pluginConnectionId: payload.pluginConnectionId,
              request: payload.request
            }))
            const rangeUnsatisfied = artifact.contentLength === 0 && artifact.offset >= artifact.totalBytes
            const partial = !rangeUnsatisfied &&
              (artifact.offset > 0 || artifact.contentLength < artifact.totalBytes)
            const contentRange = rangeUnsatisfied
              ? `bytes */${String(artifact.totalBytes)}`
              : `bytes ${String(artifact.offset)}-${String(artifact.offset + artifact.contentLength - 1)}/${
                String(artifact.totalBytes)
              }`
            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(
                HttpServerResponse.setHeaders(
                  rangeUnsatisfied
                    ? HttpServerResponse.setStatus(response, 416)
                    : partial
                    ? HttpServerResponse.setStatus(response, 206)
                    : response,
                  {
                    "cache-control": "private, no-store",
                    "content-disposition": `attachment; filename="${artifact.filename}"`,
                    "content-length": String(artifact.contentLength),
                    ...(partial || rangeUnsatisfied ? { "content-range": contentRange } : {}),
                    "content-type": "application/octet-stream",
                    "x-content-type-options": "nosniff"
                  }
                )
              )
            )
            return artifact.body
          }))
    })
)
