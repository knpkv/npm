import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"

import { CurrentSession, SessionCookieAuth, SessionMutationAuth } from "../../api/session.js"
import { Auth } from "../auth/Auth.js"
import type {
  AuthCryptoError,
  AuthPermissionDeniedError,
  AuthPersistenceError,
  CredentialRejectedError
} from "../auth/errors.js"
import { ServerLifecycle } from "../runtime/ServerLifecycle.js"
import {
  authorizeAuthenticatedMutation,
  authorizeAuthenticatedRead,
  authorizeRequest,
  type InsecureLanCapability
} from "../security/RequestSecurity.js"
import { ApiBindConfiguration } from "./ApiConfiguration.js"
import {
  forbiddenApiError,
  mapAuthenticationFailures,
  mapMutationSecurityFailure,
  mapPairingSecurityFailure,
  mapReadSecurityFailure,
  serviceUnavailableApiError
} from "./ErrorMapping.js"

const requestShape = (request: HttpServerRequest.HttpServerRequest) => ({
  method: request.method,
  host: request.headers.host ?? "",
  origin: request.headers.origin ?? null,
  csrfToken: request.headers["x-csrf-token"] ?? null,
  forwardedHost: request.headers["x-forwarded-host"] ?? null,
  forwardedProto: request.headers["x-forwarded-proto"] ?? null,
  remoteAddress: Option.getOrNull(request.remoteAddress)
})

const capabilityFor = (groupIdentifier: string, endpointIdentifier: string): InsecureLanCapability => {
  switch (groupIdentifier) {
    case "media":
    case "portfolio":
    case "liveEvents":
      return "release-read"
    case "agent":
      return "release-agent"
    case "plugins":
      return "provider-configuration"
    case "session":
      return endpointIdentifier === "current" ? "session-self-read" : "session-administration"
    case "shares":
      return endpointIdentifier === "resolve" ? "release-read" : "policy-administration"
    default:
      return "policy-administration"
  }
}

/** Guard the sole unauthenticated endpoint with the same authority and Origin policy. */
export const authorizePairingRequest = Effect.fn("ApiMiddleware.authorizePairing")(function*() {
  const config = yield* ApiBindConfiguration
  const request = yield* HttpServerRequest.HttpServerRequest
  yield* authorizeRequest(config, requestShape(request), "public-pair").pipe(
    Effect.catchTag("RequestSecurityError", mapPairingSecurityFailure)
  )
})

/** Authenticate `cc_session`, apply read transport policy, and provide secret-free session metadata. */
export const sessionCookieAuthLayer = Layer.effect(
  SessionCookieAuth,
  Effect.gen(function*() {
    const auth = yield* Auth
    const config = yield* ApiBindConfiguration
    return {
      sessionCookie: (effect, { credential, endpoint, group }) =>
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (endpoint.method === "GET" || endpoint.method === "HEAD" || endpoint.method === "OPTIONS") {
            yield* authorizeAuthenticatedRead({
              capability: capabilityFor(group.identifier, endpoint.identifier),
              config,
              request: requestShape(request)
            }).pipe(Effect.catchTag("RequestSecurityError", mapReadSecurityFailure))
          }
          const session = yield* mapAuthenticationFailures(auth.authenticate(credential))
          return yield* Effect.provideService(effect, CurrentSession, session)
        })
    }
  })
)

const mapMutationAuthenticationFailure = (
  _error: AuthCryptoError | AuthPermissionDeniedError | AuthPersistenceError | CredentialRejectedError
) => Effect.flatMap(forbiddenApiError, Effect.fail)

/** Require an independent CSRF credential and re-authorize the cookie-owned session. */
export const mutationCsrfLayer = Layer.effect(
  SessionMutationAuth,
  Effect.gen(function*() {
    const auth = yield* Auth
    const config = yield* ApiBindConfiguration
    const lifecycle = yield* ServerLifecycle
    return {
      csrfToken: (effect, { credential, endpoint, group }) =>
        lifecycle.runMutation(
          Effect.gen(function*() {
            const request = yield* HttpServerRequest.HttpServerRequest
            const sessionToken = Redacted.make(request.cookies.cc_session ?? "")
            yield* authorizeAuthenticatedMutation(
              {
                capability: capabilityFor(group.identifier, endpoint.identifier),
                config,
                request: {
                  ...requestShape(request),
                  csrfToken: Redacted.value(credential)
                }
              },
              (csrfToken) =>
                auth.authorizeMutation(sessionToken, csrfToken).pipe(
                  Effect.catchTags({
                    AuthCryptoError: mapMutationAuthenticationFailure,
                    AuthPersistenceError: mapMutationAuthenticationFailure,
                    CredentialRejectedError: mapMutationAuthenticationFailure
                  })
                )
            ).pipe(Effect.catchTag("RequestSecurityError", mapMutationSecurityFailure))
            return yield* effect
          })
        ).pipe(
          Effect.catchTag(
            "ServerDraining",
            () => Effect.flatMap(serviceUnavailableApiError(), Effect.fail)
          )
        )
    }
  })
)
