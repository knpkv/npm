/**
 * The owner-only control file lets the CLI request a fresh link from a running server.
 * The caller-selected file persists {origin, token}: the direct bound loopback origin and a
 * server-private bearer credential. The directory is 0700, the file 0600; linked or permissive
 * paths are refused. Neither the token nor this file belongs in HTTP projections or logs.
 * Login replies carry a one-time credential URL, emitted only on CLI stdout and to its opener.
 *
 * @module
 */
import { Clock, Data, Effect, FileSystem, Option, Path, Random, Redacted, Schedule, Schema } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/http"
import { credentialValuesEqual } from "./crypto.js"
import * as OwnerSession from "./owner-session.js"
import { PairingCode } from "./schema.js"

/** Credential-bearing on-disk representation; the token stays server-private and owner-only. */
export const ControlFile = Schema.Struct({
  origin: Schema.String,
  token: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
})
export interface ControlFile extends Schema.Schema.Type<typeof ControlFile> {}
const decodeControlFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ControlFile))
/** Origin-only projection; credential fields are deliberately not decoded. */
const decodeOriginProjection = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ origin: Schema.String }))
)
/** Credential-bearing response: the URL contains a one-time PairingCode. */
const LoginAnswer = Schema.Struct({ url: Schema.URLFromString })

/** Caller-specific sentences; none may contain a credential. */
export interface ControlMessages {
  readonly notRunning: string
  readonly loginRefused: (status: number) => string
  readonly controlFile: string
}

export class WebNotRunning extends Data.TaggedError("WebNotRunning")<{ readonly description?: string }> {
  override get message() {
    return this.description ?? "Web server is not running."
  }
}
export class WebLoginRefused extends Data.TaggedError("WebLoginRefused")<{
  readonly status: number
  readonly description?: string
}> {
  override get message() {
    return this.description ?? `Web server refused sign-in (HTTP ${this.status}).`
  }
}
export class ControlFileError extends Data.TaggedError("ControlFileError")<{ readonly description?: string }> {
  override get message() {
    return this.description ?? "Could not publish the owner-only web control file."
  }
}

/** Resolved owner-private paths. The caller retains its existing directory and file name. */
export interface WebControlPaths {
  readonly directory: string
  readonly file: string
  readonly messages?: ControlMessages
}

/**
 * Build control operations for resolved paths without reading the environment. Persisted payloads
 * carry a server-private bearer token. Bootstrap URLs returned by requestLoginUrl are credentials;
 * send them only to CLI stdout and its browser opener, never logs or telemetry.
 */
export const makeWebControl = ({
  directory,
  file,
  messages = {
    notRunning: "Web server is not running.",
    loginRefused: (status) => `Web server refused sign-in (HTTP ${status}).`,
    controlFile: "Could not publish the owner-only web control file."
  }
}: WebControlPaths) => {
  /** readLink also detects dangling links, which exists/stat would otherwise follow or miss. */
  const refuseLink = Effect.fn("WebControl.refuseControlLink")(function*(file: string) {
    const fs = yield* FileSystem.FileSystem
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) {
      return yield* new ControlFileError({ description: messages.controlFile })
    }
  })
  const requirePrivatePath = Effect.fn("WebControl.requirePrivateControlPath")(function*(
    file: string,
    kind: "File" | "Directory",
    mode: number
  ) {
    yield* refuseLink(file)
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(file)
    if (info.type !== kind || (info.mode & 0o777) !== mode) {
      return yield* new ControlFileError({ description: messages.controlFile })
    }
  })
  const readPrivateControlText = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* requirePrivatePath(directory, "Directory", 0o700)
    yield* requirePrivatePath(file, "File", 0o600)
    return yield* fs.readFileString(file)
  })

  /**
   * Read a canonical HTTP loopback origin without decoding the bearer token, contacting the
   * server, or changing files. The origin may cross an authenticated client boundary; credentials
   * and private paths never do. Missing or unsafe registrations fail without retaining their cause.
   */
  const readOrigin = Effect.gen(function*() {
    const projection = yield* readPrivateControlText.pipe(Effect.flatMap(decodeOriginProjection))
    const origin = yield* OwnerSession.requireLoopbackOrigin(projection.origin)
    if (origin !== projection.origin) {
      return yield* new WebNotRunning({ description: messages.notRunning })
    }
    return origin
  }).pipe(Effect.mapError(() => new WebNotRunning({ description: messages.notRunning })))

  const prepareDirectory = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* refuseLink(directory)
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    // Refuse permissive directories rather than chmodding an unpinned path.
    yield* requirePrivatePath(directory, "Directory", 0o700)
  })
  const staleLockMillis = 10_000

  /** Serialize atomic replacement and token-matching removal; recover a lock left by a dead writer. */
  const withControlLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const lock = path.join(directory, "web.lock")
      yield* prepareDirectory
      yield* refuseLink(lock)
      const take = fs.writeFileString(lock, "", { flag: "wx", mode: 0o600 }).pipe(
        Effect.catch((error) =>
          error._tag === "PlatformError" && error.reason._tag === "AlreadyExists"
            ? Effect.gen(function*() {
              yield* requirePrivatePath(lock, "File", 0o600)
              const info = yield* fs.stat(lock)
              const modified = Option.getOrElse(info.mtime, () => new Date(0)).getTime()
              if ((yield* Clock.currentTimeMillis) - modified > staleLockMillis) yield* fs.remove(lock)
              return yield* error
            })
            : Effect.fail(error)
        )
      )
      return yield* Effect.acquireUseRelease(
        take.pipe(Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 80 })),
        () => effect,
        () => fs.remove(lock).pipe(Effect.ignore({ log: "Warn", message: "Could not release the web control lock" }))
      )
    })

  /** Atomically record this listening server, replacing an older server's control file. */
  const writeControlFile = (control: ControlFile) =>
    withControlLock(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* refuseLink(file)
      if (yield* fs.exists(file)) yield* requirePrivatePath(file, "File", 0o600)
      const pending = `${file}.${yield* Random.nextIntBetween(0, 1_000_000_000)}.tmp`
      yield* Effect.acquireUseRelease(
        fs.writeFileString(pending, JSON.stringify(control), { flag: "wx", mode: 0o600 }),
        () => requirePrivatePath(pending, "File", 0o600).pipe(Effect.andThen(fs.rename(pending, file))),
        () =>
          fs.remove(pending, { force: true }).pipe(
            Effect.ignore({ log: "Warn", message: "Could not remove pending web control file" })
          )
      )
    })).pipe(Effect.mapError(() => new ControlFileError({ description: messages.controlFile })))

  /** Publish only from the listener-ready callback; immediately register token-matching scope cleanup. */
  const registerControlFile = (control: ControlFile) =>
    Effect.acquireRelease(writeControlFile(control), () => removeControlFile(control.token))

  /** An old server cannot erase a newer server's token, even while another writer is publishing. */
  const removeControlFile = (token: string) =>
    withControlLock(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* refuseLink(file)
      if (!(yield* fs.exists(file))) return
      yield* requirePrivatePath(file, "File", 0o600)
      const current = yield* fs.readFileString(file).pipe(Effect.flatMap(decodeControlFile))
      if (current.token === token) yield* fs.remove(file)
    })).pipe(Effect.ignore({ log: "Warn", message: "Could not remove the owner-only web control file" }))

  /** One owner-authenticated request; a refusal or malformed reply never permits a second server. */
  const requestLoginUrl = Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const control = yield* Effect.gen(function*() {
      const value = yield* readPrivateControlText.pipe(Effect.flatMap(decodeControlFile))
      const origin = yield* OwnerSession.requireLoopbackOrigin(value.origin)
      return { origin, token: value.token }
    }).pipe(Effect.mapError(() => new WebNotRunning({ description: messages.notRunning })))
    const response = yield* client.execute(
      HttpClientRequest.post(`${control.origin}/control/login`).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${control.token}`)
      )
    ).pipe(Effect.mapError(() => new WebNotRunning({ description: messages.notRunning })))
    if (response.status !== 200) {
      return yield* new WebLoginRefused({
        status: response.status,
        description: messages.loginRefused(response.status)
      })
    }
    const answer = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(LoginAnswer)),
      Effect.mapError(() =>
        new WebLoginRefused({ status: response.status, description: messages.loginRefused(response.status) })
      )
    )
    const url = answer.url
    if (
      (url.origin !== control.origin && url.origin !== OwnerSession.devPublicOrigin) || url.username !== "" ||
      url.password !== "" || url.pathname !== "/" || url.search !== "" || !url.hash.startsWith("#bootstrap_token=") ||
      !Schema.is(PairingCode)(url.hash.slice("#bootstrap_token=".length))
    ) {
      return yield* new WebLoginRefused({
        status: response.status,
        description: messages.loginRefused(response.status)
      })
    }
    return url.href
  })

  return { writeControlFile, registerControlFile, removeControlFile, requestLoginUrl, readOrigin }
}

/** Bearer-only, non-cacheable owner route. The reply contains a one-time credential URL. */
export const loginControlRouter = (token: Redacted.Redacted<string>, publicOrigin: string) =>
  loginControlRouterWithMint(
    token,
    publicOrigin,
    Effect.gen(function*() {
      const session = yield* OwnerSession.OwnerSession
      return yield* session.mintBootstrapCode.pipe(Effect.orDie)
    })
  )

/**
 * Use an application's own one-time issuer behind the same owner-only bearer route. The callback
 * runs only after bearer and Origin checks. Its redacted PairingCode becomes a credential-bearing
 * fragment URL; failures return a sanitized, non-cacheable 503 without logging the credential.
 * The caller retains its issuer's expiry, persistence, identity and revocation policy.
 */
export const loginControlRouterWithMint = <E, R>(
  token: Redacted.Redacted<string>,
  publicOrigin: string,
  mint: Effect.Effect<Redacted.Redacted<PairingCode>, E, R>
) =>
  HttpRouter.use((router) =>
    router.add(
      "POST",
      "/control/login",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const header = request.headers.authorization
        if (
          header === undefined || !header.startsWith("Bearer ") ||
          !credentialValuesEqual(header.slice(7), Redacted.value(token))
        ) {
          return HttpServerResponse.empty({ status: 401, headers: { "cache-control": "no-store" } })
        }
        if (request.headers.origin !== undefined && request.headers.origin !== publicOrigin) {
          return HttpServerResponse.empty({ status: 403, headers: { "cache-control": "no-store" } })
        }
        return yield* Effect.matchEffect(mint, {
          onFailure: () =>
            Effect.succeed(HttpServerResponse.empty({ status: 503, headers: { "cache-control": "no-store" } })),
          onSuccess: (code) =>
            HttpServerResponse.json(
              { url: OwnerSession.bootstrapUrl(publicOrigin, code) },
              { headers: { "cache-control": "no-store" } }
            )
        })
      })
    )
  )

/** Keep ordinary CORS/preflight handling while excluding the bearer-only owner control route. */
export const controlAwareCors = (options: Parameters<typeof HttpRouter.cors>[0]) => {
  const cors = HttpMiddleware.cors(options)
  return HttpRouter.middleware((httpEffect) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = HttpServerRequest.toURL(request)
      return yield* Option.isSome(url) && url.value.pathname === "/control/login" ? httpEffect : cors(httpEffect)
    }), { global: true })
}
