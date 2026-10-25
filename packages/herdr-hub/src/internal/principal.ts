/**
 * Who a request is, from the facts the listener itself established: the WhoIs login and node on a tailnet
 * listener, or the socket address and header on loopback. Never from anything the request claims.
 *
 * **Mental model**
 *
 * - **A fleet host's node is a `Host`, whoever signs in.** Agents run there under the owner's login, so the
 *   node decides before the login does. The hub's own node is a fleet host too.
 * - **The hub's node is a `Service` only on a peer's service routes** (`serviceRoute`): the per-host routes
 *   a peer admits for the hub calling on behalf of the fleet. Everywhere else it is a `Host`.
 * - **A person is never present here.** `presence` is always `"none"`: only a verified passkey assertion
 *   for one decision can make a person present, and no listener fact carries one.
 * - **Plain loopback is the local user without a session.** Any process on the hub's computer can reach it
 *   and set any header, so loopback naming a login is no one, never the person it names.
 *
 * @module
 */
import { can, type Permission, permissions, type Principal } from "@knpkv/herdr-fleet"
import type { HostConfiguration } from "@knpkv/herdr-fleet/model"

type Grants = Parameters<typeof can>[0]

export type PrincipalInput =
  /** A WhoIs-identified tailnet request; `serviceRoute` when it reached a peer's per-host service route. */
  | { readonly _tag: "Tailnet"; readonly login: string; readonly nodeId: string; readonly serviceRoute: boolean }
  /** A request on the loopback listener, with the `tailscale-user-login` header it carried, if any. */
  | { readonly _tag: "Loopback"; readonly remoteAddress: string; readonly headerLogin: string | undefined }

const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

/** The principal a request is under `config`. */
export const principalFor = (
  config: Pick<HostConfiguration, "allowedUsers" | "machines"> & {
    readonly approvalHub: Pick<HostConfiguration["approvalHub"], "nodeId">
  },
  input: PrincipalInput
): Principal => {
  switch (input._tag) {
    case "Tailnet":
      return input.serviceRoute && input.nodeId === config.approvalHub.nodeId
        ? { _tag: "Service", nodeId: input.nodeId }
        : config.machines.some(({ nodeId }) => nodeId === input.nodeId)
        ? { _tag: "Host", nodeId: input.nodeId }
        : config.allowedUsers.includes(input.login)
        ? { _tag: "Person", login: input.login, nodeId: input.nodeId, presence: "none" }
        : { _tag: "Anonymous" }
    case "Loopback":
      return loopback.has(input.remoteAddress) && input.headerLogin === undefined
        ? { _tag: "Local", session: false }
        : { _tag: "Anonymous" }
  }
}

/** Every permission `principal` holds under `config`, in display order. */
export const grantsFor = (config: Grants, principal: Principal): ReadonlyArray<Permission> =>
  permissions.filter((permission) => can(config, principal, permission))
