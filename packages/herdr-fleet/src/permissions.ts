/**
 * Who may do what on a hub: one closed list of permissions and one predicate, {@link can}.
 *
 * **Mental model**
 *
 * - **A principal is who the hub decided the request is.** A `Person` (a login on a tailnet node), a fleet
 *   `Host` (agents run there under the owner's login, so a host is never a person), the `Local` user on
 *   the hub's own computer, the `Cli` (a command holding the hub's CLI token), another hub node calling as
 *   a `Service`, or no one (`Anonymous`). Deciding which one a request is belongs to the listener; this
 *   module only answers what each may do.
 * - **The hub is behind login.** Logging in is a deliberate press in a browser, so a person without a
 *   session gets nothing, on any node, and neither does plain loopback. Before passkeys a session shows
 *   intent, not presence: an agent on the same node could press it too.
 * - **Grants come from the fleet configuration.** `users` maps a login to its permissions, `hosts` is what
 *   any fleet host may do, `local` what a signed-in local user may do. While `users` is absent, every login
 *   in `allowedUsers` holds every permission, as before permissions existed. A `users` entry for a login
 *   outside `allowedUsers` grants nothing: Tailscale never admits that login.
 * - **Owner permissions need a person.** `approve` and `sandboxes.owner` act for the owner. Agents run on
 *   fleet hosts under the owner's login and on the hub's own computer under its user account, so neither a
 *   host nor the local user ever holds them, whatever `hosts` or `local` says. A person logged in on a fleet
 *   machine never owns Sandboxes either: there the session can't tell them from the agents beside them.
 *   Plain loopback without the local sign-in gets nothing.
 * - **The CLI is the computer's agents.** Every process of the user can read the CLI token, agents
 *   included, so it adds intent, not isolation: it views, submits jobs (agents do) and restarts apps (nix
 *   activation does), and never acts for the owner.
 * - **Approving needs the approval node or a passkey.** A person approves from a node in `approvalNodes`,
 *   as before identities existed, or from any node once a passkey proved them present for that decision.
 * - **A service is checked by its node, not here.** Hub-to-peer calls are admitted by the hub's node id
 *   where they arrive; `can` grants a `Service` nothing.
 * - **Unknown names are ignored, not refused.** One configuration reaches hosts that may run an older hub,
 *   so a permission this hub does not know decodes, grants nothing, and is listed by
 *   {@link unknownPermissions} for the startup log. Every known grant still holds.
 *
 * @module
 */
import { Schema } from "effect"
import type { HostConfiguration } from "./model.js"

export const Permission = Schema.Literals([
  "view",
  "jobs.submit",
  "approve",
  "sandboxes.owner",
  "push",
  "connect.terminal",
  "apps.restart"
])
export type Permission = typeof Permission.Type

/** Everything a hub can grant, in display order. */
export const permissions: ReadonlyArray<Permission> = Permission.literals

/**
 * A permission as the configuration names it: any plain dotted lower-case word, so a name a newer hub
 * added still decodes here.
 */
export const PermissionName = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/u)
)

/** What a host may do when `hosts` is absent. */
export const defaultHostPermissions: ReadonlyArray<Permission> = ["view", "jobs.submit"]

/** What the CLI token holds: the computer's agents read and submit jobs, nix activation restarts apps. */
const cliPermissions: ReadonlyArray<Permission> = ["view", "jobs.submit", "apps.restart"]

/** Permissions that act for the owner; a host never holds them. */
const ownerOnly: ReadonlySet<Permission> = new Set<Permission>(["approve", "sandboxes.owner"])

/** How a person proved they are present: not at all yet, or a passkey for this decision. */
export type Presence = "none" | "passkey"

export type Principal =
  | {
    readonly _tag: "Person"
    readonly login: string
    readonly nodeId: string
    readonly presence: Presence
    /** Whether this person logged in in a browser on this node. */
    readonly session: boolean
  }
  | { readonly _tag: "Host"; readonly nodeId: string }
  | { readonly _tag: "Local"; readonly session: boolean }
  | { readonly _tag: "Cli" }
  | { readonly _tag: "Service"; readonly nodeId: string }
  | { readonly _tag: "Anonymous" }

type Grants = Pick<HostConfiguration, "allowedUsers" | "approvalNodes" | "users" | "hosts" | "local" | "machines">

const isPermission = Schema.is(Permission)

/** The known permissions among `names`, in their order; unknown names are dropped. */
export const grantsOf = (names: ReadonlyArray<string>): ReadonlyArray<Permission> => names.filter(isPermission)

const withoutOwnerOnly = (granted: ReadonlyArray<Permission>): ReadonlyArray<Permission> =>
  granted.filter((permission) => !ownerOnly.has(permission))

const personGrants = (config: Grants, login: string): ReadonlyArray<Permission> =>
  !config.allowedUsers.includes(login)
    ? []
    : config.users === undefined
    ? permissions
    : Object.hasOwn(config.users, login)
    ? grantsOf(config.users[login] ?? [])
    : []

const grantedTo = (config: Grants, principal: Principal): ReadonlyArray<Permission> => {
  switch (principal._tag) {
    case "Person": {
      const granted = personGrants(config, principal.login)
      if (!principal.session) return []
      const present = principal.presence === "passkey" || config.approvalNodes.includes(principal.nodeId)
      const onMachine = config.machines.some(({ nodeId }) => nodeId === principal.nodeId)
      return granted.filter((permission) =>
        (permission !== "approve" || present) && (permission !== "sandboxes.owner" || !onMachine)
      )
    }
    case "Host":
      return withoutOwnerOnly(config.hosts === undefined ? defaultHostPermissions : grantsOf(config.hosts))
    case "Local":
      return principal.session
        ? withoutOwnerOnly(config.local === undefined ? permissions : grantsOf(config.local))
        : []
    case "Cli":
      return cliPermissions
    case "Service":
    case "Anonymous":
      return []
  }
}

/** Whether `principal` holds `permission` under `config`. */
export const can = (config: Grants, principal: Principal, permission: Permission): boolean =>
  grantedTo(config, principal).includes(permission)

/** Every permission name in `config` this hub does not know, once each, in configuration order. */
export const unknownPermissions = (config: Grants): ReadonlyArray<string> => {
  const named = [
    ...Object.values(config.users ?? {}).flat(),
    ...(config.hosts ?? []),
    ...(config.local ?? [])
  ]
  return [...new Set(named.filter((name) => !isPermission(name)))]
}
