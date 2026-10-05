import { describe, expect, it } from "@effect/vitest"
import { Cause, Clock, Crypto, Deferred, Duration, Effect, Exit, Fiber, Layer, Redacted, Result } from "effect"
import { HttpRouter } from "effect/http"
import { TestClock } from "effect/testing"
import * as OwnerSession from "../src/owner-session.js"
import { CredentialCookieError, PairingCode, readBootstrapToken } from "../src/schema.js"

const AUTHORITY = "http://127.0.0.1:3111"
const DEV_PROXY = "http://localhost:5173"

/** Distinct random bytes per call, so owner, CSRF and bootstrap codes never coincide. */
const counterCrypto = (): Crypto.Crypto => {
  let next = 1
  return Crypto.Crypto.of({
    randomBytes: (size) => Effect.sync(() => new Uint8Array(size).fill(next++)),
    randomUUIDv4: Effect.succeed("00000000-0000-4000-8000-000000000000"),
    randomUUIDv7: Effect.succeed("01900000-0000-7000-8000-000000000000"),
    digest: (_algorithm, bytes) => Effect.succeed(new Uint8Array(32).fill(bytes[0] ?? 0))
  })
}

const options = (overrides: Partial<OwnerSession.OwnerSessionOptions> = {}): OwnerSession.OwnerSessionOptions => ({
  authorityOrigin: AUTHORITY,
  browserOrigin: AUTHORITY,
  cookieName: "test_owner",
  freshUrlHint: "restart test for a fresh URL",
  product: "test",
  writes: "csrf",
  ...overrides
})

const make = (overrides?: Partial<OwnerSession.OwnerSessionOptions>) =>
  OwnerSession.make(options(overrides)).pipe(Effect.provideService(Crypto.Crypto, counterCrypto()))

const ownerCredential = (session: OwnerSession.OwnerSessionService): string =>
  decodeURIComponent(/=([^;]+)/u.exec(session.sessionCookie)?.[1] ?? "")

const csrf = (session: OwnerSession.OwnerSessionService): string =>
  session.writes._tag === "Csrf" ? Redacted.value(session.writes.token) : ""

const spend = (session: OwnerSession.OwnerSessionService, code: string | undefined, origin: string = AUTHORITY) =>
  Effect.result(session.authorizeBootstrap({
    authorization: code === undefined ? undefined : `Bearer ${code}`,
    origin
  }))

const failureTag = <A, E extends { readonly _tag: string }>(result: Result.Result<A, E>) =>
  Result.isFailure(result) ? result.failure._tag : "Success"

const failureMessage = <A, E extends { readonly message: string }>(result: Result.Result<A, E>) =>
  Result.isFailure(result) ? result.failure.message : ""

describe("loopback addresses", () => {
  it.effect("binds only loopback hostnames", () =>
    Effect.gen(function*() {
      for (const hostname of ["127.0.0.1", "localhost", "::1"]) {
        expect(yield* OwnerSession.requireLoopbackHostname(hostname)).toBe(hostname)
      }
      const peer = yield* Effect.result(OwnerSession.requireLoopbackHostname("0.0.0.0"))
      expect(failureTag(peer)).toBe("UnsafeLoopbackAddressError")
    }))

  it.effect("accepts plain HTTP loopback origins only", () =>
    Effect.gen(function*() {
      expect(yield* OwnerSession.requireLoopbackOrigin("http://localhost:5173")).toBe("http://localhost:5173")
      expect(yield* OwnerSession.requireLoopbackOrigin("http://[::1]:3000/")).toBe("http://[::1]:3000")
      for (
        const origin of [
          "https://127.0.0.1:3000",
          "http://example.test:3000",
          "http://127.0.0.1:3000/app",
          "http://127.0.0.1:3000/?q=1",
          "http://127.0.0.1:3000/#x",
          "not a url"
        ]
      ) {
        const result = yield* Effect.result(OwnerSession.requireLoopbackOrigin(origin))
        expect(failureTag(result), origin).toBe("UnsafeLoopbackAddressError")
      }
    }))

  it("formats the bound origin, bracketing IPv6", () => {
    expect(OwnerSession.loopbackOrigin("127.0.0.1", 3000)).toBe("http://127.0.0.1:3000")
    expect(OwnerSession.loopbackOrigin("::1", 3000)).toBe("http://[::1]:3000")
  })

  it.effect("advertises only the bound server or the dev proxy", () =>
    Effect.gen(function*() {
      expect(yield* OwnerSession.resolvePublicOrigin(undefined, AUTHORITY)).toBe(AUTHORITY)
      expect(yield* OwnerSession.resolvePublicOrigin(AUTHORITY, AUTHORITY)).toBe(AUTHORITY)
      expect(yield* OwnerSession.resolvePublicOrigin(DEV_PROXY, AUTHORITY)).toBe(DEV_PROXY)
      expect(yield* OwnerSession.resolvePublicOrigin(DEV_PROXY, "http://localhost:3111")).toBe(DEV_PROXY)
      const other = yield* Effect.result(OwnerSession.resolvePublicOrigin("http://localhost:4173", AUTHORITY))
      expect(failureTag(other)).toBe("UnsafeLoopbackAddressError")
    }))

  it("builds the URL the page's readBootstrapToken reads the same code back from", () => {
    const code = Redacted.make(PairingCode.make("cd".repeat(32)))
    const read = readBootstrapToken(new URL(OwnerSession.bootstrapUrl(AUTHORITY, code)).hash)
    expect(read._tag === "present" && Redacted.value(read.token)).toBe("cd".repeat(32))
  })

  it("puts the code in the fragment, never the path or query", () => {
    const code = Redacted.make(PairingCode.make("ab".repeat(32)))
    expect(OwnerSession.bootstrapUrl(`${DEV_PROXY}/`, code)).toBe(`${DEV_PROXY}/#bootstrap_token=${"ab".repeat(32)}`)
  })
})

describe("construction", () => {
  it.effect("refuses non-loopback origins", () =>
    Effect.gen(function*() {
      const authority = yield* Effect.result(make({ authorityOrigin: "http://example.test:3000" }))
      expect(failureTag(authority)).toBe("UnsafeLoopbackAddressError")
      const browser = yield* Effect.result(make({ browserOrigin: "https://127.0.0.1:3000" }))
      expect(failureTag(browser)).toBe("UnsafeLoopbackAddressError")
    }))

  it.effect("fails typed, not as a defect, on an invalid cookie name", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(make({ cookieName: "bad;name" }))
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(CredentialCookieError)
      expect((yield* make({ cookieName: "custom_owner" })).sessionCookie).toMatch(/^custom_owner=/u)
    }))

  it.effect("issues a host-only, HttpOnly, strict cookie scoped to the API", () =>
    Effect.gen(function*() {
      const session = yield* make()
      expect(session.sessionCookie).toMatch(/^test_owner=/u)
      expect(session.sessionCookie).toContain("HttpOnly")
      expect(session.sessionCookie).toContain("Path=/api")
      expect(session.sessionCookie).toContain("SameSite=Strict")
      expect(session.sessionCookie).not.toContain("Domain=")
    }))

  it.effect("issues a CSRF token only when writes are allowed", () =>
    Effect.gen(function*() {
      expect((yield* make()).writes._tag).toBe("Csrf")
      expect((yield* make({ writes: "none" })).writes._tag).toBe("ReadOnly")
    }))
})

describe("authorizeRequest", () => {
  const read = (session: OwnerSession.OwnerSessionService): OwnerSession.OwnerRequest => ({
    credential: ownerCredential(session),
    csrfToken: undefined,
    fetchSite: undefined,
    method: "GET",
    origin: undefined
  })

  it.effect("rejects a missing or wrong session cookie", () =>
    Effect.gen(function*() {
      const session = yield* make()
      for (const credential of ["", "ab".repeat(32)]) {
        const result = yield* Effect.result(session.authorizeRequest({ ...read(session), credential }))
        expect(failureTag(result)).toBe("OwnerSessionUnauthorizedError")
      }
    }))

  it.effect("rejects browser-marked cross-origin reads while keeping explicit clients", () =>
    Effect.gen(function*() {
      const session = yield* make({ browserOrigin: DEV_PROXY })
      const cases: ReadonlyArray<{
        readonly expected: string
        readonly fetchSite: string | undefined
        readonly origin: string | undefined
      }> = [
        { expected: "Success", fetchSite: undefined, origin: undefined },
        { expected: "Success", fetchSite: "same-origin", origin: undefined },
        { expected: "Success", fetchSite: "same-origin", origin: DEV_PROXY },
        { expected: "Success", fetchSite: "same-site", origin: DEV_PROXY },
        { expected: "OwnerSessionForbiddenError", fetchSite: undefined, origin: AUTHORITY },
        { expected: "OwnerSessionForbiddenError", fetchSite: "same-site", origin: undefined },
        { expected: "OwnerSessionForbiddenError", fetchSite: "cross-site", origin: undefined },
        { expected: "OwnerSessionForbiddenError", fetchSite: "none", origin: undefined },
        { expected: "OwnerSessionForbiddenError", fetchSite: "other", origin: undefined },
        { expected: "OwnerSessionForbiddenError", fetchSite: "cross-site", origin: DEV_PROXY }
      ]
      for (const testCase of cases) {
        const result = yield* Effect.result(session.authorizeRequest({ ...read(session), ...testCase }))
        expect(failureTag(result), JSON.stringify(testCase)).toBe(testCase.expected)
      }
    }))

  it.effect("admits a write only from the browser origin with the CSRF token", () =>
    Effect.gen(function*() {
      const session = yield* make({ browserOrigin: DEV_PROXY })
      const write = { ...read(session), csrfToken: csrf(session), method: "POST", origin: DEV_PROXY }
      expect(failureTag(yield* Effect.result(session.authorizeRequest(write)))).toBe("Success")
      for (
        const variant of [
          { origin: undefined },
          { origin: AUTHORITY },
          { origin: "https://evil.example" },
          { csrfToken: undefined },
          { csrfToken: "wrong" }
        ]
      ) {
        const result = yield* Effect.result(session.authorizeRequest({ ...write, ...variant }))
        expect(failureTag(result), JSON.stringify(variant)).toBe("OwnerSessionForbiddenError")
      }
    }))

  it.effect("refuses every unsafe method on a read-only server", () =>
    Effect.gen(function*() {
      const session = yield* make({ writes: "none" })
      expect(failureTag(yield* Effect.result(session.authorizeRequest(read(session))))).toBe("Success")
      const write = yield* Effect.result(
        session.authorizeRequest({ ...read(session), method: "POST", origin: AUTHORITY })
      )
      expect(failureTag(write)).toBe("OwnerSessionForbiddenError")
      expect(failureMessage(write)).toBe("This server only answers reads")
    }))
})

describe("authorizeBootstrap", () => {
  it.effect("nothing signs in before a code has been minted", () =>
    Effect.gen(function*() {
      const session = yield* make()
      expect(failureTag(yield* spend(session, "ab".repeat(32)))).toBe("OwnerSessionUnauthorizedError")
    }))

  it.effect("a minted code signs in once, and only from the browser origin", () =>
    Effect.gen(function*() {
      const session = yield* make({ browserOrigin: DEV_PROXY })
      const code = Redacted.value(yield* session.mintBootstrapCode)
      expect(failureTag(yield* spend(session, code, AUTHORITY))).toBe("OwnerSessionForbiddenError")
      expect(failureTag(yield* spend(session, code, DEV_PROXY))).toBe("Success")
      const reused = yield* spend(session, code, DEV_PROXY)
      expect(failureMessage(reused)).toBe("Bootstrap token has already been used")
    }))

  it.effect("a code is refused at the exact end of its minute", () =>
    Effect.gen(function*() {
      const before = yield* make()
      const beforeCode = Redacted.value(yield* before.mintBootstrapCode)
      yield* TestClock.adjust(Duration.millis(59_999))
      expect(failureTag(yield* spend(before, beforeCode))).toBe("Success")

      const at = yield* make()
      const atCode = Redacted.value(yield* at.mintBootstrapCode)
      yield* TestClock.adjust(Duration.seconds(60))
      const expired = yield* spend(at, atCode)
      expect(failureTag(expired)).toBe("OwnerSessionUnauthorizedError")
      expect(failureMessage(expired)).toBe("Bootstrap token has expired — restart test for a fresh URL")
    }))

  it.effect("a newer code replaces an unspent one", () =>
    Effect.gen(function*() {
      const session = yield* make()
      const older = Redacted.value(yield* session.mintBootstrapCode)
      const newer = Redacted.value(yield* session.mintBootstrapCode)
      expect(newer).not.toBe(older)
      expect(failureTag(yield* spend(session, older))).toBe("OwnerSessionUnauthorizedError")
      expect(failureTag(yield* spend(session, newer))).toBe("Success")
    }))

  it.effect("cross-origin attempts are refused without spending the guess budget", () =>
    Effect.gen(function*() {
      const session = yield* make()
      const code = Redacted.value(yield* session.mintBootstrapCode)
      for (let attempt = 0; attempt < 6; attempt += 1) {
        expect(failureTag(yield* spend(session, undefined, "https://attacker.example"))).toBe(
          "OwnerSessionForbiddenError"
        )
      }
      expect(failureTag(yield* spend(session, code))).toBe("Success")
    }))

  it.effect("five wrong guesses close the exchange, even to the right code, until a new mint", () =>
    Effect.gen(function*() {
      const session = yield* make()
      const code = Redacted.value(yield* session.mintBootstrapCode)
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(failureMessage(yield* spend(session, "wrong"))).toBe("Missing or invalid bootstrap token")
      }
      expect(failureMessage(yield* spend(session, code))).toBe("Bootstrap is closed until a new code is minted")
      const fresh = Redacted.value(yield* session.mintBootstrapCode)
      expect(failureTag(yield* spend(session, fresh))).toBe("Success")
    }))

  it.effect("counts concurrent guesses atomically", () =>
    Effect.gen(function*() {
      const session = yield* make()
      yield* session.mintBootstrapCode
      const results = yield* Effect.all(
        Array.from({ length: 6 }, () => spend(session, "wrong")),
        { concurrency: "unbounded" }
      )
      const messages = results.map(failureMessage)
      expect(messages.filter((message) => message === "Missing or invalid bootstrap token")).toHaveLength(5)
      expect(messages.filter((message) => message === "Bootstrap is closed until a new code is minted")).toHaveLength(1)
    }))

  it.effect("an interrupted exchange releases its reservation and leaves the code unspent", () =>
    Effect.gen(function*() {
      const session = yield* make()
      const code = Redacted.value(yield* session.mintBootstrapCode)
      const gate = yield* Deferred.make<number>()
      const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock))
      const blockedClock: Clock.Clock = { ...testClock, currentTimeMillis: Deferred.await(gate) }
      const fiber = yield* Effect.forkChild(spend(session, code).pipe(Effect.provideService(Clock.Clock, blockedClock)))
      yield* Effect.yieldNow
      // Four more in-flight-plus-failed slots would close the exchange if the reservation leaked.
      yield* Fiber.interrupt(fiber)
      for (let attempt = 0; attempt < 4; attempt += 1) yield* spend(session, "wrong")
      expect(failureTag(yield* spend(session, code))).toBe("Success")
    }))
})

describe("BootstrapRouter", () => {
  const handler = (session: OwnerSession.OwnerSessionService) =>
    HttpRouter.toWebHandler(
      OwnerSession.BootstrapRouter.pipe(Layer.provide(Layer.succeed(OwnerSession.OwnerSession, session))),
      { disableLogger: true }
    )

  const post = (code: string, origin: string = AUTHORITY) =>
    new Request(`${AUTHORITY}/auth/bootstrap`, {
      headers: { authorization: `Bearer ${code}`, origin },
      method: "POST"
    })

  it.live("answers the CSRF token and the session cookie, uncached", () =>
    Effect.gen(function*() {
      const session = yield* make()
      const code = Redacted.value(yield* session.mintBootstrapCode)
      const web = handler(session)
      const response = yield* Effect.promise(() => web.handler(post(code)))
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("set-cookie")).toBe(session.sessionCookie)
      expect(yield* Effect.promise(() => response.json())).toEqual({ csrfToken: csrf(session) })
      expect((yield* Effect.promise(() => web.handler(post(code)))).status).toBe(401)
      expect((yield* Effect.promise(() => web.handler(post(code, "http://localhost:9999")))).status).toBe(403)
      yield* Effect.promise(() => web.dispose())
    }))

  it.live("answers an empty body on a read-only server", () =>
    Effect.gen(function*() {
      const session = yield* make({ writes: "none" })
      const code = Redacted.value(yield* session.mintBootstrapCode)
      const web = handler(session)
      const response = yield* Effect.promise(() => web.handler(post(code)))
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toEqual({})
      yield* Effect.promise(() => web.dispose())
    }))
})
