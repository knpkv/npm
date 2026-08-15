import { Clock, Context, Crypto, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ForbiddenApiError, OwnerSessionAuth, UnauthorizedApiError } from "../Api.js"

export interface OwnerSessionSecretsContract {
  readonly bootstrapAvailable: Ref.Ref<boolean>
  readonly bootstrapExpiresAtMillis: Ref.Ref<number | undefined>
  readonly bootstrapToken: Redacted.Redacted<string>
  readonly csrfToken: Redacted.Redacted<string>
  readonly ownerToken: Redacted.Redacted<string>
}

export class OwnerSessionSecrets extends Context.Service<
  OwnerSessionSecrets,
  OwnerSessionSecretsContract
>()("@knpkv/codecommit-web/OwnerSessionSecrets") {}

export class UnsafeServerHostnameError extends Schema.TaggedError<UnsafeServerHostnameError>()(
  "UnsafeServerHostnameError",
  { hostname: Schema.String, message: Schema.String }
) {}

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])

export const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]"

export const requireLoopbackHostname = Effect.fn("OwnerSessionSecurity.requireLoopbackHostname")(
  function*(hostname: string) {
    if (!isLoopbackHostname(hostname)) {
      return yield* new UnsafeServerHostnameError({
        hostname,
        message: "CodeCommit web may only listen on a loopback hostname"
      })
    }
    return hostname
  }
)

export const makeOwnerSessionSecrets = Effect.fn("OwnerSessionSecurity.makeSecrets")(function*() {
  const cryptoService = yield* Crypto.Crypto
  const [ownerToken, csrfToken, bootstrapToken] = yield* Effect.all([
    cryptoService.randomUUIDv4,
    cryptoService.randomUUIDv4,
    cryptoService.randomUUIDv4
  ])
  const bootstrapAvailable = yield* Ref.make(true)
  return OwnerSessionSecrets.of({
    ownerToken: Redacted.make(ownerToken),
    csrfToken: Redacted.make(csrfToken),
    bootstrapToken: Redacted.make(bootstrapToken),
    bootstrapAvailable,
    bootstrapExpiresAtMillis: yield* Ref.make<number | undefined>(undefined)
  })
})

export const activateOwnerSessionBootstrap = Effect.fn("OwnerSessionSecurity.activateBootstrap")(
  function*(secrets: OwnerSessionSecretsContract) {
    const now = yield* Clock.currentTimeMillis
    yield* Ref.set(secrets.bootstrapExpiresAtMillis, now + 60_000)
  }
)

export const ownerSessionOrigin = (hostname: string, port: number): string => {
  const urlHostname = hostname === "::1" ? "[::1]" : hostname
  return `http://${urlHostname}:${port}/`
}

export const ownerSessionUrl = (
  hostname: string,
  port: number,
  secrets: OwnerSessionSecretsContract
): string => ownerSessionUrlForOrigin(ownerSessionOrigin(hostname, port), secrets)

export const ownerSessionUrlForOrigin = (
  origin: string,
  secrets: Pick<OwnerSessionSecretsContract, "bootstrapToken">
): string => {
  const bootstrapToken = encodeURIComponent(Redacted.value(secrets.bootstrapToken))
  return `${origin.replace(/\/+$/u, "")}/#bootstrap_token=${bootstrapToken}`
}

export const requireLoopbackOrigin = Effect.fn("OwnerSessionSecurity.requireLoopbackOrigin")(
  function*(origin: string) {
    const url = yield* Effect.try({
      try: () => new URL(origin),
      catch: () =>
        new UnsafeServerHostnameError({
          hostname: origin,
          message: "CodeCommit public origin must be a valid loopback HTTP origin"
        })
    })
    if (
      url.protocol !== "http:" || !isLoopbackHostname(url.hostname) || url.pathname !== "/" || url.search || url.hash
    ) {
      return yield* new UnsafeServerHostnameError({
        hostname: origin,
        message: "CodeCommit public origin must be an HTTP loopback origin without a path, query, or fragment"
      })
    }
    return url.origin
  }
)

export const ownerSessionCookie = (
  secrets: Pick<OwnerSessionSecretsContract, "ownerToken">
): string => `cc_owner=${Redacted.value(secrets.ownerToken)}; HttpOnly; Path=/api; SameSite=Strict`

interface OwnerRequestAuthorization {
  readonly credential: string
  readonly csrfToken: string | undefined
  readonly host: string | undefined
  readonly method: string
  readonly origin: string | undefined
}

export const authorizeOwnerRequest = Effect.fn("OwnerSessionSecurity.authorizeRequest")(
  function*(request: OwnerRequestAuthorization, secrets: OwnerSessionSecretsContract) {
    if (request.credential !== Redacted.value(secrets.ownerToken)) {
      return yield* new UnauthorizedApiError({ message: "Missing or invalid owner session" })
    }
    const sameOrigin = request.host !== undefined && request.origin === `http://${request.host}`
    if (request.origin !== undefined && !sameOrigin) {
      return yield* new ForbiddenApiError({ message: "Request origin does not match the CodeCommit server" })
    }
    // Safe reads intentionally allow non-browser callers without Origin or CSRF
    // headers; every read still requires the process-scoped owner credential.
    if (safeMethods.has(request.method.toUpperCase())) return
    if (!sameOrigin) {
      return yield* new ForbiddenApiError({ message: "Mutation origin does not match the CodeCommit server" })
    }
    if (request.csrfToken !== Redacted.value(secrets.csrfToken)) {
      return yield* new ForbiddenApiError({ message: "Missing or invalid CSRF token" })
    }
  }
)

interface BootstrapAuthorization {
  readonly authorization: string | undefined
  readonly host: string | undefined
  readonly origin: string | undefined
}

export const authorizeBootstrapRequest = Effect.fn("OwnerSessionSecurity.authorizeBootstrap")(
  function*(request: BootstrapAuthorization, secrets: OwnerSessionSecretsContract) {
    if (request.authorization !== `Bearer ${Redacted.value(secrets.bootstrapToken)}`) {
      return yield* new UnauthorizedApiError({ message: "Missing or invalid bootstrap token" })
    }
    if (request.host === undefined || request.origin !== `http://${request.host}`) {
      return yield* new ForbiddenApiError({ message: "Bootstrap origin does not match the CodeCommit server" })
    }
    const expiresAt = yield* Ref.get(secrets.bootstrapExpiresAtMillis)
    if (expiresAt === undefined) {
      return yield* new UnauthorizedApiError({ message: "Bootstrap token is not active" })
    }
    const now = yield* Clock.currentTimeMillis
    if (now >= expiresAt) {
      return yield* new UnauthorizedApiError({ message: "Bootstrap token has expired" })
    }
    const available = yield* Ref.getAndSet(secrets.bootstrapAvailable, false)
    if (!available) {
      return yield* new UnauthorizedApiError({ message: "Bootstrap token has already been used" })
    }
  }
)

export const ownerSessionAuthLayer = Layer.effect(
  OwnerSessionAuth,
  Effect.gen(function*() {
    const secrets = yield* OwnerSessionSecrets
    return OwnerSessionAuth.of({
      ownerCookie: Effect.fn("OwnerSessionSecurity.ownerCookie")(
        function*(httpEffect, { credential }) {
          const request = yield* HttpServerRequest.HttpServerRequest
          yield* authorizeOwnerRequest(
            {
              credential: Redacted.value(credential),
              csrfToken: request.headers["x-csrf-token"],
              host: request.headers.host,
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

export const OwnerSessionBootstrapRouter = HttpRouter.use((router) =>
  router.add(
    "POST",
    "/auth/bootstrap",
    Effect.gen(function*() {
      const secrets = yield* OwnerSessionSecrets
      const request = yield* HttpServerRequest.HttpServerRequest
      const authorization = authorizeBootstrapRequest(
        {
          authorization: request.headers.authorization,
          host: request.headers.host,
          origin: request.headers.origin
        },
        secrets
      )
      const result = yield* Effect.result(authorization)
      if (result._tag === "Failure") {
        const error = result.failure
        return HttpServerResponse.text(error.message, {
          status: error._tag === "UnauthorizedApiError" ? 401 : 403
        })
      }
      return yield* HttpServerResponse.json({ csrfToken: Redacted.value(secrets.csrfToken) }, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "set-cookie": ownerSessionCookie(secrets)
        }
      })
    })
  )
)
