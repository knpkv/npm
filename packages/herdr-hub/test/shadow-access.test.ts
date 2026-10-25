import { describe, expect, it } from "@effect/vitest"
import type { Principal } from "@knpkv/herdr-fleet"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { routeFamily } from "../src/internal/route-families.js"
import { makeRecentLookup, makeShadowLog, shadowFinding } from "../src/internal/shadow-access.js"

const host = Schema.decodeUnknownSync(FleetHostName)("atlas")
const config = {
  allowedUsers: ["owner@example.test"],
  approvalNodes: ["node-phone"],
  machines: [{ host, nodeId: "node-hub" }]
}
const fleetHost: Principal = { _tag: "Host", nodeId: "node-hub" }
const laptop: Principal = { _tag: "Person", login: "owner@example.test", nodeId: "node-laptop", presence: "none" }
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
    expect(finding(laptop, "POST", "/v1/jobs/job-1/approve")?.key).toBe("refused serve Person jobs.decide")
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
      // Host and Service can be refused push; the owner's login holds it. Service is still unlogged.
      expect(shadow.settled("serve", family)).toBe(false)
      const service = finding({ _tag: "Service", nodeId: "node-hub" }, "POST", "/v1/push/subscriptions")
      if (service === null) return yield* Effect.die("expected a refused service finding")
      yield* shadow.log(service)
      expect(shadow.settled("serve", family)).toBe(true)
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
