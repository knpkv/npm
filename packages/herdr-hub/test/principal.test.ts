import { describe, expect, it } from "@effect/vitest"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
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
const tailnet = (nodeId: string, login = "owner@example.test", serviceRoute = false) =>
  principalFor(config, { _tag: "Tailnet", login, nodeId, serviceRoute })
const loopback = (remoteAddress: string, headerLogin: string | undefined) =>
  principalFor(config, { _tag: "Loopback", remoteAddress, headerLogin })

describe("principalFor", () => {
  // Agents run on fleet hosts under the owner's login, so a fleet host's node is a Host whoever signs in,
  // the hub's own node included. Any other node under an allowed login is a person.
  it("makes every fleet-host node a Host, the hub's own included, and any other allowed node a Person", () => {
    expect(tailnet("node-hub")).toEqual({ _tag: "Host", nodeId: "node-hub" })
    expect(tailnet("node-cedar")).toEqual({ _tag: "Host", nodeId: "node-cedar" })
    expect(tailnet("node-phone")).toEqual({
      _tag: "Person",
      login: "owner@example.test",
      nodeId: "node-phone",
      presence: "none"
    })
    expect(tailnet("node-laptop", "stranger@example.test")).toEqual({ _tag: "Anonymous" })
  })

  // A peer's per-host routes admit the hub's node as the hub calling for the fleet; everywhere else that
  // node is a fleet host like any other, and no other node is ever a service.
  it("makes the hub's node a Service on a peer's service routes only, and no other node one", () => {
    expect(tailnet("node-hub", "owner@example.test", true)).toEqual({ _tag: "Service", nodeId: "node-hub" })
    expect(tailnet("node-hub", "owner@example.test", false)).toEqual({ _tag: "Host", nodeId: "node-hub" })
    expect(tailnet("node-cedar", "owner@example.test", true)).toEqual({ _tag: "Host", nodeId: "node-cedar" })
    expect(tailnet("node-phone", "owner@example.test", true)._tag).toBe("Person")
  })

  // Presence comes only from a verified passkey assertion, which no listener input carries.
  it("never makes a principal present from what a listener knows", () => {
    for (const nodeId of ["node-hub", "node-cedar", "node-phone", "node-laptop"]) {
      for (const serviceRoute of [false, true]) {
        const principal = tailnet(nodeId, "owner@example.test", serviceRoute)
        expect(principal._tag === "Person" ? principal.presence : "none").toBe("none")
      }
    }
  })

  // Any process on the hub's computer can reach loopback and set any header, so a login header there names
  // no one: the request is no one, never the person it names.
  it("makes plain loopback the local user without a session, and loopback naming a login no one", () => {
    expect(loopback("127.0.0.1", undefined)).toEqual({ _tag: "Local", session: false })
    expect(loopback("::1", undefined)).toEqual({ _tag: "Local", session: false })
    expect(loopback("::ffff:127.0.0.1", undefined)).toEqual({ _tag: "Local", session: false })
    expect(loopback("127.0.0.1", "owner@example.test")).toEqual({ _tag: "Anonymous" })
    expect(loopback("127.0.0.1", "forged@example.test")).toEqual({ _tag: "Anonymous" })
    expect(loopback("100.64.0.7", undefined)).toEqual({ _tag: "Anonymous" })
  })
})

describe("grantsFor", () => {
  // What each principal may do under the migrated config: no users map, so allowed logins hold everything.
  it("lists what each principal may do, in display order", () => {
    expect(grantsFor(config, tailnet("node-hub")))
      .toEqual(["view", "jobs.submit"])
    expect(grantsFor(config, tailnet("node-laptop")))
      .toEqual(["view", "jobs.submit", "sandboxes.owner", "push", "connect.terminal", "apps.restart"])
    expect(
      grantsFor(config, loopback("127.0.0.1", undefined))
    ).toEqual(["view"])
  })
})
