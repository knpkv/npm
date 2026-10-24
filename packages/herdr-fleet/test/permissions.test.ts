import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { HostConfiguration } from "../src/model.js"
import { can, grantsOf, type Permission, permissions, type Principal, unknownPermissions } from "../src/permissions.js"

const identity = Schema.Struct({
  allowedUsers: HostConfiguration.fields.allowedUsers,
  users: HostConfiguration.fields.users,
  hosts: HostConfiguration.fields.hosts,
  local: HostConfiguration.fields.local
})
const configOf = (input: typeof identity.Encoded) => Schema.decodeSync(identity)(input)

const person = (login: string): Principal => ({ _tag: "Person", login })
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

  // Agents run on fleet hosts under the owner's login: a host is never a person and never approves or owns.
  it("lets a host view and submit jobs by default, and never approve or own, whatever hosts says", () => {
    const host: Principal = { _tag: "Host", nodeId: "node-build" }
    expect(all(host, configOf({ allowedUsers: [] }))).toEqual(["view", "jobs.submit"])
    expect(all(host, configOf({ allowedUsers: [], hosts: ["view"] }))).toEqual(["view"])
    expect(all(host, configOf({ allowedUsers: [], hosts: ["view", "approve", "sandboxes.owner"] }))).toEqual(["view"])
  })

  // Plain loopback is any process on the computer: it only views until the local login proves the user.
  it("lets plain loopback only view, and a local session what local grants", () => {
    const config = configOf({ allowedUsers: [] })
    expect(all({ _tag: "Local", session: false }, config)).toEqual(["view"])
    expect(all({ _tag: "Local", session: true }, config)).toEqual(permissions)
    expect(all({ _tag: "Local", session: true }, configOf({ allowedUsers: [], local: ["view", "apps.restart"] })))
      .toEqual(["view", "apps.restart"])
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
      allowedUsers: [],
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
