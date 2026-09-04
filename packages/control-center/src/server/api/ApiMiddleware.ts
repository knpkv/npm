import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"

import {
  CurrentSession,
  CurrentSessionToken,
  SessionCookieAuth,
  SessionMutationAuth,
  SessionToken
} from "../../api/session.js"
import { Auth } from "../auth/Auth.js"
import { CredentialRejectedError } from "../auth/errors.js"
import type {
  AuthCryptoError,
  AuthPermissionDeniedError,
  AuthPersistenceError,
  CredentialRejectedError as CredentialRejectedErrorType
} from "../auth/errors.js"
import { ServerLifecycle } from "../runtime/ServerLifecycle.js"
import {
  authorizeAuthenticatedMutation,
  authorizeAuthenticatedRead,
  authorizeAuthenticatedReadPost,
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

const requestContract = (request: HttpServerRequest.HttpServerRequest) => ({
  method: request.method,
  host: request.headers.host ?? "",
  origin: request.headers.origin ?? null,
  csrfToken: request.headers["x-csrf-token"] ?? null,
  forwardedHost: request.headers["x-forwarded-host"] ?? null,
  forwardedProto: request.headers["x-forwarded-proto"] ?? null,
  remoteAddress: Option.getOrNull(request.remoteAddress)
})

const decodeSessionToken = (value: string | undefined): Option.Option<Redacted.Redacted<SessionToken>> =>
  value === undefined
    ? Option.none()
    : Schema.decodeUnknownOption(SessionToken)(value).pipe(Option.map(Redacted.make))

const capabilityFor = (groupIdentifier: string, endpointIdentifier: string): InsecureLanCapability => {
  switch (groupIdentifier) {
    case "media":
    case "portfolio":
    case "codepipeline":
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

/** Identify safe reads, including the one bounded body transport represented by POST. */
export const isAuthenticatedReadTransportEndpoint = (
  groupIdentifier: string,
  endpointIdentifier: string,
  method: string
): boolean =>
  method === "GET" ||
  method === "HEAD" ||
  method === "OPTIONS" ||
  (method === "POST" && (
    (groupIdentifier === "diff" && endpointIdentifier === "content") ||
    (groupIdentifier === "codepipeline" && (
      endpointIdentifier === "logs" ||
      endpointIdentifier === "artifact"
    ))
  ))

/** Guard the sole unauthenticated endpoint with the same authority and Origin policy. */
export const authorizePairingRequest = Effect.fn("ApiMiddleware.authorizePairing")(function*() {
  const config = yield* ApiBindConfiguration
  const request = yield* HttpServerRequest.HttpServerRequest
  yield* authorizeRequest(config, requestContract(request), "public-pair").pipe(
    Effect.catchTag("RequestSecurityError", mapPairingSecurityFailure)
  )
})

/** Authenticate `cc_session`, apply read transport policy, and provide secret-free session metadata. */
export const sessionCookieAuthLayer = Layer.effect(
  SessionCookieAuth,
  Effect.gen(function*() {
    const auth = yield* Auth
    const config = yield* ApiBindConfiguration
    const lifecycle = yield* ServerLifecycle
    return {
      sessionCookie: (effect, { credential, endpoint, group }) =>
        lifecycle.runMutation(
          Effect.gen(function*() {
            const request = yield* HttpServerRequest.HttpServerRequest
            if (isAuthenticatedReadTransportEndpoint(group.identifier, endpoint.identifier, endpoint.method)) {
              const authorizeRead = endpoint.method === "POST"
                ? authorizeAuthenticatedReadPost
                : authorizeAuthenticatedRead
              yield* authorizeRead({
                capability: capabilityFor(group.identifier, endpoint.identifier),
                config,
                request: requestContract(request)
              }).pipe(Effect.catchTag("RequestSecurityError", mapReadSecurityFailure))
            }
            const sessionToken = decodeSessionToken(Redacted.value(credential))
            if (Option.isNone(sessionToken)) {
              return yield* mapAuthenticationFailures(Effect.fail(new CredentialRejectedError()))
            }
            const session = yield* mapAuthenticationFailures(auth.authenticate(sessionToken.value))
            return yield* Effect.provideService(
              Effect.provideService(effect, CurrentSession, session),
              CurrentSessionToken,
              sessionToken.value
            )
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

const mapMutationAuthenticationFailure = (
  _error: AuthCryptoError | AuthPermissionDeniedError | AuthPersistenceError | CredentialRejectedErrorType
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
            const sessionToken = decodeSessionToken(request.cookies.cc_session)
            if (Option.isNone(sessionToken)) return yield* Effect.flatMap(forbiddenApiError, Effect.fail)
            yield* authorizeAuthenticatedMutation(
              {
                capability: capabilityFor(group.identifier, endpoint.identifier),
                config,
                request: {
                  ...requestContract(request),
                  csrfToken: Redacted.value(credential)
                }
              },
              (csrfToken) =>
                auth.authorizeMutation(sessionToken.value, csrfToken).pipe(
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
