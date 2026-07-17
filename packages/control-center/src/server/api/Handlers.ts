import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpEffect from "effect/unstable/http/HttpEffect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder, HttpApiSecurity } from "effect/unstable/httpapi"

import { ControlCenterApi } from "../../api/controlCenterApi.js"
import { SafeMediaContentType } from "../../api/media.js"
import { CsrfToken, CurrentSession } from "../../api/session.js"
import { Auth } from "../auth/Auth.js"
import { sessionCookiePolicy } from "../security/RequestSecurity.js"
import { ApiBindConfiguration } from "./ApiConfiguration.js"
import { authorizePairingRequest } from "./ApiMiddleware.js"
import {
  DeliveryGraphInspection,
  LiveEvents,
  MediaReads,
  PluginAdministration,
  PortfolioSnapshots,
  RelationshipRepairProposals,
  ReleaseAgentTurns
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
  serviceUnavailableApiError
} from "./ErrorMapping.js"
import { LiveStreamAdmission } from "./LiveStreamAdmission.js"

const sessionCookie = HttpApiSecurity.apiKey({ in: "cookie", key: "cc_session" })

const currentSessionToken = (request: { readonly cookies: Readonly<Record<string, string | undefined>> }) =>
  Redacted.make(request.cookies.cc_session ?? "")

const SESSION_REAUTHENTICATION_INTERVAL = Duration.seconds(25)

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
      return handlers
        .handle("pair", ({ payload }) =>
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
          }))
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
            return yield* plugins.list(session.workspaceId).pipe(
              Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable)
            )
          }))
        .handle("health", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
            return yield* plugins.health({
              pluginConnectionId: params.pluginConnectionId,
              workspaceId: session.workspaceId
            }).pipe(Effect.catchTags({
              ApplicationRateLimited: mapApplicationRateLimited,
              ApplicationResourceNotFound: mapApplicationNotFound,
              ApplicationServiceUnavailable: mapApplicationUnavailable
            }))
          }))
        .handle("configurationMetadata", ({ params }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
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
          return yield* portfolio.snapshot(session.workspaceId).pipe(
            Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable)
          )
        }))
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
      return handlers
        .handle("workspaceEntityProjections", ({ query }) =>
          Effect.gen(function*() {
            const session = yield* CurrentSession
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
      return handlers.handle("turn", ({ params, payload }) =>
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
            ApplicationResourceNotFound: mapApplicationNotFound,
            ApplicationServiceUnavailable: mapApplicationUnavailable
          }))
        }))
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
      return handlers.handle("stream", ({ headers, query, request }) =>
        Effect.gen(function*() {
          const session = yield* CurrentSession
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
          return eventStream.pipe(Stream.interruptWhen(awaitSessionEnd(auth, token, session)))
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
