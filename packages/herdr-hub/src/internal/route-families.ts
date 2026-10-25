/**
 * The route families the hub serves, and what each family's caller must be once identity decides access.
 *
 * **Mental model**
 *
 * - **Every served route names one family.** A route no family names is unknown: the shadow log reports it
 *   rather than guessing, and the enforcement flip refuses it.
 * - **A family says what its caller must be, not how today's handler checks it.** Today's checks still
 *   decide every request; this table is what identity will enforce, and the shadow log compares the two.
 * - **Requirements**: `Public` (static files), `Grant` (an app's per-request grant, checked by the app
 *   services route), a `Permission` from the fleet's closed list, `Host` (a fleet host acting as itself,
 *   for agents' reports), `Service` (the hub calling a peer's per-host route), or `Person` (a human write
 *   that no permission names yet; the flip settles it).
 *
 * @module
 */
import { can, type Permission, type Principal } from "@knpkv/herdr-fleet"

export type Requirement =
  | { readonly _tag: "Public" }
  | { readonly _tag: "Grant" }
  | { readonly _tag: "Permission"; readonly permission: Permission }
  | { readonly _tag: "Host" }
  | { readonly _tag: "Service" }
  | { readonly _tag: "Person" }

export interface RouteFamily {
  readonly id: string
  readonly requirement: Requirement
}

const publicFiles: Requirement = { _tag: "Public" }
const grant: Requirement = { _tag: "Grant" }
const fleetHost: Requirement = { _tag: "Host" }
const service: Requirement = { _tag: "Service" }
const person: Requirement = { _tag: "Person" }
const permission = (name: Permission): Requirement => ({ _tag: "Permission", permission: name })

const family = (id: string, requirement: Requirement): RouteFamily => ({ id, requirement })

const dashboardReads = new Set([
  "/v1/dashboard",
  "/v1/dashboard-history",
  "/v1/dashboard-pending",
  "/v1/pending-approval",
  "/v1/pending-approvals",
  "/v1/status",
  "/v1/history"
])
const pages = new Set(["/", "/connect", "/connect/", "/fleet"])
const reads = (method: string) => method === "GET" || method === "HEAD"

/** The family of a `method` request to `pathname`, or null when no family names it. */
export const routeFamily = (method: string, pathname: string): RouteFamily | null => {
  const read = reads(method)
  const write = method === "POST"
  if (pathname.startsWith("/assets/") || pathname === "/manifest.webmanifest") {
    return read ? family("static", publicFiles) : null
  }
  if (pages.has(pathname) || pathname.startsWith("/fleet/")) return read ? family("page", permission("view")) : null
  // Logging in and out authenticates itself: WhoIs, the CLI token, a one-time code or the session's CSRF token.
  if (pathname === "/v1/session" || pathname.startsWith("/v1/session/")) return family("session", publicFiles)
  if (dashboardReads.has(pathname)) return read ? family("dashboard", permission("view")) : null
  if (pathname === "/v1/jobs") return write ? family("jobs.submit", permission("jobs.submit")) : null
  if (/^\/v1\/jobs\/[^/]+\/(?:approve|reject)$/u.test(pathname)) {
    return write ? family("jobs.decide", permission("approve")) : null
  }
  if (/^\/v1\/jobs\/[^/]+$/u.test(pathname)) return read ? family("dashboard", permission("view")) : null
  if (pathname === "/v1/work" || pathname.startsWith("/v1/work/")) {
    return read ? family("work.read", permission("view")) : write ? family("work.write", person) : null
  }
  if (pathname === "/v1/push/config") return read ? family("push.read", permission("view")) : null
  if (pathname.startsWith("/v1/push/")) return family("push.write", permission("push"))
  if (/^\/v1\/connect\/[a-z]+\/local$/u.test(pathname) || pathname === "/v1/connect/terminal") {
    return family("connect.service", service)
  }
  if (pathname === "/v1/connect/session" || pathname === "/v1/connect/terminal/capabilities") {
    return family("connect.terminal", permission("connect.terminal"))
  }
  if (pathname === "/v1/connect/posts" || pathname === "/v1/connect/me") {
    return write ? family("connect.report", fleetHost) : read ? family("connect.read", permission("view")) : null
  }
  if (pathname.startsWith("/v1/connect/") || pathname === "/v1/host/resources") {
    return read ? family("connect.read", permission("view")) : null
  }
  // Needs-you actions on a failed fleet job: dismissing is a person's write; Try again submits a job.
  if (pathname === "/v1/modules/fleet/failures/dismiss") return write ? family("fleet.failures.dismiss", person) : null
  if (pathname === "/v1/modules/fleet/failures/retry") {
    return write ? family("fleet.failures.retry", permission("jobs.submit")) : null
  }
  if (pathname === "/v1/modules" || pathname.startsWith("/v1/modules/")) {
    return read
      ? family("modules.read", permission("view"))
      // Every Sandboxes write acts for the owner: jobs (lease, extend, release, retry, lift), AWS sign-in
      // and sign-out. Its routes answer 403 owner_only to anyone else today.
      : pathname.startsWith("/v1/modules/sandboxes/")
      ? family("modules.sandboxes", permission("sandboxes.owner"))
      : family("modules.write", person)
  }
  if (/^\/v1\/apps\/[^/]+\/restart$/u.test(pathname)) {
    return write ? family("apps.restart", permission("apps.restart")) : null
  }
  if (pathname === "/v1/apps") return read ? family("apps.read", permission("view")) : null
  if (pathname.startsWith("/apps/")) {
    return read
      ? family("apps.read", permission("view"))
      : family("apps.write", person)
  }
  if (pathname.startsWith("/v1/app-services/")) return family("app-services", grant)
  if (pathname === "/v1/relay/decisions") {
    return write ? family("relay.decide", permission("approve")) : family("relay.read", permission("view"))
  }
  if (pathname.startsWith("/v1/relay/")) {
    return read ? family("relay.read", permission("view")) : write ? family("relay.write", person) : null
  }
  return null
}

/** Whether `principal` meets `requirement` under `config`. */
export const meets = (
  config: Parameters<typeof can>[0],
  principal: Principal,
  requirement: Requirement
): boolean => {
  switch (requirement._tag) {
    case "Public":
    case "Grant":
      return true
    case "Permission":
      return can(config, principal, requirement.permission)
    case "Host":
      return principal._tag === "Host"
    case "Service":
      return principal._tag === "Service"
    case "Person":
      return principal._tag === "Person" || (principal._tag === "Local" && principal.session)
  }
}
