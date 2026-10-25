import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { HostConfiguration } from "../src/model.js"
import { can, grantsOf, type Permission, permissions, type Principal, unknownPermissions } from "../src/permissions.js"

const identity = Schema.Struct({
  allowedUsers: HostConfiguration.fields.allowedUsers,
  approvalNodes: HostConfiguration.fields.approvalNodes,
  users: HostConfiguration.fields.users,
  hosts: HostConfiguration.fields.hosts,
  local: HostConfiguration.fields.local,
  machines: HostConfiguration.fields.machines
})
/** The approval node is the owner's phone; "node-build" is a fleet machine. */
const configOf = (input: Omit<typeof identity.Encoded, "approvalNodes" | "machines">) =>
  Schema.decodeSync(identity)({
    approvalNodes: ["node-phone"],
    machines: [{ host: "build", nodeId: "node-build" }],
    ...input
  })

/** A signed-in person on the approval node, no passkey: every grant counts, approve included. */
const person = (login: string): Principal => ({
  _tag: "Person",
  login,
  nodeId: "node-phone",
  presence: "none",
  session: true
})
const ownerSide: ReadonlyArray<Permission> = ["view", "jobs.submit", "push", "connect.terminal", "apps.restart"]
const all = (principal: Principal, config: ReturnType<typeof configOf>) =>
  permissions.filter((permission) => can(config, principal, permission))

describe("permissions", () => {
  // An older config names only allowedUsers: each of those logins keeps everything it could do.
  it("gives every allowed login every permission while users is absent", () => {
    const config = configOf({ allowedUsers: ["owner@example.test"] })
    expect(all(person("owner@example.test"), config)).toEqual(permissions)
    expect(all(person("other@example.test"), config)).toEqual([])
  })

  it("gives a person exactly what users grants, and allowedUsers no longer adds anything", () => {
    const config = configOf({
      allowedUsers: ["owner@example.test", "teammate@example.test"],
      users: { "owner@example.test": ["view", "jobs.submit", "approve"] }
    })
    expect(all(person("owner@example.test"), config)).toEqual(["view", "jobs.submit", "approve"])
    expect(all(person("teammate@example.test"), config)).toEqual([])
  })

  // WhoIs admits only allowedUsers, so a users entry for any other login grants nothing.
  it("ignores a users entry for a login that is not in allowedUsers", () => {
    const config = configOf({ allowedUsers: ["owner@example.test"], users: { "other@example.test": ["view"] } })
    expect(all(person("other@example.test"), config)).toEqual([])
  })

  // users is a plain record, so a login named like an Object member must not read the prototype.
  it("gives an allowed login with no users entry nothing, even one named like an Object member", () => {
    const config = configOf({ allowedUsers: ["constructor", "toString"], users: {} })
    expect(all(person("constructor"), config)).toEqual([])
    expect(all(person("toString"), config)).toEqual([])
  })

  // Until a passkey proves the person is present, approving stays tied to the approval nodes, as today.
  it("lets a person approve only from an approval node, or with a passkey from any node", () => {
    const config = configOf({ allowedUsers: ["owner@example.test"] })
    const on = (nodeId: string, presence: "none" | "passkey"): Principal => ({
      _tag: "Person",
      login: "owner@example.test",
      nodeId,
      presence,
      session: true
    })
    expect(can(config, on("node-phone", "none"), "approve")).toBe(true)
    expect(can(config, on("node-laptop", "none"), "approve")).toBe(false)
    expect(can(config, on("node-laptop", "passkey"), "approve")).toBe(true)
    expect(can(config, on("node-laptop", "none"), "jobs.submit")).toBe(true)
  })

  // Agents run on fleet hosts under the owner's login: a host is never a person and never approves or owns.
  it("lets a host view and submit jobs by default, and never approve or own, whatever hosts says", () => {
    const host: Principal = { _tag: "Host", nodeId: "node-build" }
    expect(all(host, configOf({ allowedUsers: [] }))).toEqual(["view", "jobs.submit"])
    expect(all(host, configOf({ allowedUsers: [], hosts: ["view"] }))).toEqual(["view"])
    expect(all(host, configOf({ allowedUsers: [], hosts: ["view", "approve", "sandboxes.owner"] }))).toEqual(["view"])
  })

  // Plain loopback is any process on the computer: it only views until the local login proves the user.
  // That login proves the same user account, which the hub's own agents share, so it never approves or owns.
  it("lets plain loopback only view, and a local session what local grants, never approve or own", () => {
    const config = configOf({ allowedUsers: [] })
    expect(all({ _tag: "Local", session: false }, config)).toEqual(["view"])
    expect(all({ _tag: "Local", session: true }, config)).toEqual(ownerSide)
    expect(all({ _tag: "Local", session: true }, configOf({ allowedUsers: [], local: ["view", "apps.restart"] })))
      .toEqual(["view", "apps.restart"])
    expect(all({ _tag: "Local", session: true }, configOf({ allowedUsers: [], local: ["approve", "sandboxes.owner"] })))
      .toEqual([])
  })

  // Logging in is the person's deliberate act in a browser: without it a login only views, on any node.
  it("lets a person without a session only view, on any node", () => {
    const config = configOf({ allowedUsers: ["owner@example.test"] })
    for (const nodeId of ["node-phone", "node-laptop", "node-build"]) {
      const unsignedIn: Principal = {
        _tag: "Person",
        login: "owner@example.test",
        nodeId,
        presence: "passkey",
        session: false
      }
      expect(all(unsignedIn, config), nodeId).toEqual(["view"])
    }
  })

  // On a fleet machine a session can't tell the person from the agents beside them, so owning Sandboxes
  // never follows from it; approving still needs an approval node or a passkey.
  it("never lets a person on a fleet machine own Sandboxes, session or not", () => {
    const config = configOf({ allowedUsers: ["owner@example.test"] })
    const onMachine: Principal = {
      _tag: "Person",
      login: "owner@example.test",
      nodeId: "node-build",
      presence: "passkey",
      session: true
    }
    expect(can(config, onMachine, "sandboxes.owner")).toBe(false)
    expect(can(config, onMachine, "approve")).toBe(true)
    expect(can(config, { ...onMachine, presence: "none" }, "approve")).toBe(false)
    expect(can(config, { ...onMachine, nodeId: "node-laptop" }, "sandboxes.owner")).toBe(true)
  })

  // The CLI token is any process of the user, so it restarts apps (nix activation does) and nothing else.
  it("lets the CLI restart apps and nothing else", () => {
    expect(all({ _tag: "Cli" }, configOf({ allowedUsers: ["owner@example.test"] }))).toEqual(["apps.restart"])
  })

  it("gives a service and an anonymous caller nothing", () => {
    const config = configOf({ allowedUsers: ["owner@example.test"] })
    expect(all({ _tag: "Service", nodeId: "node-hub" }, config)).toEqual([])
    expect(all({ _tag: "Anonymous" }, config)).toEqual([])
  })

  // nix pushes one config to hosts that may run an older hub: a permission this hub does not know is
  // reported and ignored, never a decode failure, so the grants it knows still hold.
  it("decodes a permission it does not know, ignores it, and names it", () => {
    const config = configOf({
      allowedUsers: ["owner@example.test"],
      users: { "owner@example.test": ["view", "future.thing"] },
      hosts: ["view", "host.future"],
      local: ["later"]
    })
    expect(all(person("owner@example.test"), config)).toEqual(["view"])
    expect(unknownPermissions(config)).toEqual(["future.thing", "host.future", "later"])
    expect(grantsOf(["approve", "nope", "view"])).toEqual(["approve", "view"])
  })

  it("refuses a permission name that is not a plain dotted word", () => {
    for (const name of ["", "has space", "UPPER", "x".repeat(65)]) {
      expect(Schema.decodeUnknownResult(identity)({ allowedUsers: [], hosts: [name] })._tag, name).toBe("Failure")
    }
  })

  it("names the permissions in one closed list", () => {
    const expected: ReadonlyArray<Permission> = [
      "view",
      "jobs.submit",
      "approve",
      "sandboxes.owner",
      "push",
      "connect.terminal",
      "apps.restart"
    ]
    expect(permissions).toEqual(expected)
  })
})
