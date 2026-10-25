import { describe, expect, it } from "@effect/vitest"
import type { Principal } from "@knpkv/herdr-fleet"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { callerNeeded, gateVerdict } from "../src/internal/access-gate.js"
import { routeFamily } from "../src/internal/route-families.js"

const host = Schema.decodeUnknownSync(FleetHostName)("hub")
const config = {
  allowedUsers: ["owner@example.test"],
  approvalNodes: ["node-phone"],
  machines: [{ host, nodeId: "node-hub" }]
}
const person = (session: boolean): Principal => ({
  _tag: "Person",
  login: "owner@example.test",
  nodeId: "node-laptop",
  presence: "none",
  session
})
const verdict = (principal: Principal, method: string, pathname: string, csrfOk = true) =>
  gateVerdict(config, { method, family: routeFamily(method, pathname), principal, csrfOk })._tag

describe("access gate", () => {
  // The hub is behind login: a browser without a session reaches only the session routes and static files.
  it("asks a person or the local user without a session to log in, everywhere but the session routes", () => {
    for (const principal of [person(false), { _tag: "Local", session: false } satisfies Principal]) {
      expect(verdict(principal, "GET", "/")).toBe("LoginRequired")
      expect(verdict(principal, "GET", "/v1/dashboard")).toBe("LoginRequired")
      expect(verdict(principal, "GET", "/v1/modules/sandboxes/overview")).toBe("LoginRequired")
      expect(verdict(principal, "POST", "/v1/jobs")).toBe("LoginRequired")
      expect(verdict(principal, "POST", "/v1/relay/messages")).toBe("LoginRequired")
      expect(verdict(principal, "POST", "/v1/work/pull-request-link")).toBe("LoginRequired")
      expect(verdict(principal, "GET", "/v1/session")).toBe("Pass")
      expect(verdict(principal, "POST", "/v1/session/tailscale")).toBe("Pass")
      expect(verdict(principal, "GET", "/assets/index.css")).toBe("Pass")
    }
  })

  // Agents and hosts keep their own credentials: the CLI token on loopback, the host's node on the tailnet.
  it("lets the CLI and fleet hosts on with their own credentials", () => {
    expect(verdict({ _tag: "Cli" }, "POST", "/v1/jobs")).toBe("Pass")
    expect(verdict({ _tag: "Cli" }, "GET", "/v1/jobs/job-1")).toBe("Pass")
    expect(verdict({ _tag: "Cli" }, "POST", "/v1/apps/notes/restart")).toBe("Pass")
    expect(verdict({ _tag: "Host", nodeId: "node-hub" }, "POST", "/v1/jobs")).toBe("Pass")
    expect(verdict({ _tag: "Host", nodeId: "node-hub" }, "POST", "/v1/connect/posts")).toBe("Pass")
  })

  // Logging in doesn't help someone who isn't allowed, or a credential that can't hold the permission.
  it("forbids rather than asks to log in when a login wouldn't help", () => {
    expect(verdict({ _tag: "Anonymous" }, "GET", "/v1/dashboard")).toBe("Forbidden")
    expect(verdict({ _tag: "Cli" }, "POST", "/v1/jobs/job-1/approve")).toBe("Forbidden")
    expect(verdict({ _tag: "Host", nodeId: "node-hub" }, "POST", "/v1/modules/sandboxes/jobs")).toBe("Forbidden")
    expect(verdict(person(true), "POST", "/v1/jobs/job-1/approve")).toBe("Forbidden")
    // Only a fleet host reports as an agent; a session wouldn't make the local user one.
    expect(verdict({ _tag: "Local", session: false }, "POST", "/v1/connect/posts")).toBe("Forbidden")
    expect(verdict(person(false), "POST", "/v1/jobs/job-1/approve")).toBe("Forbidden")
  })

  // A session's writes carry its CSRF token; reads and the session routes don't need it.
  it("refuses a session's write without its CSRF token", () => {
    expect(verdict(person(true), "POST", "/v1/push/subscriptions", false)).toBe("CsrfRequired")
    expect(verdict(person(true), "POST", "/v1/push/subscriptions", true)).toBe("Pass")
    expect(verdict(person(true), "GET", "/v1/dashboard", false)).toBe("Pass")
    expect(verdict(person(true), "POST", "/v1/session/logout", false)).toBe("Pass")
    expect(verdict({ _tag: "Cli" }, "POST", "/v1/jobs", false)).toBe("Pass")
  })

  // A route no family names is refused, so a new route can't slip past the gate.
  it("refuses a route no family names", () => {
    expect(verdict(person(true), "GET", "/v2/anything")).toBe("Unknown")
    expect(verdict({ _tag: "Cli" }, "DELETE", "/v1/jobs")).toBe("Unknown")
  })

  // Reading the caller costs a session read and, on the tailnet, a WhoIs: skipped where no one is checked.
  it("needs the caller only for families that check one", () => {
    expect(callerNeeded(routeFamily("GET", "/assets/index.css"))).toBe(false)
    expect(callerNeeded(routeFamily("GET", "/v1/session"))).toBe(false)
    expect(callerNeeded(routeFamily("POST", "/v1/app-services/fleet/read"))).toBe(false)
    expect(callerNeeded(routeFamily("GET", "/v1/dashboard"))).toBe(true)
    expect(callerNeeded(null)).toBe(false)
  })
})
