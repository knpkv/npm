/**
 * Shadow mode for identity-based access: today's checks still decide every request, and this records
 * where identity would decide differently, so the enforcement flip ships with a measured list of what it
 * changes.
 *
 * **Mental model**
 *
 * - **Only disagreements are logged.** A request today's checks served that the route's family would
 *   refuse to its principal, and a route no family names. Each distinct finding is logged once per hub
 *   run, keyed so identifiers in a path don't make a new line.
 * - **It refuses nothing.** The log runs after the response is sent.
 *
 * @module
 */
import type { Principal } from "@knpkv/herdr-fleet"
import { Effect } from "effect"
import type { ListenerMode } from "./listener.js"
import { meets, type Requirement, routeFamily } from "./route-families.js"

export interface ShadowRequest {
  readonly listener: ListenerMode
  readonly method: string
  readonly pathname: string
  /** The status today's handler answered with. */
  readonly status: number
  /** Who identity says the caller is; null when that could not be read. */
  readonly principal: Principal | null
}

export interface ShadowFinding {
  /** One line per key per run. */
  readonly key: string
  readonly fields: Readonly<Record<string, string>>
}

const requirementName = (requirement: Requirement): string =>
  requirement._tag === "Permission" ? requirement.permission : requirement._tag

/** The first two segments of a path: enough to name a route without its identifiers. */
const leadingPath = (pathname: string): string => `/${pathname.split("/").filter(Boolean).slice(0, 2).join("/")}`

/** What, if anything, a served request tells the shadow log under `config`. */
export const shadowFinding = (
  config: Parameters<typeof meets>[0],
  request: ShadowRequest
): ShadowFinding | null => {
  const family = routeFamily(request.method, request.pathname)
  if (family === null) {
    const path = leadingPath(request.pathname)
    return {
      key: `undeclared ${request.listener} ${request.method} ${path}`,
      fields: { listener: request.listener, method: request.method, path }
    }
  }
  if (request.status >= 400 || request.principal === null) return null
  if (meets(config, request.principal, family.requirement)) return null
  return {
    key: `refused ${request.listener} ${request.principal._tag} ${family.id}`,
    fields: {
      listener: request.listener,
      principal: request.principal._tag,
      family: family.id,
      requirement: requirementName(family.requirement)
    }
  }
}

/** Distinct findings kept per run; a hub with more stops logging new ones rather than growing. */
const findingLimit = 256

/** Logs each distinct finding once, as a warning annotated with its fields. */
export const makeShadowLog = () => {
  const logged = new Set<string>()
  return (finding: ShadowFinding): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (logged.has(finding.key) || logged.size >= findingLimit) return Effect.void
      logged.add(finding.key)
      return Effect.logWarning(`identity shadow: ${finding.key}`).pipe(Effect.annotateLogs(finding.fields))
    })
}
