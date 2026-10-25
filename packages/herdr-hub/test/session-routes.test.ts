import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { Effect, FileSystem, Path, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { makeLocalLogin } from "../src/internal/local-login.js"
import { csrfFor, makePersonSessions } from "../src/internal/person-sessions.js"
import {
  localSessionCookieName,
  readCookie,
  sessionCookieName,
  type SessionRequest,
  sessionRoute
} from "../src/internal/session-routes.js"

const host = Schema.decodeUnknownSync(FleetHostName)("atlas")
const config = { machines: [{ host, nodeId: "node-build" }] }

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const fixture = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "hub-session-routes-" })
  const sessions = yield* makePersonSessions(path.join(directory, "sessions.sqlite"))
  const localLogin = yield* makeLocalLogin
  const route = (request: Partial<SessionRequest> & Pick<SessionRequest, "listener" | "method" | "pathname">) =>
    sessionRoute({ config, sessions, localLogin }, {
      cookieToken: undefined,
      csrf: undefined,
      cli: false,
      origin: undefined,
      headerLogin: undefined,
      sameOrigin: Effect.void,
      identity: Effect.succeed({ login: "owner@example.test", nodeId: "node-phone", device: "owner-phone" }),
      body: Effect.succeed({}),
      ...request
    })
  return { sessions, localLogin, route }
})

const cookieValue = (setCookie: string | undefined) => setCookie?.split(";")[0]?.split("=")[1]

describe("session routes", () => {
  it.layer(NodeServices.layer)((it) => {
    // Logging in over Tailscale sets a __Host- cookie only this hostname's https origin can set or read.
    it.effect("logs a Tailscale person in with a __Host- cookie and reads the session back", () =>
      Effect.scoped(Effect.gen(function*() {
        const { route } = yield* fixture
        const before = yield* route({ listener: "serve", method: "GET", pathname: "/v1/session" })
        expect(before?.body).toEqual({
          signedIn: false,
          kind: "tailscale",
          login: "owner@example.test",
          device: "owner-phone",
          fleetHost: false,
          ended: false
        })
        const login = yield* route({ listener: "serve", method: "POST", pathname: "/v1/session/tailscale" })
        expect(login?.status).toBe(200)
        expect(login?.setCookie).toMatch(
          new RegExp(`^${sessionCookieName}=[0-9a-f]{64}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800$`)
        )
        const token = cookieValue(login?.setCookie)
        const after = yield* route({ listener: "serve", method: "GET", pathname: "/v1/session", cookieToken: token })
        expect(after?.body).toMatchObject({ signedIn: true, kind: "tailscale", login: "owner@example.test" })
        expect(after?.body).toHaveProperty("csrf")
      })))

    // The login gate draws its state from the read: a session that ended, and a fleet machine, each say so.
    it.effect("says when a session ended and when the caller is on a fleet machine", () =>
      Effect.scoped(Effect.gen(function*() {
        const { route } = yield* fixture
        const login = yield* route({ listener: "serve", method: "POST", pathname: "/v1/session/tailscale" })
        const token = cookieValue(login?.setCookie) ?? ""
        yield* route({
          listener: "serve",
          method: "POST",
          pathname: "/v1/session/logout",
          cookieToken: token,
          csrf: Redacted.value(yield* csrfFor(token))
        })
        expect((yield* route({ listener: "serve", method: "GET", pathname: "/v1/session", cookieToken: token }))?.body)
          .toMatchObject({ signedIn: false, kind: "tailscale", ended: true })
        expect(
          (yield* route({ listener: "local", method: "GET", pathname: "/v1/session", cookieToken: "f".repeat(43) }))
            ?.body
        ).toEqual({ signedIn: false, kind: "local", ended: true })
        expect((yield* route({ listener: "local", method: "GET", pathname: "/v1/session" }))?.body)
          .toEqual({ signedIn: false, kind: "local", ended: false })
        const onMachine = yield* route({
          listener: "serve",
          method: "GET",
          pathname: "/v1/session",
          identity: Effect.succeed({ login: "owner@example.test", nodeId: "node-build", device: "build" })
        })
        expect(onMachine?.body).toMatchObject({ signedIn: false, fleetHost: true, ended: false })
      })))

    // Only a session matched to the caller's login and node is renewed: a cookie replayed from another node
    // is read, ignored, and left to run out.
    it.effect("renews a session only for the node it was opened on", () =>
      Effect.scoped(Effect.gen(function*() {
        const { route, sessions } = yield* fixture
        const login = yield* route({ listener: "serve", method: "POST", pathname: "/v1/session/tailscale" })
        const token = cookieValue(login?.setCookie) ?? ""
        const opened = (yield* sessions.read(token))?.expiresAt
        yield* TestClock.adjust("2 hours")
        const elsewhere = yield* route({
          listener: "serve",
          method: "GET",
          pathname: "/v1/session",
          cookieToken: token,
          identity: Effect.succeed({ login: "owner@example.test", nodeId: "node-laptop", device: undefined })
        })
        expect(elsewhere?.body).toMatchObject({ signedIn: false })
        expect((yield* sessions.read(token))?.expiresAt).toBe(opened)
        yield* route({ listener: "serve", method: "GET", pathname: "/v1/session", cookieToken: token })
        expect((yield* sessions.read(token))?.expiresAt).toBeGreaterThan(opened ?? 0)
      })))

    // On a fleet machine the session is fixed at 8 hours; a person's own device slides up to 7 days.
    it.effect("sets an 8-hour cookie on a fleet machine", () =>
      Effect.scoped(Effect.gen(function*() {
        const { route } = yield* fixture
        const login = yield* route({
          listener: "serve",
          method: "POST",
          pathname: "/v1/session/tailscale",
          identity: Effect.succeed({ login: "owner@example.test", nodeId: "node-build", device: undefined })
        })
        expect(login?.setCookie).toContain("Max-Age=28800")
      })))

    // A page from another origin can't log anyone in; WhoIs refusing the caller refuses too.
    it.effect("refuses a cross-origin login, and a caller WhoIs refuses", () =>
      Effect.scoped(Effect.gen(function*() {
        const { route } = yield* fixture
        expect(
          (yield* route({
            listener: "serve",
            method: "POST",
            pathname: "/v1/session/tailscale",
            sameOrigin: Effect.fail(new Refused())
          }))?.status
        ).toBe(403)
        expect(
          (yield* route({
            listener: "serve",
            method: "POST",
            pathname: "/v1/session/tailscale",
            identity: Effect.fail(new Refused())
          }))?.status
        ).toBe(403)
      })))

    // `herdr-hub login`: the CLI token mints a code; the page spends it for a session in its own cookie. Every
    // local server could see that cookie, but each is the user's own process, which could run the login too.
    it.effect("trades a CLI-minted code for a local session in an HttpOnly cookie, never in the body", () =>
      Effect.scoped(Effect.gen(function*() {
        const { route } = yield* fixture
        expect((yield* route({ listener: "local", method: "POST", pathname: "/v1/session/local-code" }))?.status)
          .toBe(403)
        const minted = yield* route({
          listener: "local",
          method: "POST",
          pathname: "/v1/session/local-code",
          cli: true
        })
        const code = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(minted?.body).code
        // A browser page can't mint one: it would carry an Origin.
        expect(
          (yield* route({
            listener: "local",
            method: "POST",
            pathname: "/v1/session/local-code",
            cli: true,
            origin: "http://127.0.0.1:4778"
          }))?.status
        ).toBe(403)
        const spent = yield* route({
          listener: "local",
          method: "POST",
          pathname: "/v1/session/local",
          body: Effect.succeed({ code })
        })
        expect(spent?.status).toBe(200)
        expect(spent?.setCookie).toMatch(
          new RegExp(
            `^${localSessionCookieName}=[A-Za-z0-9_-]+; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800$`,
            "u"
          )
        )
        expect(spent?.body).not.toHaveProperty("token")
        const token = cookieValue(spent?.setCookie) ?? ""
        expect(
          (yield* route({
            listener: "local",
            method: "POST",
            pathname: "/v1/session/local",
            body: Effect.succeed({ code })
          }))?.status
        ).toBe(401)
        const read = yield* route({ listener: "local", method: "GET", pathname: "/v1/session", cookieToken: token })
        expect(read?.body).toMatchObject({ signedIn: true, kind: "local" })
        const out = yield* route({
          listener: "local",
          method: "POST",
          pathname: "/v1/session/logout",
          cookieToken: token,
          csrf: Redacted.value(yield* csrfFor(token))
        })
        expect(out?.setCookie).toBe(`${localSessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
      })))

    // Loopback naming a login is no one (any local process can set the header), so it neither gets nor
    // spends a login code.
    it.effect("refuses the loopback login routes to a request naming a login", () =>
      Effect.scoped(Effect.gen(function*() {
        const { route } = yield* fixture
        for (const pathname of ["/v1/session/local-code", "/v1/session/local"]) {
          expect(
            (yield* route({
              listener: "local",
              method: "POST",
              pathname,
              cli: true,
              headerLogin: "owner@example.test"
            }))?.status
          ).toBe(403)
        }
      })))

    // The code exchange exists on the loopback listener only; the Tailscale login on the tailnet one only.
    it.effect("answers 404 for a login route on the wrong listener, and on listeners without sessions", () =>
      Effect.scoped(Effect.gen(function*() {
        const { route } = yield* fixture
        for (const pathname of ["/v1/session/local-code", "/v1/session/local"]) {
          expect((yield* route({ listener: "serve", method: "POST", pathname, cli: true }))?.status).toBe(404)
        }
        expect((yield* route({ listener: "local", method: "POST", pathname: "/v1/session/tailscale" }))?.status)
          .toBe(404)
        const listeners: ReadonlyArray<SessionRequest["listener"]> = ["tailnet", "approval", "work", "lan"]
        for (const listener of listeners) {
          expect((yield* route({ listener, method: "GET", pathname: "/v1/session" }))?.status).toBe(404)
        }
        expect(yield* route({ listener: "serve", method: "GET", pathname: "/v1/dashboard" })).toBeNull()
      })))

    // Logging out is a write: it needs the session's CSRF token, and clears the cookie.
    it.effect("logs out only with the session's CSRF token, clearing the cookie", () =>
      Effect.scoped(Effect.gen(function*() {
        const { route, sessions } = yield* fixture
        const login = yield* route({ listener: "serve", method: "POST", pathname: "/v1/session/tailscale" })
        const token = cookieValue(login?.setCookie) ?? ""
        expect(
          (yield* route({
            listener: "serve",
            method: "POST",
            pathname: "/v1/session/logout",
            cookieToken: token
          }))?.status
        ).toBe(403)
        const out = yield* route({
          listener: "serve",
          method: "POST",
          pathname: "/v1/session/logout",
          cookieToken: token,
          csrf: Redacted.value(yield* csrfFor(token))
        })
        expect(out?.status).toBe(200)
        expect(out?.setCookie).toBe(`${sessionCookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`)
        expect(yield* sessions.read(token)).toBeNull()
      })))
  })

  // A cookie named twice is ambiguous (another service may have planted one): it counts as absent.
  it("reads one cookie by name, and none when it is missing or named twice", () => {
    expect(readCookie("a=1; __Host-herdr_session=abc; b=2", sessionCookieName)).toBe("abc")
    expect(readCookie(undefined, sessionCookieName)).toBeUndefined()
    expect(readCookie("__Host-herdr_session=x; __Host-herdr_session=y", sessionCookieName)).toBeUndefined()
    expect(readCookie("herdr_session=x", sessionCookieName)).toBeUndefined()
  })
})
