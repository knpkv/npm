/**
 * The hub's front door: whether a request may go on to today's handler, from its route family and caller.
 *
 * **Mental model**
 *
 * - **The hub is behind login.** A browser without a session reaches only the session routes and static
 *   files. A person or the local user without one is asked to log in when logging in would let them through;
 *   anyone a login wouldn't help (no one, a credential that can't hold the permission, a person approving
 *   from a node that can't approve) is forbidden.
 * - **Agents and hosts keep their own credentials.** The CLI token on loopback and a fleet host's node on the
 *   tailnet decide by what {@link meets} grants them, never by a session.
 * - **A session's writes carry its CSRF token.** Reads and the families that check no caller don't.
 * - **A route no family names is refused,** so a new route can't slip past the gate.
 *
 * @module
 */
import type { Principal } from "@knpkv/herdr-fleet"
import { Schema } from "effect"
import { meets, type RouteFamily } from "./route-families.js"

type Grants = Parameters<typeof meets>[0]

/** The listener couldn't say who a request is (no socket address); the gate refuses it. */
export class GateCallerUnknown extends Schema.TaggedError<GateCallerUnknown>()("GateCallerUnknown", {}) {}

export type GateVerdict =
  | { readonly _tag: "Pass" }
  | { readonly _tag: "LoginRequired" }
  | { readonly _tag: "Forbidden" }
  | { readonly _tag: "CsrfRequired" }
  | { readonly _tag: "Unknown" }

const open = (family: RouteFamily) => family.requirement._tag === "Public" || family.requirement._tag === "Grant"

/** Whether a request to `family` needs its caller read: a known family that checks who calls. */
export const callerNeeded = (family: RouteFamily | null): family is RouteFamily => family !== null && !open(family)

const sessioned = (principal: Principal) =>
  (principal._tag === "Person" || principal._tag === "Local") && principal.session

/** The same caller once logged in, when it could log in at all. */
const loggedIn = (principal: Principal): Principal | null =>
  (principal._tag === "Person" || principal._tag === "Local") && !principal.session
    ? { ...principal, session: true }
    : null

/** The gate's answer for a `method` request to `family` from `principal`, under `config`. */
export const gateVerdict = (
  config: Grants,
  request: {
    readonly method: string
    readonly family: RouteFamily | null
    readonly principal: Principal
    readonly csrfOk: boolean
  }
): GateVerdict => {
  const { family, principal } = request
  if (family === null) return { _tag: "Unknown" }
  if (open(family)) return { _tag: "Pass" }
  if (!meets(config, principal, family.requirement)) {
    const afterLogin = loggedIn(principal)
    return afterLogin !== null && meets(config, afterLogin, family.requirement)
      ? { _tag: "LoginRequired" }
      : { _tag: "Forbidden" }
  }
  const read = request.method === "GET" || request.method === "HEAD"
  return sessioned(principal) && !read && !request.csrfOk ? { _tag: "CsrfRequired" } : { _tag: "Pass" }
}
