import { describe, expect, it } from "@effect/vitest"
import type { Principal } from "@knpkv/herdr-fleet"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { routeFamily } from "../src/internal/route-families.js"
import { csrfFinding, makeRecentLookup, makeShadowLog, shadowFinding } from "../src/internal/shadow-access.js"

const host = Schema.decodeUnknownSync(FleetHostName)("atlas")
const config = {
  allowedUsers: ["owner@example.test"],
  approvalNodes: ["node-phone"],
  machines: [{ host, nodeId: "node-hub" }]
}
const fleetHost: Principal = { _tag: "Host", nodeId: "node-hub" }
const laptop: Principal = {
  _tag: "Person",
  login: "owner@example.test",
  nodeId: "node-laptop",
  presence: "none",
  session: true
}
const finding = (principal: Principal | null, method: string, pathname: string, status = 200) =>
  shadowFinding(config, { listener: "serve", method, pathname, status, principal })

describe("shadow access", () => {
  // Today's handler served it, identity would refuse it: that is what the flip changes, so it is logged.
  it("reports a request today's checks served and identity would refuse, keyed by principal and family", () => {
    expect(finding(fleetHost, "POST", "/v1/push/subscriptions")).toEqual({
      kind: "refused",
      key: "refused serve Host push.write",
      fields: { listener: "serve", principal: "Host", family: "push.write", requirement: "push" }
    })
    expect(finding(laptop, "POST", "/v1/jobs/job-1/approve")?.key).toBe("refused serve Person+session jobs.decide")
    expect(finding({ ...laptop, session: false }, "POST", "/v1/push/subscriptions")?.key).toBe(
      "refused serve Person push.write"
    )
    // An accepted WebSocket upgrade is a served request too.
    expect(finding(fleetHost, "GET", "/v1/connect/session", 101)?.key).toBe("refused serve Host connect.terminal")
  })

  // Nothing to report when both agree, when today's checks already refused, or for public files.
  it("reports nothing when identity agrees, today already refused, or the route is public", () => {
    expect(finding(laptop, "POST", "/v1/push/subscriptions")).toBeNull()
    expect(finding(fleetHost, "POST", "/v1/push/subscriptions", 403)).toBeNull()
    expect(finding({ _tag: "Anonymous" }, "GET", "/assets/index.css")).toBeNull()
    expect(finding(null, "POST", "/v1/push/subscriptions")).toBeNull()
  })

  // A served route no family names is reported once per method and leading path, so identifiers in the path
  // don't make a new line each time. A refused one is junk anyone could send, so it is not.
  it("reports a served route no family names by its method and leading path, and ignores refused ones", () => {
    expect(finding(laptop, "GET", "/v1/something-new/item-1")).toEqual({
      kind: "undeclared",
      key: "undeclared serve GET /v1/something-new",
      fields: { listener: "serve", method: "GET", path: "/v1/something-new" }
    })
    expect(finding(laptop, "GET", "/v1/something-new/item-1", 404)).toBeNull()
  })

  // Junk can't crowd out what the flip needs: each kind has its own cap, and a refused finding still logs
  // after the undeclared cap is used up.
  it.effect("logs each finding once, under a separate cap per kind", () =>
    Effect.gen(function*() {
      const shadow = makeShadowLog(config)
      for (let index = 0; index < 100; index++) {
        const undeclared = finding(laptop, "GET", `/junk-${String(index)}/item`)
        if (undeclared !== null) yield* shadow.log(undeclared)
      }
      const refused = finding(fleetHost, "POST", "/v1/push/subscriptions")
      if (refused === null) return yield* Effect.die("expected a refused finding")
      const family = routeFamily("POST", "/v1/push/subscriptions")
      if (family === null) return yield* Effect.die("expected a family")
      expect(shadow.settled("serve", family)).toBe(false)
      yield* shadow.log(refused)
      // Host, Service and a person without a session can be refused push; a logged-in owner holds it.
      const others: ReadonlyArray<Principal> = [{ _tag: "Service", nodeId: "node-hub" }, { ...laptop, session: false }]
      for (const principal of others) {
        expect(shadow.settled("serve", family)).toBe(false)
        const next = finding(principal, "POST", "/v1/push/subscriptions")
        if (next === null) return yield* Effect.die("expected a refused finding")
        yield* shadow.log(next)
      }
      expect(shadow.settled("serve", family)).toBe(true)
    }))

  // Loopback naming a login is no one, and that is the case worth seeing: a plain loopback finding doesn't
  // settle the family until the CLI and no-one findings are logged too. A local session holds jobs.submit.
  it.effect("keeps reading loopback callers until the local user, the CLI and no one are all logged", () =>
    Effect.gen(function*() {
      const shadow = makeShadowLog(config)
      const family = routeFamily("POST", "/v1/jobs")
      if (family === null) return yield* Effect.die("expected a family")
      const local = (principal: Principal) =>
        shadowFinding(config, { listener: "local", method: "POST", pathname: "/v1/jobs", status: 202, principal })
      const plain = local({ _tag: "Local", session: false })
      const cli = local({ _tag: "Cli" })
      const named = local({ _tag: "Anonymous" })
      if (plain === null || cli === null || named === null) return yield* Effect.die("expected refused findings")
      yield* shadow.log(plain)
      expect(shadow.settled("local", family)).toBe(false)
      yield* shadow.log(cli)
      expect(shadow.settled("local", family)).toBe(false)
      yield* shadow.log(named)
      expect(named.key).toBe("refused local Anonymous jobs.submit")
      expect(shadow.settled("local", family)).toBe(true)
    }))

  // A session's writes carry its CSRF token from 3b on; a served write without it is named now.
  it.effect("names a session's write that came without its CSRF token, and nothing else", () =>
    Effect.gen(function*() {
      const family = routeFamily("POST", "/v1/push/subscriptions")
      const page = routeFamily("GET", "/")
      if (family === null || page === null) return yield* Effect.die("expected families")
      const write = (principal: Principal, csrfOk: boolean, method = "POST") =>
        csrfFinding({ listener: "serve", method, family: method === "GET" ? page : family, principal, csrfOk })
      expect(write(laptop, false)?.key).toBe("unprotected serve Person+session push.write")
      expect(write({ _tag: "Local", session: true }, false)?.key).toBe("unprotected serve Local+session push.write")
      expect(write(laptop, true)).toBeNull()
      expect(write(laptop, false, "GET")).toBeNull()
      expect(write({ ...laptop, session: false }, false)).toBeNull()
      expect(write(fleetHost, false)).toBeNull()
    }))

  // An address WhoIs can't answer would otherwise spawn a lookup on every request.
  it.effect("remembers a failed lookup for the same window", () =>
    Effect.gen(function*() {
      let asked = 0
      const lookup = makeRecentLookup(
        (_key: string) => Effect.sync(() => asked++).pipe(Effect.andThen(Effect.fail("unanswered"))),
        { ttlMillis: 30_000, limit: 2 }
      )
      expect(yield* Effect.flip(lookup("a"))).toBe("unanswered")
      expect(yield* Effect.flip(lookup("a"))).toBe("unanswered")
      expect(asked).toBe(1)
      yield* TestClock.adjust("31 seconds")
      yield* Effect.flip(lookup("a"))
      expect(asked).toBe(2)
    }))

  // A WhoIs is a child process: the same address within the window reuses the last answer.
  it.effect("reuses a lookup for the same key within its window, and looks again after it", () =>
    Effect.gen(function*() {
      const asked: Array<string> = []
      const lookup = makeRecentLookup(
        (key: string) => Effect.sync(() => asked.push(key)).pipe(Effect.as(`answer-${key}`)),
        { ttlMillis: 30_000, limit: 2 }
      )
      expect(yield* lookup("a")).toBe("answer-a")
      expect(yield* lookup("a")).toBe("answer-a")
      expect(asked).toEqual(["a"])
      yield* TestClock.adjust("31 seconds")
      yield* lookup("a")
      expect(asked).toEqual(["a", "a"])
      // Past the limit the oldest key is forgotten.
      yield* lookup("b")
      yield* lookup("c")
      yield* lookup("a")
      expect(asked).toEqual(["a", "a", "b", "c", "a"])
    }))
})
