/**
 * AWS sign-in held by the hub, not by a CLI login on the host. The hub signs in to IAM Identity Center
 * itself with the OAuth device code grant, keeps the tokens in its own private database (never in
 * `~/.aws`), refreshes them, and turns them into role credentials for AWS calls.
 *
 * - **Sign in:** `begin` registers a public client once, asks for a device code and writes its verification
 *   URL, which includes the user code, to `pendingFile` (owner-only). It then calls `onPending` with the
 *   file's path only, never the code, and polls Identity Center until the code is approved or expires. The
 *   file is deleted when the sign-in ends either way. One sign-in runs at a time.
 * - **Tokens:** the access token is refreshed when under five minutes remain. A refused refresh (the
 *   Identity Center session ended) clears the token: the state is `SignInRequired` until the next sign-in.
 *   A transport failure keeps the token and fails as `AwsSignInUnavailable`.
 * - **Credentials:** `awsRoleCredentials` builds a `Credentials` service for one account and permission set.
 *   Without a sign-in it fails as an expired SSO token, so every AWS adapter keeps its typed error
 *   channel. It never starts a sign-in: only a person does, through `begin`.
 *
 * @module
 */
import {
  AwsCredentialProviderError,
  type Credentials,
  ExpiredSSOToken,
  type ResolvedCredentials
} from "@distilled.cloud/aws/Credentials"
import { openPrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Clock, Deferred, Duration, Effect, Option, Redacted, Ref, Schema, Semaphore } from "effect"
import * as FileSystem from "effect/FileSystem"
import { Headers, HttpClient, HttpClientRequest } from "effect/http"

/** No AWS sign-in is held. `pending` while a device code waits for approval. */
export class AwsSignInRequired extends Schema.TaggedError<AwsSignInRequired>()("AwsSignInRequired", {
  pending: Schema.Boolean
}) {}

/** Identity Center or the hub's own sign-in store could not be reached. Any held sign-in is kept. */
export class AwsSignInUnavailable extends Schema.TaggedError<AwsSignInUnavailable>()("AwsSignInUnavailable", {
  operation: Schema.String,
  detail: Schema.String
}) {}

/**
 * Whether AWS calls can be made. `SignedIn.expiresAt` is the access token's end; `SignInPending` is a started
 * sign-in waiting for a person to approve `userCode` at `verificationUri` before `expiresAt`. Epoch
 * milliseconds. The pending fields are for the owner only: they let anyone holding them finish the sign-in.
 */
export type AwsSignInState =
  | { readonly _tag: "SignedIn"; readonly expiresAt: number }
  | {
    readonly _tag: "SignInPending"
    readonly verificationUri: string
    readonly userCode: string
    readonly expiresAt: number
  }
  | { readonly _tag: "SignInRequired" }

export interface AwsSignInOptions {
  /** The AWS access portal's start URL. */
  readonly startUrl: string
  /** The Identity Center region. */
  readonly region: string
  /** The hub's private sign-in database. Created owner-only. */
  readonly databasePath: string
  /** Where a pending sign-in's verification URL is written, owner-only, until the sign-in ends. */
  readonly pendingFile: string
  /** Told the pending file's path when a sign-in starts, so someone can open the URL. */
  readonly onPending: (pendingFile: string) => Effect.Effect<void>
  /** The client name Identity Center shows. Defaults to `herdr-hub`. */
  readonly clientName?: string
  /**
   * A second process reading the hub's sign-in (a CLI beside hostd): no refresh, no registration, no sign-in. A
   * token under the refresh margin reads as a sign-in required, so its owner refreshes it. A token the portal
   * refuses (401) is still cleared, as AWS has already ended it.
   */
  readonly readOnly?: boolean
}

/** A started sign-in. `ended` waits until it is approved, denied or expires. */
export interface PendingSignIn {
  readonly ended: Effect.Effect<void>
}

export interface AwsSignIn {
  readonly state: Effect.Effect<AwsSignInState, AwsSignInUnavailable>
  /** A current access token, refreshed when near its end. */
  readonly accessToken: Effect.Effect<Redacted.Redacted<string>, AwsSignInRequired | AwsSignInUnavailable>
  /** Start a device code sign-in, or join the pending one. */
  readonly begin: Effect.Effect<PendingSignIn, AwsSignInUnavailable>
  /** Drop `accessToken` if it is still the held one: AWS no longer accepts it. */
  readonly revoked: (accessToken: Redacted.Redacted<string>) => Effect.Effect<void, AwsSignInUnavailable>
  /** The Identity Center region, for the portal. */
  readonly region: string
}

const Client = Schema.Struct({ clientId: Schema.String, clientSecret: Schema.String, expiresAt: Schema.Number })
const Token = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  expiresAt: Schema.Number
})
const Stored = Schema.Struct({ client: Schema.NullOr(Client), token: Schema.NullOr(Token) })
type Stored = typeof Stored.Type
const StoredJson = Schema.fromJsonString(Stored)

const Registration = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.String,
  clientSecretExpiresAt: Schema.Number
})
const DeviceAuthorization = Schema.Struct({
  deviceCode: Schema.String,
  userCode: Schema.String,
  verificationUri: Schema.String,
  verificationUriComplete: Schema.optionalKey(Schema.String),
  expiresIn: Schema.Number,
  interval: Schema.optionalKey(Schema.Number)
})
const Granted = Schema.Struct({
  accessToken: Schema.String,
  expiresIn: Schema.Number,
  refreshToken: Schema.optionalKey(Schema.String)
})
const Refusal = Schema.Struct({ error: Schema.String })
const PortalCredentials = Schema.Struct({
  roleCredentials: Schema.Struct({
    accessKeyId: Schema.String,
    secretAccessKey: Schema.String,
    sessionToken: Schema.String,
    expiration: Schema.Number
  })
})

/**
 * Identity Center answered with an error below 500: an OAuth code such as `authorization_pending` or
 * `invalid_grant`, or the portal's error type, such as `UnauthorizedException`.
 */
class Refused extends Schema.TaggedError<Refused>()("Refused", {
  operation: Schema.String,
  code: Schema.String,
  status: Schema.Number
}) {}

/** OAuth codes on a refresh that mean the Identity Center session itself ended. */
const sessionEnded = new Set(["invalid_grant", "expired_token", "access_denied"])

const refreshMargin = Duration.toMillis(Duration.minutes(5))
const clientMargin = Duration.toMillis(Duration.days(1))
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code"
const bearerHeader = "x-amz-sso_bearer_token"

/**
 * Send `request` and decode the answer. A status below 500 is `Refused` with its OAuth `error` code or, for the
 * restJson1 portal, its `x-amzn-ErrorType` header; anything else is `AwsSignInUnavailable`.
 */
const exchange = Effect.fn("AwsSignIn.exchange")(function*<A>(
  http: HttpClient.HttpClient,
  operation: string,
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Codec<A, unknown>
) {
  const unavailable = (detail: string) => new AwsSignInUnavailable({ operation, detail })
  const response = yield* http.execute(request).pipe(Effect.mapError(() => unavailable("unreachable")))
  const body = yield* response.json.pipe(Effect.mapError(() => unavailable(`HTTP ${response.status}`)))
  if (response.status >= 200 && response.status < 300) {
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(() => unavailable("unexpected answer"))
    )
  }
  const refusal = Schema.decodeUnknownOption(Refusal)(body)
  const errorType = response.headers["x-amzn-errortype"]?.split(":")[0]
  const code = Option.isSome(refusal) ? refusal.value.error : errorType
  return yield* code !== undefined && code !== "" && response.status < 500
    ? Effect.fail(new Refused({ operation, code, status: response.status }))
    : Effect.fail(unavailable(`HTTP ${response.status}`))
})

const post = (url: string, body: Record<string, string>) =>
  HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))

/**
 * Opens the hub's AWS sign-in. The returned sign-in's pending device code poll runs in the caller's scope.
 */
export const makeAwsSignIn = Effect.fn("AwsSignIn.make")(function*(options: AwsSignInOptions) {
  const http = yield* HttpClient.HttpClient
  const fs = yield* FileSystem.FileSystem
  const scope = yield* Effect.scope
  const oidc = `https://oidc.${options.region}.amazonaws.com`
  const opened = yield* Effect.acquireRelease(
    openPrivateSqlite(options.databasePath, {
      busyTimeoutMillis: 2_000,
      initialize: (database) =>
        database.exec("CREATE TABLE IF NOT EXISTS aws_sign_in (session TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
    }).pipe(Effect.mapError((cause) => new AwsSignInUnavailable({ operation: "open", detail: String(cause) }))),
    (resource) => Effect.sync(() => resource.database.close())
  )
  const session = `${options.region} ${options.startUrl}`
  // SQLite and file errors name paths; a decode error would quote the stored tokens, so it gets a fixed detail.
  const storeFailure = (operation: string) => (cause: unknown) =>
    new AwsSignInUnavailable({ operation, detail: String(cause) })
  const fixedFailure = (operation: string, detail: string) => () => new AwsSignInUnavailable({ operation, detail })
  const read = Effect.try({
    try: () => opened.database.prepare("SELECT value FROM aws_sign_in WHERE session = ?").get(session),
    catch: storeFailure("read")
  }).pipe(
    Effect.flatMap((row) =>
      row === undefined
        ? Effect.succeed<Stored>({ client: null, token: null })
        : Schema.decodeUnknownEffect(Schema.Struct({ value: StoredJson }))(row).pipe(
          Effect.map(({ value }) => value),
          Effect.mapError(fixedFailure("read", "unreadable"))
        )
    )
  )
  const write = (next: Stored) =>
    Schema.encodeEffect(StoredJson)(next).pipe(
      Effect.mapError(fixedFailure("write", "unwritable")),
      Effect.flatMap((value) =>
        Effect.try({
          try: () =>
            opened.database.prepare(
              "INSERT INTO aws_sign_in (session, value) VALUES (?, ?) ON CONFLICT(session) DO UPDATE SET value = excluded.value"
            ).run(session, value),
          catch: storeFailure("write")
        })
      ),
      Effect.andThen(opened.secureFiles.pipe(Effect.mapError(storeFailure("write")))),
      Effect.asVoid
    )
  // The pending sign-in: its end, and what a person approves once Identity Center has answered. Null when none.
  type Verification = Omit<Extract<AwsSignInState, { readonly _tag: "SignInPending" }>, "_tag">
  const current = yield* Ref.make<
    { readonly done: Deferred.Deferred<void>; readonly verification: Verification | null } | null
  >(null)
  const pending = Effect.map(Ref.get(current), (held) => held !== null)
  const finish = Ref.getAndSet(current, null).pipe(
    Effect.flatMap((held) => held === null ? Effect.void : Deferred.succeed(held.done, undefined)),
    Effect.asVoid
  )
  const refreshing = yield* Semaphore.make(1)

  const client = Effect.gen(function*() {
    const stored = yield* read
    const now = yield* Clock.currentTimeMillis
    if (stored.client !== null && stored.client.expiresAt - now > clientMargin) return stored.client
    const registered = yield* exchange(
      http,
      "register",
      HttpClientRequest.post(`${oidc}/client/register`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          clientName: options.clientName ?? "herdr-hub",
          clientType: "public",
          grantTypes: [deviceGrant, "refresh_token"],
          scopes: ["sso:account:access"]
        })
      ),
      Registration
    ).pipe(
      Effect.catchTag(
        "Refused",
        (refused) => Effect.fail(new AwsSignInUnavailable({ operation: refused.operation, detail: refused.code }))
      )
    )
    const next = {
      clientId: registered.clientId,
      clientSecret: registered.clientSecret,
      expiresAt: registered.clientSecretExpiresAt * 1_000
    }
    yield* write({ ...stored, client: next })
    return next
  })

  const grant = (now: number, granted: typeof Granted.Type, previousRefresh: string | null) => ({
    accessToken: granted.accessToken,
    refreshToken: granted.refreshToken ?? previousRefresh,
    expiresAt: now + granted.expiresIn * 1_000
  })

  const removePending = fs.remove(options.pendingFile, { force: true }).pipe(Effect.ignore({ log: true }))
  // A file left by a hub that was killed names a code nobody polls.
  yield* removePending

  /** Poll the device code until it is approved, denied or expired, waiting `interval` seconds between tries. */
  const poll = Effect.fn("AwsSignIn.poll")(function*(
    registered: typeof Client.Type,
    deviceCode: string,
    firstInterval: number,
    deadline: number
  ) {
    let interval = firstInterval
    while (true) {
      yield* Effect.sleep(Duration.seconds(interval))
      if ((yield* Clock.currentTimeMillis) >= deadline) return
      const answer = yield* exchange(
        http,
        "device token",
        post(`${oidc}/token`, {
          clientId: registered.clientId,
          clientSecret: registered.clientSecret,
          grantType: deviceGrant,
          deviceCode
        }),
        Granted
      ).pipe(Effect.result)
      if (answer._tag === "Success") {
        const stored = yield* read
        yield* removePending
        yield* write({ ...stored, token: grant(yield* Clock.currentTimeMillis, answer.success, null) })
        return
      }
      const failure = answer.failure
      if (failure._tag === "Refused" && failure.code === "slow_down") interval += 5
      // Any other refusal (expired, denied) ends this sign-in; pending and a transport failure try again.
      else if (failure._tag === "Refused" && failure.code !== "authorization_pending") return
    }
  })

  // Uninterruptible but for the start itself, so a claimed sign-in always ends in a poll or a cleanup.
  const startable = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function*() {
      const done = yield* Deferred.make<void>()
      const held = yield* Ref.modify(
        current,
        (existing) => existing === null ? [null, { done, verification: null }] : [existing, existing]
      )
      if (held !== null) return { ended: Deferred.await(held.done) } satisfies PendingSignIn
      const run = Effect.gen(function*() {
        const registered = yield* client
        const device = yield* exchange(
          http,
          "device authorization",
          post(`${oidc}/device_authorization`, {
            clientId: registered.clientId,
            clientSecret: registered.clientSecret,
            startUrl: options.startUrl
          }),
          DeviceAuthorization
        ).pipe(
          Effect.catchTag(
            "Refused",
            (refused) => Effect.fail(new AwsSignInUnavailable({ operation: refused.operation, detail: refused.code }))
          )
        )
        const deadline = (yield* Clock.currentTimeMillis) + device.expiresIn * 1_000
        const verificationUri = device.verificationUriComplete ?? device.verificationUri
        // Created fresh and exclusively, so the mode applies and nothing planted at the path is written through.
        yield* fs.remove(options.pendingFile, { force: true }).pipe(
          Effect.andThen(fs.writeFileString(
            options.pendingFile,
            JSON.stringify({ verificationUri, expiresAt: deadline }),
            { mode: 0o600, flag: "wx" }
          )),
          Effect.mapError(storeFailure("pending file"))
        )
        yield* Ref.update(
          current,
          (held) =>
            held?.done === done
              ? { done, verification: { verificationUri, userCode: device.userCode, expiresAt: deadline } }
              : held
        )
        yield* options.onPending(options.pendingFile)
        return { registered, device, deadline }
      })
      // Whatever ends the start (a failed write, a broken hook, interruption) leaves no file and no pending sign-in.
      const result = yield* restore(run).pipe(Effect.onError(() => removePending.pipe(Effect.andThen(finish))))
      yield* poll(result.registered, result.device.deviceCode, result.device.interval ?? 5, result.deadline).pipe(
        Effect.ensuring(removePending.pipe(Effect.andThen(finish))),
        Effect.ignore({ log: true }),
        Effect.forkIn(scope)
      )
      return { ended: Deferred.await(done) } satisfies PendingSignIn
    })
  )
  const begin = (options.readOnly === true
    ? Effect.fail(new AwsSignInUnavailable({ operation: "begin", detail: "read-only sign-in" }))
    : startable).pipe(Effect.withSpan("AwsSignIn.begin"))

  const required = pending.pipe(Effect.flatMap((waiting) => new AwsSignInRequired({ pending: waiting })))

  const accessToken = refreshing.withPermits(1)(Effect.gen(function*() {
    const stored = yield* read
    const now = yield* Clock.currentTimeMillis
    const token = stored.token
    if (token === null) return yield* required
    if (token.expiresAt - now > refreshMargin) return Redacted.make(token.accessToken)
    if (options.readOnly === true) return yield* required
    if (token.refreshToken === null || stored.client === null) {
      yield* write({ ...stored, token: null })
      return yield* required
    }
    const refreshed = yield* exchange(
      http,
      "refresh",
      post(`${oidc}/token`, {
        clientId: stored.client.clientId,
        clientSecret: stored.client.clientSecret,
        grantType: "refresh_token",
        refreshToken: token.refreshToken
      }),
      Granted
    ).pipe(
      Effect.catchTag("Refused", (refused) =>
        // A gone registration takes its tokens with it; begin registers again.
        refused.code === "invalid_client"
          ? write({ client: null, token: null }).pipe(Effect.andThen(required))
          : sessionEnded.has(refused.code)
          ? write({ ...stored, token: null }).pipe(Effect.andThen(required))
          // Throttled or malformed: the session may still be good, so keep it.
          : Effect.fail(new AwsSignInUnavailable({ operation: refused.operation, detail: refused.code })))
    )
    const next = grant(now, refreshed, token.refreshToken)
    yield* write({ ...stored, token: next })
    return Redacted.make(next.accessToken)
  })).pipe(Effect.withSpan("AwsSignIn.accessToken"))

  const state = Effect.gen(function*() {
    const token = (yield* read).token
    const now = yield* Clock.currentTimeMillis
    if (token !== null && (token.expiresAt > now || token.refreshToken !== null)) {
      return { _tag: "SignedIn", expiresAt: token.expiresAt } satisfies AwsSignInState
    }
    const held = yield* Ref.get(current)
    return held === null || held.verification === null
      ? { _tag: "SignInRequired" } satisfies AwsSignInState
      : { _tag: "SignInPending", ...held.verification } satisfies AwsSignInState
  })

  const revoked = (accessToken: Redacted.Redacted<string>) =>
    refreshing.withPermits(1)(Effect.gen(function*() {
      const stored = yield* read
      if (stored.token?.accessToken === Redacted.value(accessToken)) yield* write({ ...stored, token: null })
    }))

  return { state, accessToken, begin, revoked, region: options.region } satisfies AwsSignIn
})

export interface AwsRoleOptions {
  readonly accountId: string
  /** The permission set's role name. */
  readonly roleName: string
  /** The region AWS calls go to by default. */
  readonly region: string
}

/**
 * The `Credentials` service value for one account and permission set, from the hub's sign-in: provide it as
 * `Credentials`. Role credentials are fetched from the access portal through `http` and kept until five minutes
 * before their end. Without a sign-in a read fails as `ExpiredSSOToken` and starts nothing; an unreachable
 * portal fails as a credential provider error.
 */
export const awsRoleCredentials = (
  signIn: AwsSignIn,
  role: AwsRoleOptions,
  http: HttpClient.HttpClient
): Credentials["Service"] => {
  const cached = Ref.makeUnsafe<ResolvedCredentials | null>(null)
  const signInRequired = () => new ExpiredSSOToken({ message: "sign in to AWS", profile: "hub" })
  const required = Effect.fail(signInRequired())
  return Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    const held = yield* Ref.get(cached)
    if (held !== null && (held.expiration ?? 0) - now > refreshMargin) return held
    const token = yield* signIn.accessToken.pipe(
      Effect.catchTag("AwsSignInRequired", () => required)
    )
    // The client span records request headers; the bearer token must read as redacted there.
    const redacted = yield* Headers.CurrentRedactedNames
    const answer = yield* exchange(
      http,
      "role credentials",
      HttpClientRequest.get(`https://portal.sso.${signIn.region}.amazonaws.com/federation/credentials`).pipe(
        HttpClientRequest.setUrlParams({ account_id: role.accountId, role_name: role.roleName }),
        HttpClientRequest.setHeader(bearerHeader, Redacted.value(token))
      ),
      PortalCredentials
    ).pipe(
      Effect.provideService(Headers.CurrentRedactedNames, [...redacted, bearerHeader]),
      // 401: the Identity Center session ended. Any other refusal is about this role, and the sign-in stays.
      Effect.catchTag("Refused", (
        refused
      ): Effect.Effect<never, AwsSignInUnavailable | ExpiredSSOToken | AwsCredentialProviderError> =>
        refused.status === 401
          ? signIn.revoked(token).pipe(Effect.andThen(required))
          : Effect.fail(
            new AwsCredentialProviderError({ message: `${refused.operation}: ${refused.code}`, provider: "herdr-hub" })
          ))
    )
    const resolved: ResolvedCredentials = {
      accessKeyId: Redacted.make(answer.roleCredentials.accessKeyId),
      secretAccessKey: Redacted.make(answer.roleCredentials.secretAccessKey),
      sessionToken: Redacted.make(answer.roleCredentials.sessionToken),
      region: role.region,
      expiration: answer.roleCredentials.expiration
    }
    yield* Ref.set(cached, resolved)
    return resolved
  }).pipe(
    Effect.catchTag("AwsSignInUnavailable", (error) =>
      Effect.fail(
        new AwsCredentialProviderError({ message: `${error.operation}: ${error.detail}`, provider: "herdr-hub" })
      )),
    Effect.withSpan("AwsSignIn.roleCredentials")
  )
}
