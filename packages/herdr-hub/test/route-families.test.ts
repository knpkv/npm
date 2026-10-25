import { describe, expect, it } from "@effect/vitest"
import type { Principal } from "@knpkv/herdr-fleet"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { meets, routeFamily } from "../src/internal/route-families.js"

const family = (method: string, pathname: string) => routeFamily(method, pathname)?.id ?? null

describe("route families", () => {
  // Each request the hub serves names one family, and each family says what its caller must be.
  it("names the family of each route the hub serves", () => {
    expect([
      family("GET", "/assets/index.css"),
      family("GET", "/manifest.webmanifest"),
      family("GET", "/"),
      family("GET", "/connect/"),
      family("GET", "/v1/dashboard"),
      family("GET", "/v1/jobs/job-1"),
      family("POST", "/v1/jobs"),
      family("POST", "/v1/jobs/job-1/approve"),
      family("POST", "/v1/jobs/job-1/reject"),
      family("GET", "/v1/work/recovery-context"),
      family("POST", "/v1/work/pull-request-link"),
      family("GET", "/v1/push/config"),
      family("POST", "/v1/push/subscriptions"),
      family("GET", "/v1/connect/agents/local"),
      family("GET", "/v1/connect/terminal"),
      family("GET", "/v1/connect/session"),
      family("POST", "/v1/connect/posts"),
      family("POST", "/v1/connect/me"),
      family("GET", "/v1/connect/posts"),
      family("GET", "/v1/host/resources"),
      family("GET", "/v1/modules/sandboxes/overview"),
      family("POST", "/v1/modules/sandboxes/jobs"),
      family("POST", "/v1/modules/code/review"),
      family("POST", "/v1/modules/fleet/failures/dismiss"),
      family("POST", "/v1/modules/fleet/failures/retry"),
      family("GET", "/v1/modules/fleet/failures/retry"),
      family("GET", "/v1/apps"),
      family("POST", "/v1/apps/notes/restart"),
      family("POST", "/apps/notes/save"),
      family("GET", "/v1/app-services/fleet/read"),
      family("POST", "/v1/relay/decisions"),
      family("GET", "/v1/relay/events"),
      family("POST", "/v1/relay/messages"),
      family("GET", "/v1/session"),
      family("POST", "/v1/session/tailscale")
    ]).toEqual([
      "static",
      "static",
      "page",
      "page",
      "dashboard",
      "dashboard",
      "jobs.submit",
      "jobs.decide",
      "jobs.decide",
      "work.read",
      "work.write",
      "push.read",
      "push.write",
      "connect.service",
      "connect.service",
      "connect.terminal",
      "connect.report",
      "connect.report",
      "connect.read",
      "connect.read",
      "modules.read",
      "modules.sandboxes",
      "modules.write",
      "fleet.failures.dismiss",
      "fleet.failures.retry",
      null,
      "apps.read",
      "apps.restart",
      "apps.write",
      "app-services",
      "relay.decide",
      "relay.read",
      "relay.write",
      "session",
      "session"
    ])
  })

  // A route no family names is reported, not guessed: the shadow log counts it.
  it("names no family for a route it does not know", () => {
    expect(family("GET", "/v1/something-new")).toBeNull()
    expect(family("DELETE", "/v1/jobs")).toBeNull()
  })
})

const host = Schema.decodeUnknownSync(FleetHostName)("atlas")
const config = {
  allowedUsers: ["owner@example.test"],
  approvalNodes: ["node-phone"],
  machines: [{ host, nodeId: "node-hub" }]
}
const person = (nodeId: string): Principal => ({
  _tag: "Person",
  login: "owner@example.test",
  nodeId,
  presence: "none",
  session: true
})
const fleetHost: Principal = { _tag: "Host", nodeId: "node-hub" }
const service: Principal = { _tag: "Service", nodeId: "node-hub" }
const plainLoopback: Principal = { _tag: "Local", session: false }
const requirementOf = (method: string, pathname: string) => {
  const found = routeFamily(method, pathname)
  if (found === null) throw new Error(`no family for ${method} ${pathname}`)
  return found.requirement
}
const allowed = (principal: Principal, method: string, pathname: string) =>
  meets(config, principal, requirementOf(method, pathname))

describe("meets", () => {
  // What the flip will enforce: hosts read, submit and report as themselves; people act; only the hub
  // calls a peer's service routes; plain loopback only reads.
  it("says which principal each family admits", () => {
    expect(allowed(fleetHost, "POST", "/v1/connect/posts")).toBe(true)
    expect(allowed(person("node-phone"), "POST", "/v1/connect/posts")).toBe(false)
    expect(allowed(fleetHost, "POST", "/v1/jobs")).toBe(true)
    expect(allowed(fleetHost, "POST", "/v1/push/subscriptions")).toBe(false)
    expect(allowed(fleetHost, "POST", "/v1/modules/sandboxes/jobs")).toBe(false)
    expect(allowed(person("node-laptop"), "POST", "/v1/modules/sandboxes/jobs")).toBe(true)
    expect(allowed(person("node-laptop"), "POST", "/v1/jobs/job-1/approve")).toBe(false)
    expect(allowed(person("node-phone"), "POST", "/v1/jobs/job-1/approve")).toBe(true)
    expect(allowed(person("node-laptop"), "POST", "/v1/work/pull-request-link")).toBe(true)
    expect(allowed(fleetHost, "POST", "/v1/work/pull-request-link")).toBe(false)
    expect(allowed(service, "GET", "/v1/connect/agents/local")).toBe(true)
    expect(allowed(fleetHost, "GET", "/v1/connect/agents/local")).toBe(false)
    expect(allowed(plainLoopback, "GET", "/v1/dashboard")).toBe(true)
    expect(allowed(plainLoopback, "POST", "/v1/jobs")).toBe(false)
    expect(allowed({ _tag: "Anonymous" }, "GET", "/assets/index.css")).toBe(true)
    expect(allowed({ _tag: "Anonymous" }, "GET", "/v1/dashboard")).toBe(false)
  })
})
