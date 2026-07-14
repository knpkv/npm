import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
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
import { MediaReads, PluginAdministration, PortfolioSnapshots } from "./ApplicationServices.js"
import {
  forbiddenApiError,
  mapApplicationConflict,
  mapApplicationInvalidRequest,
  mapApplicationNotFound,
  mapApplicationRateLimited,
  mapApplicationUnavailable,
  mapAuthenticationFailures,
  mapCredentialAuthenticationFailures,
  serviceUnavailableApiError
} from "./ErrorMapping.js"

const sessionCookie = HttpApiSecurity.apiKey({ in: "cookie", key: "cc_session" })

const currentSessionToken = (request: { readonly cookies: Readonly<Record<string, string | undefined>> }) =>
  Redacted.make(request.cookies.cc_session ?? "")

/** Session pairing, inspection, administration, and logout handlers. */
export const sessionHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "session",
  (handlers) =>
    handlers
      .handle("pair", ({ payload }) =>
        Effect.gen(function*() {
          yield* authorizePairingRequest()
          const auth = yield* Auth
          const config = yield* ApiBindConfiguration
          const issued = yield* mapCredentialAuthenticationFailures(
            auth.consumePairingCode(Redacted.make(payload.pairingCode))
          )
          const cookie = sessionCookiePolicy(config)
          yield* HttpApiBuilder.securitySetCookie(sessionCookie, issued.sessionToken, cookie)
          return {
            csrfToken: CsrfToken.make(Redacted.value(issued.csrfToken)),
            session: issued.session
          }
        }))
      .handle("current", () => CurrentSession)
      .handle("list", ({ request }) =>
        Effect.gen(function*() {
          const auth = yield* Auth
          return yield* mapAuthenticationFailures(
            auth.listSessions(currentSessionToken(request))
          )
        }))
      .handle("revoke", ({ params, request }) =>
        Effect.gen(function*() {
          const auth = yield* Auth
          yield* mapAuthenticationFailures(
            auth.revokeSession(currentSessionToken(request), params.sessionId)
          )
        }))
      .handle("logout", ({ request }) =>
        Effect.gen(function*() {
          const auth = yield* Auth
          const config = yield* ApiBindConfiguration
          yield* mapAuthenticationFailures(auth.logout(currentSessionToken(request)))
          const cookie = sessionCookiePolicy(config)
          yield* HttpApiBuilder.securitySetCookie(sessionCookie, "", {
            ...cookie,
            maxAge: 0
          })
        }))
)

/** Secret-free plugin list, health, and configuration metadata handlers. */
export const pluginHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "plugins",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function*() {
          const session = yield* CurrentSession
          const plugins = yield* PluginAdministration
          return yield* plugins.list(session.workspaceId).pipe(
            Effect.catchTag("ApplicationServiceUnavailable", mapApplicationUnavailable)
          )
        }))
      .handle("health", ({ params }) =>
        Effect.gen(function*() {
          const session = yield* CurrentSession
          const plugins = yield* PluginAdministration
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
          const plugins = yield* PluginAdministration
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
          const plugins = yield* PluginAdministration
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
          const plugins = yield* PluginAdministration
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

const validMediaMetadata = (contentLength: number, contentType: string): boolean =>
  Number.isSafeInteger(contentLength) &&
  contentLength >= 0 &&
  Schema.is(SafeMediaContentType)(contentType)

/** Authenticated opaque media handler with no-store and nosniff response policy. */
export const mediaHandlersLayer = HttpApiBuilder.group(
  ControlCenterApi,
  "media",
  (handlers) =>
    handlers.handle("read", ({ params }) =>
      Effect.gen(function*() {
        const session = yield* CurrentSession
        const mediaReads = yield* MediaReads
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
)
