import { describe, expect, it } from "@effect/vitest"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import type { OpenSession } from "../src/internal/person-sessions.js"
import { grantsFor, principalFor } from "../src/internal/principal.js"

const host = Schema.decodeUnknownSync(FleetHostName)("atlas")
const other = Schema.decodeUnknownSync(FleetHostName)("cedar")

/** The hub "atlas" and one more fleet host "cedar"; the owner's phone and laptop are not fleet hosts. */
const config = {
  approvalHub: { nodeId: "node-hub" },
  allowedUsers: ["owner@example.test"],
  approvalNodes: ["node-phone"],
  machines: [{ host, nodeId: "node-hub" }, { host: other, nodeId: "node-cedar" }]
}
const tailscaleSession = (nodeId: string, login = "owner@example.test"): OpenSession => ({
  kind: "tailscale",
  login,
  nodeId,
  sliding: true,
  expiresAt: 1
})
const localSession: OpenSession = { kind: "local", expiresAt: 1 }
const tailnet = (
  nodeId: string,
  options: { readonly login?: string; readonly serviceRoute?: boolean; readonly session?: OpenSession | null } = {}
) =>
  principalFor(config, {
    _tag: "Tailnet",
    login: options.login ?? "owner@example.test",
    nodeId,
    serviceRoute: options.serviceRoute ?? false,
    session: options.session ?? null
  })
const loopback = (
  remoteAddress: string,
  headerLogin: string | undefined,
  options: { readonly cli?: boolean; readonly session?: OpenSession | null } = {}
) =>
  principalFor(config, {
    _tag: "Loopback",
    remoteAddress,
    headerLogin,
    cli: options.cli ?? false,
    session: options.session ?? null
  })
const person = (nodeId: string, session: boolean) => ({
  _tag: "Person",
  login: "owner@example.test",
  nodeId,
  presence: "none",
  session
})

describe("principalFor", () => {
  // Agents run on fleet hosts under the owner's login, so a fleet host's node is a Host until someone logs
  // in in a browser there, the hub's own node included. Any other node under an allowed login is a person,
  // logged in or not.
  it("makes a fleet-host node a Host until a session bound there, and any other allowed node a Person", () => {
    expect(tailnet("node-hub")).toEqual({ _tag: "Host", nodeId: "node-hub" })
    expect(tailnet("node-cedar")).toEqual({ _tag: "Host", nodeId: "node-cedar" })
    expect(tailnet("node-cedar", { session: tailscaleSession("node-cedar") })).toEqual(person("node-cedar", true))
    expect(tailnet("node-phone")).toEqual(person("node-phone", false))
    expect(tailnet("node-phone", { session: tailscaleSession("node-phone") })).toEqual(person("node-phone", true))
    expect(tailnet("node-laptop", { login: "stranger@example.test" })).toEqual({ _tag: "Anonymous" })
  })

  // A session counts only where it was opened, for the login that opened it: a cookie carried to another
  // node, or presented under another login, is ignored.
  it("ignores a session bound to another node or login, and a local session over the tailnet", () => {
    expect(tailnet("node-cedar", { session: tailscaleSession("node-phone") })).toEqual({
      _tag: "Host",
      nodeId: "node-cedar"
    })
    expect(tailnet("node-phone", { session: tailscaleSession("node-laptop") })).toEqual(person("node-phone", false))
    expect(tailnet("node-phone", { session: tailscaleSession("node-phone", "other@example.test") })).toEqual(
      person("node-phone", false)
    )
    expect(tailnet("node-phone", { session: localSession })).toEqual(person("node-phone", false))
  })

  // A peer's per-host routes admit the hub's node as the hub calling for the fleet; everywhere else that
  // node is a fleet host like any other, and no other node is ever a service.
  it("makes the hub's node a Service on a peer's service routes only, and no other node one", () => {
    expect(tailnet("node-hub", { serviceRoute: true })).toEqual({ _tag: "Service", nodeId: "node-hub" })
    expect(tailnet("node-hub")).toEqual({ _tag: "Host", nodeId: "node-hub" })
    expect(tailnet("node-cedar", { serviceRoute: true })).toEqual({ _tag: "Host", nodeId: "node-cedar" })
    expect(tailnet("node-phone", { serviceRoute: true })._tag).toBe("Person")
  })

  // Presence comes only from a verified passkey assertion, which no listener input carries.
  it("never makes a principal present from what a listener knows", () => {
    for (const nodeId of ["node-hub", "node-cedar", "node-phone", "node-laptop"]) {
      for (const serviceRoute of [false, true]) {
        for (const session of [null, tailscaleSession(nodeId)]) {
          const principal = tailnet(nodeId, { serviceRoute, session })
          expect(principal._tag === "Person" ? principal.presence : "none").toBe("none")
        }
      }
    }
  })

  // Any process on the hub's computer can reach loopback and set any header, so a login header there names
  // no one. The CLI token makes it the CLI; the local login makes it the local user with a session.
  it("tells plain loopback, the CLI and a local session apart, and makes loopback naming a login no one", () => {
    expect(loopback("127.0.0.1", undefined)).toEqual({ _tag: "Local", session: false })
    expect(loopback("::1", undefined)).toEqual({ _tag: "Local", session: false })
    expect(loopback("::ffff:127.0.0.1", undefined)).toEqual({ _tag: "Local", session: false })
    expect(loopback("127.0.0.1", undefined, { session: localSession })).toEqual({ _tag: "Local", session: true })
    expect(loopback("127.0.0.1", undefined, { session: tailscaleSession("node-hub") })).toEqual({
      _tag: "Local",
      session: false
    })
    expect(loopback("127.0.0.1", undefined, { cli: true })).toEqual({ _tag: "Cli" })
    expect(loopback("127.0.0.1", "owner@example.test")).toEqual({ _tag: "Anonymous" })
    expect(loopback("127.0.0.1", "forged@example.test", { cli: true, session: localSession })).toEqual({
      _tag: "Anonymous"
    })
    expect(loopback("100.64.0.7", undefined, { cli: true })).toEqual({ _tag: "Anonymous" })
  })
})

describe("grantsFor", () => {
  // What each principal may do under the migrated config: no users map, so allowed logins hold everything.
  it("lists what each principal may do, in display order", () => {
    expect(grantsFor(config, tailnet("node-hub"))).toEqual(["view", "jobs.submit"])
    expect(grantsFor(config, tailnet("node-laptop"))).toEqual([])
    expect(grantsFor(config, tailnet("node-laptop", { session: tailscaleSession("node-laptop") })))
      .toEqual(["view", "jobs.submit", "sandboxes.owner", "push", "connect.terminal", "apps.restart"])
    expect(grantsFor(config, tailnet("node-cedar", { session: tailscaleSession("node-cedar") })))
      .toEqual(["view", "jobs.submit", "push", "connect.terminal", "apps.restart"])
    expect(grantsFor(config, loopback("127.0.0.1", undefined))).toEqual([])
    expect(grantsFor(config, loopback("127.0.0.1", undefined, { cli: true }))).toEqual([
      "view",
      "jobs.submit",
      "apps.restart"
    ])
  })
})
