import { describe, expect, it } from "@effect/vitest"
import type { Principal } from "@knpkv/herdr-fleet"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { meets, routeFamily } from "../src/internal/route-families.js"
import { servedRoutes } from "./fixtures/served-routes.js"

const family = (method: string, pathname: string) => routeFamily(method, pathname)?.id ?? null

describe("route families", () => {
  // Each request the hub serves names one family, and each family says what its caller must be.
  it("names the family of each route the hub serves", () => {
    expect(servedRoutes.map(([method, pathname]) => family(method, pathname))).toEqual(
      servedRoutes.map(([, , id]) => id)
    )
    expect(family("GET", "/v1/modules/fleet/failures/retry")).toBeNull()
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
  // calls a peer's service routes; plain loopback gets nothing, the CLI reads and submits.
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
    expect(allowed(plainLoopback, "GET", "/v1/dashboard")).toBe(false)
    expect(allowed(plainLoopback, "POST", "/v1/jobs")).toBe(false)
    expect(allowed({ _tag: "Cli" }, "GET", "/v1/dashboard")).toBe(true)
    expect(allowed({ _tag: "Cli" }, "POST", "/v1/jobs")).toBe(true)
    expect(allowed({ _tag: "Anonymous" }, "GET", "/assets/index.css")).toBe(true)
    expect(allowed({ _tag: "Anonymous" }, "GET", "/v1/dashboard")).toBe(false)
  })
})
