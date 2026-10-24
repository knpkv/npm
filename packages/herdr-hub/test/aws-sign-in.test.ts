import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { openPrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Clock, Effect, Option, Redacted, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Path from "effect/Path"
import { TestClock } from "effect/testing"
import { awsRoleCredentials, makeAwsSignIn } from "../src/aws-sign-in.js"

/** One call as Identity Center saw it. */
const Fields = Schema.Record(Schema.String, Schema.Json)

interface Call {
  readonly host: string
  readonly path: string
  readonly body: typeof Fields.Type
  readonly bearer: string | undefined
  /** The client span's attribute values, as a trace exporter would see them. */
  readonly traced: ReadonlyArray<string>
}

interface Reply {
  readonly status?: number
  readonly body: Schema.Json
  readonly headers?: Readonly<Record<string, string>>
}

const ok = (body: Schema.Json): Reply => ({ body })
const refused = (error: string, status = 400): Reply => ({ status, body: { error, error_description: "no" } })

/** The portal's restJson1 error: a message, with the type in a header rather than an OAuth `error` field. */
const portalError = (type: string, status: number): Reply => ({
  status,
  body: { message: "Session token not found or invalid" },
  headers: { "x-amzn-ErrorType": `${type}:http://internal.amazon.com/coral/com.amazonaws.switchboard.portal/` }
})

/**
 * Identity Center: registration and device authorization always succeed; `/token` answers from `tokens`
 * in order (the last repeats); the portal answers role credentials lasting `roleLifetime`, or `portal`.
 */
const identityCenter = (tokens: Array<Reply>, calls: Array<Call>, roleLifetime = 3_600_000, portal?: Reply) =>
  HttpClient.make((request) =>
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      const span = yield* Effect.currentParentSpan.pipe(Effect.option)
      const traced = Option.isSome(span) && span.value._tag === "Span"
        ? [...span.value.attributes.values()].map(String)
        : []
      const url = new URL(request.url)
      const text = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
      const body = text === "" ? {} : Schema.decodeUnknownSync(Schema.fromJsonString(Fields))(text)
      calls.push({
        host: url.host,
        path: url.pathname,
        body,
        bearer: request.headers["x-amz-sso_bearer_token"],
        traced
      })
      const reply = url.pathname === "/client/register"
        ? ok({ clientId: "client-1", clientSecret: "client-secret", clientSecretExpiresAt: 90 * 86_400 })
        : url.pathname === "/device_authorization"
        ? ok({
          deviceCode: "device-1",
          userCode: "ABCD-EFGH",
          verificationUri: "https://example.awsapps.com/start/#/device",
          verificationUriComplete: "https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH",
          expiresIn: 600,
          interval: 5
        })
        : url.pathname === "/token"
        ? (tokens.length > 1 ? tokens.shift() : tokens[0]) ?? refused("server_error", 500)
        : url.pathname === "/federation/credentials"
        ? portal ?? ok({
          roleCredentials: {
            accessKeyId: "ASIAROLE",
            secretAccessKey: "role-secret",
            sessionToken: "role-token",
            expiration: now + roleLifetime
          }
        })
        : refused("not_found", 404)
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(reply.body), {
          status: reply.status ?? 200,
          headers: { "content-type": "application/json", ...reply.headers }
        })
      )
    })
  )

const granted = (accessToken = "access-1", expiresIn = 3_600, refreshToken = "refresh-1") =>
  ok({ accessToken, expiresIn, refreshToken, tokenType: "Bearer" })

const signInWith = (client: HttpClient.HttpClient, pending: Array<string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "aws-sign-in-" })
    const signIn = yield* makeAwsSignIn({
      startUrl: "https://example.awsapps.com/start",
      region: "eu-central-1",
      databasePath: path.join(directory, "aws-sign-in.sqlite"),
      pendingFile: path.join(directory, "aws-sign-in-pending.json"),
      onPending: (file) => Effect.sync(() => void pending.push(file))
    }).pipe(Effect.provideService(HttpClient.HttpClient, client))
    return { signIn, directory, pendingFile: path.join(directory, "aws-sign-in-pending.json") }
  })

const paths = (calls: ReadonlyArray<Call>) => calls.map(({ path }) => path)

it.layer(NodeServices.layer)("AWS sign-in", (it) => {
  it.effect("signs in by device code: the URL goes to an owner-only file, the hook gets only its path", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const calls: Array<Call> = []
      const pending: Array<string> = []
      const { pendingFile, signIn } = yield* signInWith(
        identityCenter([refused("authorization_pending"), granted()], calls),
        pending
      )
      const start = yield* Clock.currentTimeMillis
      expect(yield* signIn.state).toEqual({ _tag: "SignInRequired", pending: false })
      const { ended } = yield* signIn.begin
      expect(pending).toEqual([pendingFile])
      expect((yield* fs.stat(pendingFile)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(yield* fs.readFileString(pendingFile))).toEqual({
        verificationUri: "https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH",
        expiresAt: start + 600_000
      })
      expect(yield* signIn.state).toEqual({ _tag: "SignInRequired", pending: true })
      yield* TestClock.adjust("5 seconds")
      yield* TestClock.adjust("5 seconds")
      yield* ended
      expect(yield* signIn.state).toEqual({ _tag: "SignedIn", expiresAt: start + 3_610_000 })
      expect(yield* fs.exists(pendingFile)).toBe(false)
      expect(Redacted.value(yield* signIn.accessToken)).toBe("access-1")
      expect(paths(calls)).toEqual(["/client/register", "/device_authorization", "/token", "/token"])
      expect(calls[0]?.host).toBe("oidc.eu-central-1.amazonaws.com")
      expect(calls[1]?.body).toEqual({
        clientId: "client-1",
        clientSecret: "client-secret",
        startUrl: "https://example.awsapps.com/start"
      })
    }).pipe(Effect.scoped))

  it.effect("replaces a stale or planted pending file, never writing through it", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "aws-sign-in-" })
      const pendingFile = path.join(directory, "aws-sign-in-pending.json")
      const elsewhere = path.join(directory, "elsewhere.json")
      yield* fs.writeFileString(elsewhere, "untouched", { mode: 0o644 })
      yield* fs.symlink(elsewhere, pendingFile)
      const options = {
        startUrl: "https://example.awsapps.com/start",
        region: "eu-central-1",
        databasePath: path.join(directory, "aws-sign-in.sqlite"),
        pendingFile,
        onPending: () => Effect.void
      }
      const client = identityCenter([refused("authorization_pending")], [])
      // A file left by a killed hub names a dead code: opening the sign-in removes it.
      yield* makeAwsSignIn(options).pipe(Effect.provideService(HttpClient.HttpClient, client))
      expect(yield* fs.exists(pendingFile)).toBe(false)
      const signIn = yield* makeAwsSignIn({ ...options, databasePath: path.join(directory, "second.sqlite") }).pipe(
        Effect.provideService(HttpClient.HttpClient, client)
      )
      // Planted after opening: the sign-in still replaces the link rather than writing to its target.
      yield* fs.symlink(elsewhere, pendingFile)
      yield* Effect.asVoid(signIn.begin)
      expect(yield* fs.readFileString(elsewhere)).toBe("untouched")
      expect((yield* fs.stat(elsewhere)).mode & 0o777).toBe(0o644)
      const written = yield* fs.stat(pendingFile)
      expect([written.type, written.mode & 0o777]).toEqual(["File", 0o600])
    }).pipe(Effect.scoped))

  it.effect("starts one sign-in at a time", () =>
    Effect.gen(function*() {
      const calls: Array<Call> = []
      const pending: Array<string> = []
      const { signIn } = yield* signInWith(identityCenter([refused("authorization_pending")], calls), pending)
      yield* Effect.asVoid(signIn.begin)
      yield* Effect.asVoid(signIn.begin)
      expect(pending.length).toBe(1)
      expect(paths(calls).filter((path) => path === "/device_authorization").length).toBe(1)
    }).pipe(Effect.scoped))

  it.effect("a code that expires or is denied deletes the file and leaves sign-in required", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      for (const ending of ["expired_token", "access_denied"]) {
        const { pendingFile, signIn } = yield* signInWith(identityCenter([refused(ending)], []), [])
        const { ended } = yield* signIn.begin
        yield* TestClock.adjust("5 seconds")
        yield* ended
        expect(yield* fs.exists(pendingFile)).toBe(false)
        expect(yield* signIn.state).toEqual({ _tag: "SignInRequired", pending: false })
      }
    }).pipe(Effect.scoped))

  it.effect("a sign-in that fails after writing its file deletes it and is not left pending", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "aws-sign-in-" })
      const pendingFile = path.join(directory, "aws-sign-in-pending.json")
      const signIn = yield* makeAwsSignIn({
        startUrl: "https://example.awsapps.com/start",
        region: "eu-central-1",
        databasePath: path.join(directory, "aws-sign-in.sqlite"),
        pendingFile,
        onPending: () => Effect.die("the hook broke")
      }).pipe(Effect.provideService(HttpClient.HttpClient, identityCenter([refused("authorization_pending")], [])))
      yield* Effect.exit(signIn.begin)
      expect(yield* fs.exists(pendingFile)).toBe(false)
      expect(yield* signIn.state).toEqual({ _tag: "SignInRequired", pending: false })
    }).pipe(Effect.scoped))

  it.effect("slows its polling when asked to", () =>
    Effect.gen(function*() {
      const calls: Array<Call> = []
      const { signIn } = yield* signInWith(identityCenter([refused("slow_down"), granted()], calls), [])
      const { ended } = yield* signIn.begin
      yield* TestClock.adjust("5 seconds")
      yield* TestClock.adjust("5 seconds")
      // After slow_down the interval is 10 s, so the second poll has not run yet.
      expect(paths(calls).filter((path) => path === "/token").length).toBe(1)
      yield* TestClock.adjust("5 seconds")
      yield* ended
      expect((yield* signIn.state)._tag).toBe("SignedIn")
    }).pipe(Effect.scoped))

  it.effect("refreshes an access token near its end; a refused refresh means signing in again", () =>
    Effect.gen(function*() {
      const calls: Array<Call> = []
      const { signIn } = yield* signInWith(
        identityCenter([granted("access-1", 600), granted("access-2"), refused("invalid_grant")], calls),
        []
      )
      const { ended } = yield* signIn.begin
      yield* TestClock.adjust("5 seconds")
      yield* ended
      // 600 s minus the 5 s poll leaves under 5 minutes once 6 more minutes pass.
      yield* TestClock.adjust("6 minutes")
      expect(Redacted.value(yield* signIn.accessToken)).toBe("access-2")
      expect(calls.at(-1)?.body).toEqual({
        clientId: "client-1",
        clientSecret: "client-secret",
        grantType: "refresh_token",
        refreshToken: "refresh-1"
      })
      yield* TestClock.adjust("2 hours")
      const failure = yield* Effect.flip(signIn.accessToken)
      expect(failure._tag).toBe("AwsSignInRequired")
      expect(yield* signIn.state).toEqual({ _tag: "SignInRequired", pending: false })
    }).pipe(Effect.scoped))

  it.effect("a throttled or malformed refresh keeps the sign-in; a gone client clears it and registers again", () =>
    Effect.gen(function*() {
      const calls: Array<Call> = []
      const { signIn } = yield* signInWith(
        identityCenter(
          [granted("access-1", 600), refused("slow_down"), refused("invalid_request"), refused("invalid_client")],
          calls
        ),
        []
      )
      const { ended } = yield* signIn.begin
      yield* TestClock.adjust("5 seconds")
      yield* ended
      yield* TestClock.adjust("6 minutes")
      for (const code of ["slow_down", "invalid_request"]) {
        const failure = yield* Effect.flip(signIn.accessToken)
        expect([failure._tag, code]).toEqual(["AwsSignInUnavailable", code])
        expect((yield* signIn.state)._tag).toBe("SignedIn")
      }
      expect((yield* Effect.flip(signIn.accessToken))._tag).toBe("AwsSignInRequired")
      expect(yield* signIn.state).toEqual({ _tag: "SignInRequired", pending: false })
      yield* Effect.asVoid(signIn.begin)
      expect(paths(calls).filter((path) => path === "/client/register").length).toBe(2)
    }).pipe(Effect.scoped))

  it.effect("an unreadable stored sign-in fails without quoting what it holds", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "aws-sign-in-" })
      const databasePath = path.join(directory, "aws-sign-in.sqlite")
      const signIn = yield* makeAwsSignIn({
        startUrl: "https://example.awsapps.com/start",
        region: "eu-central-1",
        databasePath,
        pendingFile: path.join(directory, "aws-sign-in-pending.json"),
        onPending: () => Effect.void
      }).pipe(Effect.provideService(HttpClient.HttpClient, identityCenter([], [])))
      const seeded = yield* openPrivateSqlite(databasePath, { initialize: () => undefined })
      // Each row replaces the one row, then is read once.
      const unreadable = (value: string) =>
        Effect.sync(() =>
          seeded.database.prepare("INSERT OR REPLACE INTO aws_sign_in (session, value) VALUES (?, ?)").run(
            "eu-central-1 https://example.awsapps.com/start",
            value
          )
        ).pipe(Effect.andThen(Effect.flip(signIn.state)))
      const badToken = yield* unreadable(
        "{\"client\":null,\"token\":{\"accessToken\":\"leaky-token\",\"refreshToken\":5,\"expiresAt\":1}}"
      )
      const notJson = yield* unreadable("{\"client\":{\"clientSecret\":\"leaky-secret\"\"},\"token\":null}")
      for (const failure of [badToken, notJson]) {
        expect(failure).toMatchObject({ _tag: "AwsSignInUnavailable", operation: "read", detail: "unreadable" })
      }
      seeded.database.close()
    }).pipe(Effect.scoped))

  it.effect("keeps the sign-in across a restart, in the database only", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "aws-sign-in-" })
      const options = {
        startUrl: "https://example.awsapps.com/start",
        region: "eu-central-1",
        databasePath: path.join(directory, "aws-sign-in.sqlite"),
        pendingFile: path.join(directory, "aws-sign-in-pending.json"),
        onPending: () => Effect.void
      }
      yield* Effect.scoped(Effect.gen(function*() {
        const signIn = yield* makeAwsSignIn(options)
        const { ended } = yield* signIn.begin
        yield* TestClock.adjust("5 seconds")
        yield* ended
      })).pipe(Effect.provideService(HttpClient.HttpClient, identityCenter([granted()], [])))
      const calls: Array<Call> = []
      const reopened = yield* makeAwsSignIn(options).pipe(
        Effect.provideService(HttpClient.HttpClient, identityCenter([], calls))
      )
      expect(Redacted.value(yield* reopened.accessToken)).toBe("access-1")
      expect(calls).toEqual([])
      expect((yield* fs.stat(options.databasePath)).mode & 0o777).toBe(0o600)
    }).pipe(Effect.scoped))

  it.effect("role credentials come from the portal with the bearer token, cached until near their end", () =>
    Effect.gen(function*() {
      const calls: Array<Call> = []
      const client = identityCenter([granted()], calls, 7_200_000)
      const { signIn } = yield* signInWith(client, [])
      const { ended } = yield* signIn.begin
      yield* TestClock.adjust("5 seconds")
      yield* ended
      const credentials = awsRoleCredentials(
        signIn,
        { accountId: "999999999900", roleName: "PoolOperator", region: "eu-central-1" },
        client
      )
      const first = yield* credentials
      yield* credentials
      expect([Redacted.value(first.accessKeyId), first.region]).toEqual(["ASIAROLE", "eu-central-1"])
      const portal = calls.filter(({ path }) => path === "/federation/credentials")
      expect(portal.length).toBe(1)
      // The bearer token is a credential: the client span records the header redacted.
      expect(portal[0]?.traced).toContain("<redacted>")
      expect(calls.flatMap(({ traced }) => traced).filter((value) => /access-1|refresh-1|client-secret/.test(value)))
        .toEqual([])
      expect([portal[0]?.host, portal[0]?.bearer]).toEqual(["portal.sso.eu-central-1.amazonaws.com", "access-1"])
      yield* TestClock.adjust("1 hour")
      yield* TestClock.adjust("56 minutes")
      yield* credentials
      expect(calls.filter(({ path }) => path === "/federation/credentials").length).toBe(2)
    }).pipe(Effect.scoped))

  it.effect("without a sign-in, role credentials fail as an expired SSO token and start one sign-in", () =>
    Effect.gen(function*() {
      const pending: Array<string> = []
      const client = identityCenter([refused("authorization_pending")], [])
      const { signIn } = yield* signInWith(client, pending)
      const credentials = awsRoleCredentials(
        signIn,
        { accountId: "999999999900", roleName: "PoolOperator", region: "eu-central-1" },
        client
      )
      const first = yield* Effect.flip(credentials)
      yield* Effect.flip(credentials)
      expect(first._tag).toBe("Alchemy::AWS::ExpiredSSOToken")
      expect(pending.length).toBe(1)
    }).pipe(Effect.scoped))

  it.effect("a portal that no longer accepts the token clears the sign-in and starts one; a refused role is typed", () =>
    Effect.gen(function*() {
      const role = { accountId: "999999999900", roleName: "PoolOperator", region: "eu-central-1" }
      const pending: Array<string> = []
      const revoked = identityCenter(
        [granted(), refused("authorization_pending")],
        [],
        3_600_000,
        portalError("UnauthorizedException", 401)
      )
      const { signIn } = yield* signInWith(revoked, pending)
      const { ended } = yield* signIn.begin
      yield* TestClock.adjust("5 seconds")
      yield* ended
      const failure = yield* Effect.flip(awsRoleCredentials(signIn, role, revoked))
      expect(failure._tag).toBe("Alchemy::AWS::ExpiredSSOToken")
      expect(yield* signIn.state).toEqual({ _tag: "SignInRequired", pending: true })
      expect(pending.length).toBe(2)

      const forbidden = identityCenter([granted()], [], 3_600_000, portalError("ForbiddenException", 403))
      const second = yield* signInWith(forbidden, [])
      const started = yield* second.signIn.begin
      yield* TestClock.adjust("5 seconds")
      yield* started.ended
      const refusedRole = yield* Effect.flip(awsRoleCredentials(second.signIn, role, forbidden))
      expect(refusedRole).toMatchObject({
        _tag: "AWS::CredentialProviderError",
        message: "role credentials: ForbiddenException"
      })
      expect((yield* second.signIn.state)._tag).toBe("SignedIn")
    }).pipe(Effect.scoped))
})
