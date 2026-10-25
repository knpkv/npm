/**
 * The hub's front door: whether a request may go on to today's handler, from its route family and caller.
 *
 * **Mental model**
 *
 * - **The hub is behind login.** A browser without a session reaches only the session routes and static
 *   files. A caller is asked to log in when the same caller logged in (`afterLogin`) would get through;
 *   anyone a login wouldn't help (no one, a credential that can't hold the permission, a person approving
 *   from a node that can't approve) is forbidden.
 * - **Agents and hosts keep their own credentials.** The CLI token on loopback and a fleet host's node on the
 *   tailnet decide by what {@link meets} grants them, never by a session.
 * - **A browser document is a person's, never a host's.** Agents on a fleet host read the hub's JSON as the
 *   host; a page there (or an app's page, navigated to) shows only after someone logs in in that browser.
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
  /** `document`: a browser navigation, answered with the login gate's page rather than JSON. */
  | { readonly _tag: "LoginRequired"; readonly document: boolean }
  | { readonly _tag: "Forbidden" }
  | { readonly _tag: "CsrfRequired" }
  | { readonly _tag: "Unknown" }

const open = (family: RouteFamily) => family.requirement._tag === "Public" || family.requirement._tag === "Grant"

/** Whether a request to `family` needs its caller read: a known family that checks who calls. */
export const callerNeeded = (family: RouteFamily | null): family is RouteFamily => family !== null && !open(family)

const sessioned = (principal: Principal) =>
  (principal._tag === "Person" || principal._tag === "Local") && principal.session

/**
 * Whether a request to `family` is a browser document: a hub page, or an app's page a browser navigated to
 * (`Sec-Fetch-Dest: document`, or an `Accept` that asks for HTML).
 */
export const isDocument = (
  family: RouteFamily | null,
  method: string,
  headers: { readonly fetchDest: string | undefined; readonly accept: string | undefined }
): boolean =>
  family?.id === "page" ||
  (family?.id === "apps.read" && (method === "GET" || method === "HEAD") &&
    (headers.fetchDest === "document" || (headers.accept ?? "").includes("text/html")))

/** The gate's answer for a `method` request to `family` from `principal`, under `config`. */
export const gateVerdict = (
  config: Grants,
  request: {
    readonly method: string
    readonly family: RouteFamily | null
    readonly principal: Principal
    /** The same caller once logged in on this listener; null when no login could change who it is. */
    readonly afterLogin: Principal | null
    readonly document: boolean
    readonly csrfOk: boolean
  }
): GateVerdict => {
  const { afterLogin, document, family, principal } = request
  if (family === null) return { _tag: "Unknown" }
  if (open(family)) return { _tag: "Pass" }
  const admits = (caller: Principal) =>
    meets(config, caller, family.requirement) && !(document && caller._tag === "Host")
  if (!admits(principal)) {
    return afterLogin !== null && admits(afterLogin) ? { _tag: "LoginRequired", document } : { _tag: "Forbidden" }
  }
  const read = request.method === "GET" || request.method === "HEAD"
  return sessioned(principal) && !read && !request.csrfOk ? { _tag: "CsrfRequired" } : { _tag: "Pass" }
}
