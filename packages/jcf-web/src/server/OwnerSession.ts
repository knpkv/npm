/**
 * Who may talk to this server.
 *
 * **Mental model**
 *
 * - **One process, one operator.** The server binds a loopback address and mints a session token for
 *   itself at startup. There is no user table and no login: the person who can read the terminal is
 *   the person who gets in, which is exactly the authority a tool that writes to their own timesheet
 *   should have.
 * - **The URL is the handshake.** The bootstrap code is printed once, in a fragment the browser
 *   never sends upstream, and is spent the first time it is exchanged for the session cookie.
 * - **A read needs the cookie and must not be a browser cross-origin request; a write also needs the
 *   expected origin and CSRF header.** Another page in the same browser can make the browser send a
 *   cookie, but Fetch Metadata keeps that page from starting agent-backed reads without an Origin.
 *
 * The rules are those of `@knpkv/codecommit-web`'s owner session, over the same
 * `@knpkv/browser-pairing` credential primitives. They are re-stated here rather than imported
 * because that module is private to that application; the shared home for them is a later job than
 * this one, and duplicating the *policy* while sharing the *primitives* is the smaller of the two
 * mistakes available.
 *
 * @module
 */
import {
  credentialValuesEqual,
  decideOneTimeCredential,
  expiresAt,
  issueCsrfToken,
  issuePairingCode,
  issueSessionToken,
  serializeCredentialCookie
} from "@knpkv/browser-pairing"
import type { CsrfToken, PairingCode, SessionToken } from "@knpkv/browser-pairing/schema"
import { Clock, Context, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ForbiddenApiError, OwnerSessionAuth, UnauthorizedApiError } from "./Api.js"

/** How long the printed bootstrap URL stays usable. Long enough to click, short enough to forget. */
const BOOTSTRAP_LIFETIME_MILLIS = 60_000

/**
 * Failed bootstrap exchanges before the exchange closes for the life of the process.
 *
 * The code is high-entropy, so this is not what makes guessing hard — it is what stops a process
 * that is being guessed at from staying open all afternoon.
 */
const MAX_BOOTSTRAP_FAILURES = 5

/** Methods that only read. They need the session, but no origin and no CSRF token. */
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * The one origin other than the bound server that may hold a session: the Vite dev server, which
 * proxies both the API and the bootstrap exchange, so the browser stays on a single origin.
 */
const devPublicOrigin = "http://localhost:5173"

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
  readonly bootstrapAvailable: Ref.Ref<boolean>
  readonly bootstrapAttemptState: Ref.Ref<BootstrapAttemptState>
  readonly bootstrapExpiresAtMillis: Ref.Ref<number | undefined>
  readonly bootstrapToken: Redacted.Redacted<PairingCode>
  readonly csrfToken: Redacted.Redacted<CsrfToken>
  readonly ownerToken: Redacted.Redacted<SessionToken>
}

export class OwnerSessionSecrets extends Context.Service<
  OwnerSessionSecrets,
  OwnerSessionSecretsContract
>()("@knpkv/jcf-web/OwnerSessionSecrets") {}

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
      catch: () => new UnsafeServerOriginError({ message: "jcf-web needs a valid HTTP origin", origin }),
      try: () => new URL(origin)
    })
    if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname) || url.search !== "" || url.hash !== "") {
      return yield* new UnsafeServerOriginError({
        message: "jcf-web may only be reached over HTTP on a loopback host",
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
        message: "jcf-web's public origin must be the bound server or its dev proxy",
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
    const [ownerToken, csrfToken, bootstrapToken] = yield* Effect.all([
      issueSessionToken(),
      issueCsrfToken(),
      issuePairingCode()
    ])
    return OwnerSessionSecrets.of({
      authorityOrigin: validated,
      bootstrapAttemptState: yield* Ref.make<BootstrapAttemptState>({ failedAttempts: 0, inFlight: 0 }),
      bootstrapAvailable: yield* Ref.make(true),
      bootstrapExpiresAtMillis: yield* Ref.make<number | undefined>(undefined),
      bootstrapToken,
      browserOrigin,
      csrfToken,
      ownerToken
    })
  }
)

/** Start the bootstrap clock. Called once the server is actually listening, never before. */
export const activateOwnerSessionBootstrap = Effect.fn("OwnerSession.activateBootstrap")(
  function*(secrets: OwnerSessionSecretsContract) {
    const now = yield* Clock.currentTimeMillis
    yield* Ref.set(secrets.bootstrapExpiresAtMillis, yield* expiresAt(now, BOOTSTRAP_LIFETIME_MILLIS))
  }
)

/**
 * The URL to open. The code rides in the fragment, which browsers do not send to servers and
 * proxies do not log, and the page strips it from the address bar once it has been spent.
 */
export const ownerSessionUrl = (
  publicOrigin: string,
  secrets: Pick<OwnerSessionSecretsContract, "bootstrapToken">
): string =>
  `${publicOrigin.replace(/\/+$/u, "")}/#bootstrap_token=${encodeURIComponent(Redacted.value(secrets.bootstrapToken))}`

export const ownerSessionCookie = (secrets: Pick<OwnerSessionSecretsContract, "ownerToken">): string =>
  serializeCredentialCookie(secrets.ownerToken, {
    httpOnly: true,
    name: "jcf_owner",
    path: "/api",
    sameSite: "strict",
    secure: false
  })

interface OwnerRequest {
  readonly credential: string
  readonly csrfToken: string | undefined
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
      return yield* new ForbiddenApiError({ message: "Request origin does not match this jcf-web server" })
    }
    if (request.fetchSite !== undefined && !fetchSites.has(request.fetchSite)) {
      return yield* new ForbiddenApiError({ message: "Request carries invalid browser site metadata" })
    }
    if (
      request.fetchSite === "cross-site" ||
      (!sameOrigin && (request.fetchSite === "same-site" || request.fetchSite === "none"))
    ) {
      return yield* new ForbiddenApiError({ message: "Browser request is not from this jcf-web page" })
    }
    // An explicit client such as curl carries neither Origin nor Fetch Metadata and remains allowed:
    // it still has to present the process-scoped session cookie. Browser-marked cross-origin reads
    // are rejected before their handler can start provider or agent work.
    if (safeMethods.has(request.method.toUpperCase())) return
    if (!sameOrigin) {
      return yield* new ForbiddenApiError({ message: "Mutation origin does not match this jcf-web server" })
    }
    const csrfMatches = request.csrfToken !== undefined &&
      credentialValuesEqual(request.csrfToken, Redacted.value(secrets.csrfToken)) === true
    if (!csrfMatches) return yield* new ForbiddenApiError({ message: "Missing or invalid CSRF token" })
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
      return yield* new ForbiddenApiError({ message: "Bootstrap origin does not match this jcf-web server" })
    }
    const supplied = bearerToken(request.authorization)
    // Counted before the code is even compared, so a burst of parallel guesses cannot all pass the
    // check together and then be counted afterwards.
    const admit = Ref.modify(
      secrets.bootstrapAttemptState,
      (state): readonly [BootstrapAdmission, BootstrapAttemptState] => {
        if (state.failedAttempts + state.inFlight >= MAX_BOOTSTRAP_FAILURES) return ["unavailable", state]
        const matches = supplied !== undefined &&
          credentialValuesEqual(supplied, Redacted.value(secrets.bootstrapToken)) === true
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
          const expiry = yield* Ref.get(secrets.bootstrapExpiresAtMillis)
          if (expiry === undefined) return yield* new UnauthorizedApiError({ message: "Bootstrap is not active yet" })
          const now = yield* Clock.currentTimeMillis
          const decision = yield* Ref.modify(secrets.bootstrapAvailable, (available) => {
            const next = decideOneTimeCredential(
              { consumedAt: available ? null : 0, expiresAt: expiry, revokedAt: null },
              now
            )
            return [next, next === "accepted" ? false : available]
          })
          if (decision === "accepted") return
          const message = decision === "expired"
            ? "Bootstrap token has expired — restart jcf-web for a fresh URL"
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
              csrfToken: request.headers["x-csrf-token"],
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
      return yield* HttpServerResponse.json({ csrfToken: Redacted.value(secrets.csrfToken) }, {
        headers: { "cache-control": "no-store", "set-cookie": ownerSessionCookie(secrets) },
        status: 200
      })
    })
  )
)
