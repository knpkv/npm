/**
 * Shadow mode for identity-based access: today's checks still decide every request, and this records
 * where identity would decide differently, so the enforcement flip ships with a measured list of what it
 * changes.
 *
 * **Mental model**
 *
 * - **Only what today served is compared.** A request today's checks refused tells nothing about the flip,
 *   and counting it would let anyone who reaches a listener fill the log with junk paths.
 * - **Two findings.** A served request the route's family would refuse to its principal, and a served route
 *   no family names. Each distinct finding is logged once per hub run, keyed so identifiers in a path don't
 *   make a new line, under separate caps so one kind can't crowd out the other.
 * - **The cost tails off.** Reading the caller (a WhoIs lookup on the tailnet) is skipped once every
 *   principal kind that could be refused for a listener and family is logged, and a lookup is reused for
 *   the same address for a short while.
 * - **It refuses nothing.** The log runs after the response is sent, or after a WebSocket upgrade is accepted.
 *
 * @module
 */
import type { Principal } from "@knpkv/herdr-fleet"
import { Clock, Effect } from "effect"
import type { ListenerMode } from "./listener.js"
import { meets, type Requirement, type RouteFamily, routeFamily } from "./route-families.js"

type Grants = Parameters<typeof meets>[0]

export interface ShadowRequest {
  readonly listener: ListenerMode
  readonly method: string
  readonly pathname: string
  /** The status today's handler answered with; 101 for an accepted WebSocket upgrade. */
  readonly status: number
  /** Who identity says the caller is; null when that could not be read. */
  readonly principal: Principal | null
}

export interface ShadowFinding {
  readonly kind: "refused" | "undeclared"
  /** One line per key per run. */
  readonly key: string
  readonly fields: Readonly<Record<string, string>>
}

const requirementName = (requirement: Requirement): string =>
  requirement._tag === "Permission" ? requirement.permission : requirement._tag

/** The first two segments of a path: enough to name a route without its identifiers. */
const leadingPath = (pathname: string): string => `/${pathname.split("/").filter(Boolean).slice(0, 2).join("/")}`

const refusedKey = (listener: ListenerMode, principal: Principal["_tag"], family: RouteFamily) =>
  `refused ${listener} ${principal} ${family.id}`

/** Whether a served request needs its caller read: a known family whose requirement depends on who calls. */
export const shadowCompares = (family: RouteFamily | null, status: number): family is RouteFamily =>
  family !== null && status < 400 && family.requirement._tag !== "Public" && family.requirement._tag !== "Grant"

/** What, if anything, a request tells the shadow log under `config`. */
export const shadowFinding = (config: Grants, request: ShadowRequest): ShadowFinding | null => {
  if (request.status >= 400) return null
  const family = routeFamily(request.method, request.pathname)
  if (family === null) {
    const path = leadingPath(request.pathname)
    return {
      kind: "undeclared",
      key: `undeclared ${request.listener} ${request.method} ${path}`,
      fields: { listener: request.listener, method: request.method, path }
    }
  }
  if (request.principal === null || meets(config, request.principal, family.requirement)) return null
  return {
    kind: "refused",
    key: refusedKey(request.listener, request.principal._tag, family),
    fields: {
      listener: request.listener,
      principal: request.principal._tag,
      family: family.id,
      requirement: requirementName(family.requirement)
    }
  }
}

/**
 * One principal of each kind a listener can see, each as refusable as that kind gets: loopback is the local
 * user without a session; a tailnet person is on no approval node, once per allowed login.
 */
const candidates = (config: Grants, listener: ListenerMode): ReadonlyArray<Principal> =>
  listener === "local"
    ? [{ _tag: "Local", session: false }]
    : [
      { _tag: "Host", nodeId: "" },
      { _tag: "Service", nodeId: "" },
      ...config.allowedUsers.map((login): Principal => ({ _tag: "Person", login, nodeId: "", presence: "none" }))
    ]

/** Distinct findings kept per run, per kind; past that, new ones are not logged rather than kept. */
const findingLimits = { refused: 256, undeclared: 64 } satisfies Record<ShadowFinding["kind"], number>

/** Logs each distinct finding once, as a warning annotated with its fields. */
export const makeShadowLog = (config: Grants) => {
  const logged = { refused: new Set<string>(), undeclared: new Set<string>() }
  return {
    log: (finding: ShadowFinding): Effect.Effect<void> =>
      Effect.suspend(() => {
        const keys = logged[finding.kind]
        if (keys.has(finding.key) || keys.size >= findingLimits[finding.kind]) return Effect.void
        keys.add(finding.key)
        return Effect.logWarning(`identity shadow: ${finding.key}`).pipe(Effect.annotateLogs(finding.fields))
      }),
    /** Whether every principal kind that could be refused on `listener` for `family` is already logged. */
    settled: (listener: ListenerMode, family: RouteFamily): boolean =>
      candidates(config, listener)
        .filter((principal) => !meets(config, principal, family.requirement))
        .every((principal) => logged.refused.has(refusedKey(listener, principal._tag, family)))
  }
}

/** Reuses `lookup`'s answer for the same key for `ttlMillis`, keeping at most `limit` keys. */
export const makeRecentLookup = <A, E, R>(
  lookup: (key: string) => Effect.Effect<A, E, R>,
  options: { readonly ttlMillis: number; readonly limit: number }
) => {
  const recent = new Map<string, { readonly at: number; readonly value: A }>()
  return (key: string): Effect.Effect<A, E, R> =>
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      const hit = recent.get(key)
      if (hit !== undefined && now - hit.at < options.ttlMillis) return hit.value
      const value = yield* lookup(key)
      recent.delete(key)
      recent.set(key, { at: now, value })
      const oldest = recent.size > options.limit ? recent.keys().next().value : undefined
      if (oldest !== undefined) recent.delete(oldest)
      return value
    })
}
