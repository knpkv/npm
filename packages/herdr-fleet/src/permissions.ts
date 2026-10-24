/**
 * Who may do what on a hub: one closed list of permissions and one predicate, {@link can}.
 *
 * **Mental model**
 *
 * - **A principal is who the hub decided the request is.** A `Person` signed in in a browser, a fleet
 *   `Host` (agents run there under the owner's login, so a host is never a person), the `Local` user on
 *   the hub's own computer, another hub node calling as a `Service`, or no one (`Anonymous`). Deciding
 *   which one a request is belongs to the listener; this module only answers what each may do.
 * - **Grants come from the fleet configuration.** `users` maps a login to its permissions, `hosts` is what
 *   any fleet host may do, `local` what a signed-in local user may do. While `users` is absent, every login
 *   in `allowedUsers` holds every permission, as before permissions existed. A `users` entry for a login
 *   outside `allowedUsers` grants nothing: Tailscale never admits that login.
 * - **Owner permissions need a person.** `approve` and `sandboxes.owner` act for the owner. Agents run on
 *   fleet hosts under the owner's login and on the hub's own computer under its user account, so neither a
 *   host nor the local user ever holds them, whatever `hosts` or `local` says. Plain loopback without the
 *   local sign-in only views.
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

/** Permissions that act for the owner; a host never holds them. */
const ownerOnly: ReadonlySet<Permission> = new Set<Permission>(["approve", "sandboxes.owner"])

/** How a person proved they are present: not at all yet, or a passkey for this decision. */
export type Presence = "none" | "passkey"

export type Principal =
  | { readonly _tag: "Person"; readonly login: string; readonly nodeId: string; readonly presence: Presence }
  | { readonly _tag: "Host"; readonly nodeId: string }
  | { readonly _tag: "Local"; readonly session: boolean }
  | { readonly _tag: "Service"; readonly nodeId: string }
  | { readonly _tag: "Anonymous" }

type Grants = Pick<HostConfiguration, "allowedUsers" | "approvalNodes" | "users" | "hosts" | "local">

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
    : grantsOf(config.users[login] ?? [])

const grantedTo = (config: Grants, principal: Principal): ReadonlyArray<Permission> => {
  switch (principal._tag) {
    case "Person": {
      const present = principal.presence === "passkey" || config.approvalNodes.includes(principal.nodeId)
      return personGrants(config, principal.login).filter((permission) => permission !== "approve" || present)
    }
    case "Host":
      return withoutOwnerOnly(config.hosts === undefined ? defaultHostPermissions : grantsOf(config.hosts))
    case "Local":
      return principal.session
        ? withoutOwnerOnly(config.local === undefined ? permissions : grantsOf(config.local))
        : ["view"]
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
