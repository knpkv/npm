/**
 * Who may talk to a single-operator loopback web app.
 *
 * **Mental model**
 *
 * - **One process, one operator.** The server binds a loopback address and mints a session token for
 *   itself at startup. There is no user table and no login: the person who can read the terminal is
 *   the person who gets in.
 * - **The URL is the handshake.** A bootstrap code rides in a fragment the browser never sends
 *   upstream and is spent the first time it is exchanged for the session cookie. Codes come from
 *   {@link OwnerSessionService.mintBootstrapCode}, only once the server is listening; a newer code
 *   replaces an unspent one and reopens an exchange that guesses had closed.
 * - **A read needs the cookie and must not be a browser cross-origin request; a write also needs the
 *   expected origin and the CSRF header.** Another page in the same browser can make the browser send
 *   a cookie, but Fetch Metadata keeps that page from starting reads without an Origin. An app with
 *   `writes: "none"` issues no CSRF token and refuses every unsafe method.
 *
 * Applications keep their HTTP API middleware and wire errors; they map
 * {@link OwnerSessionUnauthorizedError} to 401 and {@link OwnerSessionForbiddenError} to 403.
 * Multi-session, persisted authorization (Control Center) is out of scope.
 *
 * @module
 */
import { Clock, Context, Crypto, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { credentialValuesEqual, expiresAt, issueCsrfToken, issuePairingCode, issueSessionToken } from "./crypto.js"
import type { BrowserPairingError } from "./crypto.js"
import type { CsrfToken, OneTimeCredentialDecision, PairingCode, SessionToken } from "./schema.js"
import { CredentialCookieError, decideOneTimeCredential, serializeCredentialCookie } from "./schema.js"

/** How long a minted bootstrap URL stays usable. Long enough to click, short enough to forget. */
const BOOTSTRAP_LIFETIME_MILLIS = 60_000

/**
 * Failed bootstrap exchanges before the exchange closes, until a new code is minted.
 *
 * The code is high-entropy, so this is not what makes guessing hard — it is what stops a process
 * that is being guessed at from staying open all afternoon.
 */
const MAX_BOOTSTRAP_FAILURES = 5

/** Methods that only read. They need the session, but no origin and no CSRF token. */
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])

const fetchSites = new Set(["cross-site", "none", "same-origin", "same-site"])

/**
 * The one origin other than the bound server that may be advertised: the Vite dev server that
 * proxies the API and the bootstrap exchange.
 */
export const devPublicOrigin = "http://localhost:5173"

/** The session cookie or bootstrap code is missing, wrong, spent, or expired. Maps to 401. */
export class OwnerSessionUnauthorizedError extends Schema.TaggedError<OwnerSessionUnauthorizedError>()(
  "OwnerSessionUnauthorizedError",
  { message: Schema.String }
) {}

/** The credential is right but the request did not come from the owner's page. Maps to 403. */
export class OwnerSessionForbiddenError extends Schema.TaggedError<OwnerSessionForbiddenError>()(
  "OwnerSessionForbiddenError",
  { message: Schema.String }
) {}

/** A hostname or origin is not a plain HTTP loopback address. */
export class UnsafeLoopbackAddressError extends Schema.TaggedError<UnsafeLoopbackAddressError>()(
  "UnsafeLoopbackAddressError",
  { address: Schema.String, message: Schema.String }
) {}

/** Hostnames a loopback web app may bind. */
export const LoopbackHostname = Schema.Literals(["127.0.0.1", "localhost", "::1"])
export type LoopbackHostname = typeof LoopbackHostname.Type

/** Whether a URL hostname (which brackets IPv6) names the loopback interface. */
export const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]"

/** Refuse to bind anything a peer on the network could reach. */
export const requireLoopbackHostname = (hostname: string) =>
  Schema.decodeUnknownEffect(LoopbackHostname)(hostname).pipe(
    Effect.mapError(() =>
      new UnsafeLoopbackAddressError({ address: hostname, message: "Server may only listen on a loopback hostname" })
    )
  )

/** The HTTP origin for a bound loopback server, without a trailing slash. */
export const loopbackOrigin = (hostname: string, port: number): string =>
  `http://${hostname === "::1" ? "[::1]" : hostname}:${port}`

/** Validate an origin as plain HTTP on loopback with no path, query, or fragment. */
export const requireLoopbackOrigin = Effect.fn("OwnerSession.requireLoopbackOrigin")(
  function*(origin: string) {
    const url = yield* Effect.try({
      try: () => new URL(origin),
      catch: () => new UnsafeLoopbackAddressError({ address: origin, message: "Not a valid HTTP origin" })
    })
    if (
      url.protocol !== "http:" ||
      !isLoopbackHostname(url.hostname) ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return yield* new UnsafeLoopbackAddressError({
        address: origin,
        message: "Origin must be HTTP on a loopback host, without a path, query, or fragment"
      })
    }
    return url.origin
  }
)

/** The origin to advertise: the bound server, or the dev server that proxies to it. */
export const resolvePublicOrigin = Effect.fn("OwnerSession.resolvePublicOrigin")(
  function*(configuredOrigin: string | undefined, authorityOrigin: string) {
    const authority = yield* requireLoopbackOrigin(authorityOrigin)
    if (configuredOrigin === undefined) return authority
    const configured = yield* requireLoopbackOrigin(configuredOrigin)
    if (configured !== authority && configured !== devPublicOrigin) {
      return yield* new UnsafeLoopbackAddressError({
        address: configuredOrigin,
        message: "Public origin must be the bound server or its dev proxy"
      })
    }
    return configured
  }
)

/**
 * The URL to open. The code rides in the fragment, which browsers do not send to servers and
 * proxies do not log; the page strips it from the address bar once it has been spent.
 */
export const bootstrapUrl = (origin: string, code: Redacted.Redacted<PairingCode>): string =>
  `${origin.replace(/\/+$/u, "")}/#bootstrap_token=${encodeURIComponent(Redacted.value(code))}`

export interface OwnerSessionOptions {
  /** Product name used in refusal messages, such as `"jcf-web"`. */
  readonly product: string
  readonly cookieName: string
  /** `"csrf"` issues a CSRF token and admits same-origin writes; `"none"` refuses every unsafe method. */
  readonly writes: "csrf" | "none"
  /** Appended to the expiry refusal, such as `"restart jcf-web for a fresh URL"`. */
  readonly freshUrlHint: string
  /** The origin this server considers itself to be. A request's Host header is never authoritative. */
  readonly authorityOrigin: string
  /** The origin a browser request must carry: the authority, or a dev proxy that preserves Origin. */
  readonly browserOrigin: string
}

/** What a request presents. {@link OwnerSessionService.authorizeHttp} reads it from the HTTP request. */
export interface OwnerRequest {
  readonly credential: string
  readonly csrfToken: string | undefined
  readonly fetchSite: string | undefined
  readonly method: string
  readonly origin: string | undefined
}

export interface BootstrapRequest {
  readonly authorization: string | undefined
  readonly origin: string | undefined
}

/** Whether writes are possible, and the token they need when they are. Credential-bearing: holds the `CsrfToken`. */
export type WritePolicy =
  | { readonly _tag: "Csrf"; readonly token: Redacted.Redacted<CsrfToken> }
  | { readonly _tag: "ReadOnly" }

/**
 * One process's Owner Session. Credential-bearing: it holds the `CsrfToken`, serializes the
 * `SessionToken` into {@link OwnerSessionService.sessionCookie}, and mints `PairingCode`s; the
 * session token and bootstrap state themselves stay private.
 */
export interface OwnerSessionService {
  readonly authorityOrigin: string
  readonly browserOrigin: string
  readonly cookieName: string
  readonly writes: WritePolicy
  /** The `Set-Cookie` value carrying the session token. */
  readonly sessionCookie: string
  /** Mint a one-time code, usable for a minute. Call only once the server is listening. */
  readonly mintBootstrapCode: Effect.Effect<Redacted.Redacted<PairingCode>, BrowserPairingError>
  readonly authorizeRequest: (
    request: OwnerRequest
  ) => Effect.Effect<void, OwnerSessionUnauthorizedError | OwnerSessionForbiddenError>
  /**
   * {@link OwnerSessionService.authorizeRequest} for the current HTTP request, given the session
   * cookie's value. API middleware maps the two errors onto the app's 401 and 403.
   */
  readonly authorizeHttp: (
    credential: string
  ) => Effect.Effect<
    void,
    OwnerSessionUnauthorizedError | OwnerSessionForbiddenError,
    HttpServerRequest.HttpServerRequest
  >
  /** Spend a bootstrap code. Succeeds at most once per minted code. */
  readonly authorizeBootstrap: (
    request: BootstrapRequest
  ) => Effect.Effect<void, OwnerSessionUnauthorizedError | OwnerSessionForbiddenError>
}

export class OwnerSession extends Context.Service<OwnerSession, OwnerSessionService>()(
  "@knpkv/browser-pairing/OwnerSession"
) {}

/** Credential-bearing: the current `PairingCode` and its one-time state. */
interface BootstrapCode {
  readonly token: Redacted.Redacted<PairingCode>
  readonly expiresAt: number
  readonly available: boolean
}

interface AttemptState {
  readonly failedAttempts: number
  readonly inFlight: number
}

type Admission = "unavailable" | "invalid" | "accepted"

const isCredentialCookieError = Schema.is(CredentialCookieError)

const bearerToken = (authorization: string | undefined): string | undefined =>
  authorization !== undefined && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined

const requestFromHttp = (request: HttpServerRequest.HttpServerRequest, credential: string): OwnerRequest => ({
  credential,
  csrfToken: request.headers["x-csrf-token"],
  fetchSite: request.headers["sec-fetch-site"],
  method: request.method,
  origin: request.headers.origin
})

const makeService = (
  options: OwnerSessionOptions,
  ownerToken: Redacted.Redacted<SessionToken>,
  sessionCookie: string,
  writes: WritePolicy,
  cryptoService: Crypto.Crypto,
  bootstrap: Ref.Ref<BootstrapCode | undefined>,
  attempts: Ref.Ref<AttemptState>
): OwnerSessionService => {
  const { browserOrigin, product } = options
  const unauthorized = (message: string) => new OwnerSessionUnauthorizedError({ message })
  const forbidden = (message: string) => new OwnerSessionForbiddenError({ message })

  const authorizeRequest = Effect.fn("OwnerSession.authorizeRequest")(function*(request: OwnerRequest) {
    if (credentialValuesEqual(request.credential, Redacted.value(ownerToken)) !== true) {
      return yield* unauthorized("Missing or invalid owner session")
    }
    const sameOrigin = request.origin !== undefined && request.origin === browserOrigin
    if (request.origin !== undefined && !sameOrigin) {
      return yield* forbidden(`Request origin does not match this ${product} server`)
    }
    if (request.fetchSite !== undefined && !fetchSites.has(request.fetchSite)) {
      return yield* forbidden("Request carries invalid browser site metadata")
    }
    if (
      request.fetchSite === "cross-site" ||
      (!sameOrigin && (request.fetchSite === "same-site" || request.fetchSite === "none"))
    ) {
      return yield* forbidden(`Browser request is not from this ${product} page`)
    }
    // An explicit client such as curl carries neither Origin nor Fetch Metadata and remains allowed:
    // it still has to present the process-scoped session cookie. Browser-marked cross-origin reads
    // are rejected before their handler can start work.
    if (safeMethods.has(request.method.toUpperCase())) return
    if (writes._tag === "ReadOnly") return yield* forbidden("This server only answers reads")
    if (!sameOrigin) return yield* forbidden(`Mutation origin does not match this ${product} server`)
    const csrfMatches = request.csrfToken !== undefined &&
      credentialValuesEqual(request.csrfToken, Redacted.value(writes.token)) === true
    if (!csrfMatches) return yield* forbidden("Missing or invalid CSRF token")
  })

  const authorizeBootstrap = Effect.fn("OwnerSession.authorizeBootstrap")(function*(request: BootstrapRequest) {
    if (request.origin !== browserOrigin) {
      return yield* forbidden(`Bootstrap origin does not match this ${product} server`)
    }
    const supplied = bearerToken(request.authorization)
    const current = yield* Ref.get(bootstrap)
    // Counted before the code is even compared, so a burst of parallel guesses cannot all pass the
    // check together and then be counted afterwards.
    const admit = Ref.modify(attempts, (state): readonly [Admission, AttemptState] => {
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
    }).pipe(
      Effect.flatMap((admission) =>
        admission === "unavailable"
          ? Effect.fail(unauthorized("Bootstrap is closed until a new code is minted"))
          : admission === "invalid"
          ? Effect.fail(unauthorized("Missing or invalid bootstrap token"))
          : Effect.void
      )
    )
    return yield* Effect.acquireUseRelease(
      admit,
      () =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          // Spent only if it is still the code that was compared: a newer mint replaced it otherwise.
          const decision = yield* Ref.modify(
            bootstrap,
            (code): readonly [OneTimeCredentialDecision, BootstrapCode | undefined] => {
              if (code === undefined || current === undefined || code.token !== current.token) {
                return ["consumed", code]
              }
              const next = decideOneTimeCredential(
                { consumedAt: code.available ? null : 0, expiresAt: code.expiresAt, revokedAt: null },
                now
              )
              return [next, next === "accepted" ? { ...code, available: false } : code]
            }
          )
          if (decision === "accepted") return
          return yield* unauthorized(
            decision === "expired"
              ? `Bootstrap token has expired — ${options.freshUrlHint}`
              : decision === "consumed"
              ? "Bootstrap token has already been used"
              : "Bootstrap token state is invalid"
          )
        }),
      () => Ref.update(attempts, (state) => ({ ...state, inFlight: Math.max(0, state.inFlight - 1) }))
    )
  })

  const mintBootstrapCode = Effect.gen(function*() {
    const token = yield* issuePairingCode()
    const now = yield* Clock.currentTimeMillis
    const until = yield* expiresAt(now, BOOTSTRAP_LIFETIME_MILLIS)
    yield* Ref.set(bootstrap, { token, expiresAt: until, available: true })
    yield* Ref.set(attempts, { failedAttempts: 0, inFlight: 0 })
    return token
  }).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Effect.withSpan("OwnerSession.mintBootstrapCode"))

  return {
    authorityOrigin: options.authorityOrigin,
    authorizeBootstrap,
    authorizeHttp: (credential) =>
      Effect.flatMap(
        HttpServerRequest.HttpServerRequest,
        (request) => authorizeRequest(requestFromHttp(request, credential))
      ),
    authorizeRequest,
    browserOrigin,
    cookieName: options.cookieName,
    mintBootstrapCode,
    sessionCookie,
    writes
  }
}

/**
 * Build an owner session with fresh tokens. No bootstrap code exists until
 * {@link OwnerSessionService.mintBootstrapCode} runs.
 */
export const make = Effect.fn("OwnerSession.make")(function*(options: OwnerSessionOptions) {
  const authorityOrigin = yield* requireLoopbackOrigin(options.authorityOrigin)
  const browserOrigin = yield* requireLoopbackOrigin(options.browserOrigin)
  const cryptoService = yield* Crypto.Crypto
  const ownerToken = yield* issueSessionToken()
  const writes: WritePolicy = options.writes === "csrf"
    ? { _tag: "Csrf", token: yield* issueCsrfToken() }
    : { _tag: "ReadOnly" }
  // A cookie name is caller configuration: an invalid one fails typed. Anything else the serializer
  // throws is a bug and stays a defect.
  const sessionCookie = yield* Effect.sync(() =>
    serializeCredentialCookie(ownerToken, {
      httpOnly: true,
      name: options.cookieName,
      path: "/api",
      sameSite: "strict",
      secure: false
    })
  ).pipe(Effect.catchDefect((defect) => isCredentialCookieError(defect) ? Effect.fail(defect) : Effect.die(defect)))
  return OwnerSession.of(makeService(
    { ...options, authorityOrigin, browserOrigin },
    ownerToken,
    sessionCookie,
    writes,
    cryptoService,
    yield* Ref.make<BootstrapCode | undefined>(undefined),
    yield* Ref.make<AttemptState>({ failedAttempts: 0, inFlight: 0 })
  ))
})

export const layer = (options: OwnerSessionOptions) => Layer.effect(OwnerSession, make(options))

/**
 * The one route outside the authenticated API: `POST /auth/bootstrap` spends a code for the session
 * cookie, answering `{ csrfToken }` when writes are allowed and `{}` otherwise.
 */
export const BootstrapRouter = HttpRouter.use((router) =>
  Effect.gen(function*() {
    const session = yield* OwnerSession
    yield* router.add(
      "POST",
      "/auth/bootstrap",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const result = yield* Effect.result(
          session.authorizeBootstrap({ authorization: request.headers.authorization, origin: request.headers.origin })
        )
        if (result._tag === "Failure") {
          return HttpServerResponse.text(result.failure.message, {
            status: result.failure._tag === "OwnerSessionUnauthorizedError" ? 401 : 403
          })
        }
        const body = session.writes._tag === "Csrf" ? { csrfToken: Redacted.value(session.writes.token) } : {}
        return yield* HttpServerResponse.json(body, {
          headers: { "cache-control": "no-store", "set-cookie": session.sessionCookie },
          status: 200
        })
      })
    )
  })
)
