/**
 * Who may talk to this server.
 *
 * **Mental model**
 *
 * - **One process, one operator.** The server binds a loopback address and mints a session token for
 *   itself at startup. There is no user table and no login: the person who can read the terminal is
 *   the person who gets in, which is the authority a page showing their own agents' usage, ticket
 *   keys and working directories should demand.
 * - **The URL is the handshake.** A bootstrap code rides in a fragment the browser never sends
 *   upstream and is spent the first time it is exchanged for the session cookie. One is minted when
 *   the server starts and another each time `agent-usage login` asks over the control socket; both
 *   go through {@link mintBootstrapUrl}, and a newer code replaces an unspent one.
 * - **Every route only reads, and a read needs the cookie and must not be a browser cross-origin
 *   request.** Another page in the same browser can make the browser send a cookie, but Fetch
 *   Metadata keeps that page from reading usage without an Origin. With no writes there is no CSRF
 *   token to issue.
 *
 * The rules are `@knpkv/jcf-web`'s owner session minus its write path, over the same
 * `@knpkv/browser-pairing` credential primitives. They are re-stated rather than imported because
 * that module is private to that application; duplicating the *policy* while sharing the
 * *primitives* is the smaller of the two mistakes available.
 *
 * @module
 */
import {
  credentialValuesEqual,
  decideOneTimeCredential,
  expiresAt,
  issuePairingCode,
  issueSessionToken,
  serializeCredentialCookie
} from "@knpkv/browser-pairing"
import type { PairingCode, SessionToken } from "@knpkv/browser-pairing/schema"
import { Clock, Context, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { ForbiddenApiError, OwnerSessionAuth, UnauthorizedApiError } from "./Api.js"

/** How long a minted bootstrap URL stays usable. Long enough to click, short enough to forget. */
const BOOTSTRAP_LIFETIME_MILLIS = 60_000

/**
 * Failed bootstrap exchanges before the exchange closes, until the owner mints a new code.
 *
 * The code is high-entropy, so this is not what makes guessing hard — it is what stops a process
 * that is being guessed at from staying open all afternoon.
 */
const MAX_BOOTSTRAP_FAILURES = 5

/** Methods that only read: the only ones this server answers on its API. */
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * The one origin other than the bound server that may hold a session: the Vite dev server, which
 * proxies both the API and the bootstrap exchange, so the browser stays on a single origin.
 */
const devPublicOrigin = "http://localhost:5173"

/** One minted code: what to compare, until when, and whether it has been spent. */
export interface BootstrapCode {
  readonly token: Redacted.Redacted<PairingCode>
  readonly expiresAt: number
  readonly available: boolean
}

export interface BootstrapAttemptState {
  readonly failedAttempts: number
  readonly inFlight: number
}

export interface OwnerSessionSecretsContract {
  /** The origin this server considers itself to be. A request's Host header is never authoritative. */
  readonly authorityOrigin: string
  /**
   * The origin the browser is expected to present. Same as the authority in production; the Vite
   * dev server when it proxies in front of it, because that is the origin the page runs on.
   */
  readonly browserOrigin: string
  /** The current one-time code, or none before the first mint. */
  readonly bootstrap: Ref.Ref<BootstrapCode | undefined>
  readonly bootstrapAttemptState: Ref.Ref<BootstrapAttemptState>
  readonly ownerToken: Redacted.Redacted<SessionToken>
}

export class OwnerSessionSecrets extends Context.Service<
  OwnerSessionSecrets,
  OwnerSessionSecretsContract
>()("@knpkv/agent-usage/OwnerSessionSecrets") {}

export class UnsafeServerOriginError extends Schema.TaggedError<UnsafeServerOriginError>()(
  "UnsafeServerOriginError",
  { message: Schema.String, origin: Schema.String }
) {}

export const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]"

export const ownerSessionOrigin = (hostname: string, port: number): string =>
  `http://${hostname === "::1" ? "[::1]" : hostname}:${port}`

export const requireLoopbackOrigin = Effect.fn("OwnerSession.requireLoopbackOrigin")(
  function*(origin: string) {
    const url = yield* Effect.try({
      catch: () => new UnsafeServerOriginError({ message: "agent-usage needs a valid HTTP origin", origin }),
      try: () => new URL(origin)
    })
    if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname) || url.search !== "" || url.hash !== "") {
      return yield* new UnsafeServerOriginError({
        message: "agent-usage may only be reached over HTTP on a loopback host",
        origin
      })
    }
    return url.origin
  }
)

/** The advertised origin: the bound server, or the dev server that proxies to it. */
export const resolvePublicOrigin = Effect.fn("OwnerSession.resolvePublicOrigin")(
  function*(configuredOrigin: string | undefined, authorityOrigin: string) {
    const authority = yield* requireLoopbackOrigin(authorityOrigin)
    if (configuredOrigin === undefined) return authority
    const configured = yield* requireLoopbackOrigin(configuredOrigin)
    if (configured !== authority && configured !== devPublicOrigin) {
      return yield* new UnsafeServerOriginError({
        message: "agent-usage's public origin must be the bound server or its dev proxy",
        origin: configuredOrigin
      })
    }
    return configured
  }
)

export const makeOwnerSessionSecrets = Effect.fn("OwnerSession.makeSecrets")(
  function*(authorityOrigin: string, configuredPublicOrigin?: string) {
    const validated = yield* requireLoopbackOrigin(authorityOrigin)
    const browserOrigin = yield* resolvePublicOrigin(configuredPublicOrigin, validated)
    const ownerToken = yield* issueSessionToken()
    return OwnerSessionSecrets.of({
      authorityOrigin: validated,
      bootstrap: yield* Ref.make<BootstrapCode | undefined>(undefined),
      bootstrapAttemptState: yield* Ref.make<BootstrapAttemptState>({ failedAttempts: 0, inFlight: 0 }),
      browserOrigin,
      ownerToken
    })
  }
)

/**
 * Mints a fresh one-time code and returns the URL that carries it: usable once, for a minute. The
 * startup link and every `agent-usage login` link come from here; a newer code replaces any unspent
 * one and reopens an exchange that guesses had closed. Call it only once the server is listening.
 *
 * The code rides in the fragment, which browsers do not send to servers and proxies do not log,
 * and the page strips it from the address bar once it has been spent.
 */
export const mintBootstrapUrl = Effect.fn("OwnerSession.mintBootstrapUrl")(
  function*(secrets: OwnerSessionSecretsContract) {
    const token = yield* issuePairingCode()
    const now = yield* Clock.currentTimeMillis
    const until = yield* expiresAt(now, BOOTSTRAP_LIFETIME_MILLIS)
    yield* Ref.set(secrets.bootstrap, { token, expiresAt: until, available: true })
    yield* Ref.set(secrets.bootstrapAttemptState, { failedAttempts: 0, inFlight: 0 })
    return `${secrets.browserOrigin.replace(/\/+$/u, "")}/#bootstrap_token=${encodeURIComponent(Redacted.value(token))}`
  }
)

export const ownerSessionCookie = (secrets: Pick<OwnerSessionSecretsContract, "ownerToken">): string =>
  serializeCredentialCookie(secrets.ownerToken, {
    httpOnly: true,
    name: "agent_usage_owner",
    path: "/api",
    sameSite: "strict",
    secure: false
  })

interface OwnerRequest {
  readonly credential: string
  readonly fetchSite: string | undefined
  readonly method: string
  readonly origin: string | undefined
}

const fetchSites = new Set(["cross-site", "none", "same-origin", "same-site"])

export const authorizeOwnerRequest = Effect.fn("OwnerSession.authorizeRequest")(
  function*(request: OwnerRequest, secrets: OwnerSessionSecretsContract) {
    if (credentialValuesEqual(request.credential, Redacted.value(secrets.ownerToken)) !== true) {
      return yield* new UnauthorizedApiError({ message: "Missing or invalid owner session" })
    }
    const sameOrigin = request.origin !== undefined && request.origin === secrets.browserOrigin
    if (request.origin !== undefined && !sameOrigin) {
      return yield* new ForbiddenApiError({ message: "Request origin does not match this agent-usage server" })
    }
    if (request.fetchSite !== undefined && !fetchSites.has(request.fetchSite)) {
      return yield* new ForbiddenApiError({ message: "Request carries invalid browser site metadata" })
    }
    if (
      request.fetchSite === "cross-site" ||
      (!sameOrigin && (request.fetchSite === "same-site" || request.fetchSite === "none"))
    ) {
      return yield* new ForbiddenApiError({ message: "Browser request is not from this agent-usage page" })
    }
    // An explicit client such as curl carries neither Origin nor Fetch Metadata and remains allowed:
    // it still has to present the process-scoped session cookie.
    if (!safeMethods.has(request.method.toUpperCase())) {
      return yield* new ForbiddenApiError({ message: "This server only answers reads" })
    }
  }
)

type BootstrapAdmission = "unavailable" | "invalid" | "accepted"

const bearerToken = (authorization: string | undefined): string | undefined =>
  authorization !== undefined && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined

export const authorizeBootstrapRequest = Effect.fn("OwnerSession.authorizeBootstrap")(
  function*(
    request: { readonly authorization: string | undefined; readonly origin: string | undefined },
    secrets: OwnerSessionSecretsContract
  ) {
    if (request.origin !== secrets.browserOrigin) {
      return yield* new ForbiddenApiError({ message: "Bootstrap origin does not match this agent-usage server" })
    }
    const supplied = bearerToken(request.authorization)
    const current = yield* Ref.get(secrets.bootstrap)
    // Counted before the code is even compared, so a burst of parallel guesses cannot all pass the
    // check together and then be counted afterwards.
    const admit = Ref.modify(
      secrets.bootstrapAttemptState,
      (state): readonly [BootstrapAdmission, BootstrapAttemptState] => {
        if (state.failedAttempts + state.inFlight >= MAX_BOOTSTRAP_FAILURES) return ["unavailable", state]
        const matches = supplied !== undefined && current !== undefined &&
          credentialValuesEqual(supplied, Redacted.value(current.token)) === true
        if (!matches) {
          return ["invalid", {
            failedAttempts: Math.min(MAX_BOOTSTRAP_FAILURES, state.failedAttempts + 1),
            inFlight: state.inFlight
          }]
        }
        return ["accepted", { ...state, inFlight: state.inFlight + 1 }]
      }
    ).pipe(
      Effect.flatMap((admission) =>
        admission === "unavailable"
          ? Effect.fail(new UnauthorizedApiError({ message: "Bootstrap is closed for this process" }))
          : admission === "invalid"
          ? Effect.fail(new UnauthorizedApiError({ message: "Missing or invalid bootstrap token" }))
          : Effect.void
      )
    )
    return yield* Effect.acquireUseRelease(
      admit,
      () =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          // Spent only if it is still the code that was compared: a newer mint replaced it otherwise.
          const decision = yield* Ref.modify(secrets.bootstrap, (code) => {
            if (code === undefined || current === undefined || code.token !== current.token) {
              return ["consumed", code]
            }
            const next = decideOneTimeCredential(
              { consumedAt: code.available ? null : 0, expiresAt: code.expiresAt, revokedAt: null },
              now
            )
            return [next, next === "accepted" ? { ...code, available: false } : code]
          })
          if (decision === "accepted") return
          const message = decision === "expired"
            ? "Bootstrap token has expired — run agent-usage login for a fresh URL"
            : decision === "consumed"
            ? "Bootstrap token has already been used"
            : "Bootstrap token state is invalid"
          return yield* new UnauthorizedApiError({ message })
        }),
      () =>
        Ref.update(secrets.bootstrapAttemptState, (state) => ({ ...state, inFlight: Math.max(0, state.inFlight - 1) }))
    )
  }
)

export const ownerSessionAuthLayer = Layer.effect(
  OwnerSessionAuth,
  Effect.gen(function*() {
    const secrets = yield* OwnerSessionSecrets
    return OwnerSessionAuth.of({
      ownerCookie: Effect.fn("OwnerSession.ownerCookie")(
        function*(httpEffect, { credential }) {
          const request = yield* HttpServerRequest.HttpServerRequest
          yield* authorizeOwnerRequest(
            {
              credential: Redacted.value(credential),
              fetchSite: request.headers["sec-fetch-site"],
              method: request.method,
              origin: request.headers.origin
            },
            secrets
          )
          return yield* httpEffect
        }
      )
    })
  })
)

/** The one route outside the authenticated API: spending the printed code for a session. */
export const OwnerSessionBootstrapRouter = HttpRouter.use((router) =>
  router.add(
    "POST",
    "/auth/bootstrap",
    Effect.gen(function*() {
      const secrets = yield* OwnerSessionSecrets
      const request = yield* HttpServerRequest.HttpServerRequest
      const result = yield* Effect.result(
        authorizeBootstrapRequest(
          { authorization: request.headers.authorization, origin: request.headers.origin },
          secrets
        )
      )
      if (result._tag === "Failure") {
        return HttpServerResponse.text(result.failure.message, {
          status: result.failure._tag === "UnauthorizedApiError" ? 401 : 403
        })
      }
      return yield* HttpServerResponse.json({}, {
        headers: { "cache-control": "no-store", "set-cookie": ownerSessionCookie(secrets) },
        status: 200
      })
    })
  )
)
