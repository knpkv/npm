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
 *   in `allowedUsers` holds every permission, as before permissions existed.
 * - **Some permissions are never a host's.** `approve` and `sandboxes.owner` act for the owner, so a host
 *   never holds them, whatever `hosts` says. Plain loopback without the local sign-in only views.
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

export type Principal =
  | { readonly _tag: "Person"; readonly login: string }
  | { readonly _tag: "Host"; readonly nodeId: string }
  | { readonly _tag: "Local"; readonly session: boolean }
  | { readonly _tag: "Service"; readonly nodeId: string }
  | { readonly _tag: "Anonymous" }

type Grants = Pick<HostConfiguration, "allowedUsers" | "users" | "hosts" | "local">

const isPermission = Schema.is(Permission)

/** The known permissions among `names`, in their order; unknown names are dropped. */
export const grantsOf = (names: ReadonlyArray<string>): ReadonlyArray<Permission> => names.filter(isPermission)

const grantedTo = (config: Grants, principal: Principal): ReadonlyArray<Permission> => {
  switch (principal._tag) {
    case "Person":
      return config.users === undefined
        ? (config.allowedUsers.includes(principal.login) ? permissions : [])
        : grantsOf(config.users[principal.login] ?? [])
    case "Host":
      return (config.hosts === undefined ? defaultHostPermissions : grantsOf(config.hosts))
        .filter((permission) => !ownerOnly.has(permission))
    case "Local":
      return principal.session ? (config.local === undefined ? permissions : grantsOf(config.local)) : ["view"]
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
