import { describe, expect, it } from "@effect/vitest"
import type { Principal } from "@knpkv/herdr-fleet"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { callerNeeded, gateVerdict, isDocument } from "../src/internal/access-gate.js"
import { routeFamily } from "../src/internal/route-families.js"
import { servedRoutes } from "./fixtures/served-routes.js"

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
/** The same caller logged in, as `principalAfterLogin` reads it: a person or the local user gains a session. */
const loggedIn = (principal: Principal): Principal | null =>
  principal._tag === "Person" || principal._tag === "Local" ? { ...principal, session: true } : null
const verdict = (
  principal: Principal,
  method: string,
  pathname: string,
  csrfOk = true,
  options: { readonly afterLogin?: Principal | null; readonly document?: boolean } = {}
) => {
  const family = routeFamily(method, pathname)
  return gateVerdict(config, {
    method,
    family,
    principal,
    afterLogin: options.afterLogin === undefined ? loggedIn(principal) : options.afterLogin,
    document: options.document ?? isDocument(family, method, { fetchDest: undefined, accept: undefined }),
    csrfOk
  })._tag
}

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

  // Every family but the session routes, static files and an app's per-request grant refuses a browser
  // without a session, so a new family can't serve one by forgetting the gate.
  it("refuses a person and the local user without a session on every family that checks its caller", () => {
    const opens = new Set(["static", "session", "app-services"])
    for (const [method, pathname, id] of servedRoutes) {
      for (const principal of [person(false), { _tag: "Local", session: false } satisfies Principal]) {
        const answer = verdict(principal, method, pathname, false)
        expect([id, principal._tag, answer]).toEqual([
          id,
          principal._tag,
          opens.has(id) ? "Pass" : expect.not.stringMatching(/^Pass$/u)
        ])
      }
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

  // A browser on a fleet host is the host's agents until someone logs in there: the host reads JSON as
  // itself, but a page (or an app's page, navigated to) shows only after the login, and a person's write asks
  // for one rather than refusing.
  it("asks a browser on a fleet host to log in for a page, and for what only a person holds", () => {
    const fleetHost: Principal = { _tag: "Host", nodeId: "node-hub" }
    const there: Principal = {
      _tag: "Person",
      login: "owner@example.test",
      nodeId: "node-hub",
      presence: "none",
      session: true
    }
    const atHost = (method: string, pathname: string, document?: boolean) =>
      verdict(
        fleetHost,
        method,
        pathname,
        false,
        document === undefined ? { afterLogin: there } : { afterLogin: there, document }
      )
    expect(atHost("GET", "/")).toBe("LoginRequired")
    expect(atHost("GET", "/fleet")).toBe("LoginRequired")
    expect(atHost("GET", "/apps/notes/", true)).toBe("LoginRequired")
    expect(atHost("POST", "/v1/push/subscriptions")).toBe("LoginRequired")
    expect(atHost("GET", "/v1/dashboard")).toBe("Pass")
    expect(atHost("GET", "/apps/notes/", false)).toBe("Pass")
    expect(atHost("POST", "/v1/jobs")).toBe("Pass")
    // A login no one there may hold doesn't help.
    expect(verdict(fleetHost, "GET", "/", false, { afterLogin: fleetHost })).toBe("Forbidden")
  })

  // An app's page a browser navigates to shows the login gate; its scripts' fetches get the JSON 401.
  it("counts an app's page as a document only when a browser navigates to it", () => {
    const apps = routeFamily("GET", "/apps/notes/")
    expect(isDocument(apps, "GET", { fetchDest: "document", accept: undefined })).toBe(true)
    expect(isDocument(apps, "GET", { fetchDest: undefined, accept: "text/html,application/xhtml+xml" })).toBe(true)
    expect(isDocument(apps, "GET", { fetchDest: "empty", accept: "application/json" })).toBe(false)
    expect(isDocument(routeFamily("POST", "/apps/notes/save"), "POST", { fetchDest: "document", accept: "text/html" }))
      .toBe(false)
    expect(isDocument(routeFamily("GET", "/"), "GET", { fetchDest: undefined, accept: undefined })).toBe(true)
    expect(isDocument(routeFamily("GET", "/v1/dashboard"), "GET", { fetchDest: "document", accept: "text/html" }))
      .toBe(false)
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
