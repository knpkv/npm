/**
 * Who a request is, from the facts the listener itself established: the WhoIs login and node on a tailnet
 * listener, or the socket address and header on loopback, plus the session or CLI token the hub itself
 * verified. Never from anything the request merely claims.
 *
 * **Mental model**
 *
 * - **A fleet host's node is a `Host` until someone logs in in a browser there.** Agents run there under the
 *   owner's login, so the node decides before the login does; only a session bound to that node and login
 *   makes it a `Person`. The hub's own node is a fleet host too.
 * - **A person on any other node is a `Person`, logged in or not.** `session` says whether a session bound
 *   to this node and login came with the request. A session carried to another node, or presented under
 *   another login, is ignored.
 * - **The hub's node is a `Service` only on a peer's service routes** (`serviceRoute`): the per-host routes
 *   a peer admits for the hub calling on behalf of the fleet. Everywhere else it is a `Host`.
 * - **A person is never present here.** `presence` is always `"none"`: only a verified passkey assertion
 *   for one decision can make a person present, and no listener fact carries one.
 * - **Plain loopback is the local user without a session.** Any process on the hub's computer can reach it
 *   and set any header, so loopback naming a login is no one, never the person it names. A verified local
 *   session makes it the local user with a session, and the CLI token makes it the `Cli`; both show intent,
 *   not isolation, since every process of the user can read the token.
 *
 * @module
 */
import { can, type Permission, permissions, type Principal } from "@knpkv/herdr-fleet"
import type { HostConfiguration } from "@knpkv/herdr-fleet/model"
import type { OpenSession } from "./person-sessions.js"

type Grants = Parameters<typeof can>[0]

export type PrincipalInput =
  /**
   * A WhoIs-identified tailnet request; `serviceRoute` when it reached a peer's per-host service route, and
   * the open session its cookie named, if any.
   */
  | {
    readonly _tag: "Tailnet"
    readonly login: string
    readonly nodeId: string
    readonly serviceRoute: boolean
    readonly session: OpenSession | null
  }
  /**
   * A request on the loopback listener: the `tailscale-user-login` header it carried, whether it presented
   * the hub's CLI token, and the open session its header named, if any.
   */
  | {
    readonly _tag: "Loopback"
    readonly remoteAddress: string
    readonly headerLogin: string | undefined
    readonly cli: boolean
    readonly session: OpenSession | null
  }

const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

/** The principal a request is under `config`. */
export const principalFor = (
  config: Pick<HostConfiguration, "allowedUsers" | "machines"> & {
    readonly approvalHub: Pick<HostConfiguration["approvalHub"], "nodeId">
  },
  input: PrincipalInput
): Principal => {
  switch (input._tag) {
    case "Tailnet": {
      const session = input.session?.kind === "tailscale" && input.session.login === input.login &&
        input.session.nodeId === input.nodeId
      const allowed = config.allowedUsers.includes(input.login)
      const person: Principal = {
        _tag: "Person",
        login: input.login,
        nodeId: input.nodeId,
        presence: "none",
        session
      }
      return input.serviceRoute && input.nodeId === config.approvalHub.nodeId
        ? { _tag: "Service", nodeId: input.nodeId }
        : config.machines.some(({ nodeId }) => nodeId === input.nodeId)
        ? session && allowed ? person : { _tag: "Host", nodeId: input.nodeId }
        : allowed
        ? person
        : { _tag: "Anonymous" }
    }
    case "Loopback":
      return !loopback.has(input.remoteAddress) || input.headerLogin !== undefined
        ? { _tag: "Anonymous" }
        : input.cli
        ? { _tag: "Cli" }
        : { _tag: "Local", session: input.session?.kind === "local" }
  }
}

/** Every permission `principal` holds under `config`, in display order. */
export const grantsFor = (config: Grants, principal: Principal): ReadonlyArray<Permission> =>
  permissions.filter((permission) => can(config, principal, permission))
