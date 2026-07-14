import { requireText } from "../internal/component.js"
import type { RlyFreshnessState } from "./FreshnessStamp.js"
import type { RlyPerson } from "./Person.js"
import type { RlyReleaseRelaySymbolIndices } from "./ReleaseRelay.js"
import type { RlyVerdictTone } from "./Verdict.js"

/** Caller-owned release presentation states, including an explicitly unevaluated state. */
export type RlyReleaseState = "blocked" | "ready" | "deploying" | "building" | "shipped" | "held" | "unknown"

/** One explicit display fact; values are never counted or derived by rly. */
export interface RlyReleaseFact {
  readonly id: string
  readonly label: string
  readonly value: string
}

type RlyReleaseFreshnessTime =
  | { readonly freshnessDateTime: string; readonly freshnessTime: string }
  | { readonly freshnessDateTime?: never; readonly freshnessTime?: never }

/** Presentation projection supplied by a release presenter, not a domain record. */
export type RlyReleasePresentation = RlyReleaseFreshnessTime & {
  readonly algorithm: string
  readonly approver?: RlyPerson
  readonly codename: string
  readonly facts: ReadonlyArray<RlyReleaseFact>
  readonly freshness: RlyFreshnessState
  readonly id: string
  readonly owner?: RlyPerson
  readonly reason: string
  readonly state: RlyReleaseState
  readonly symbolIndices: RlyReleaseRelaySymbolIndices
  readonly tone: RlyVerdictTone
  readonly verdict: string
  readonly version: string
}

const releaseStates: Readonly<Record<RlyReleaseState, true>> = {
  blocked: true,
  ready: true,
  deploying: true,
  building: true,
  shipped: true,
  held: true,
  unknown: true
}

/** Validate visible release projection fields without deriving identity or readiness. */
export const validateReleasePresentation = (release: RlyReleasePresentation): RlyReleasePresentation => {
  requireText(release.id, "Release presentation id")
  requireText(release.version, "Release presentation version")
  requireText(release.codename, "Release presentation codename")
  requireText(release.algorithm, "Release presentation algorithm")
  requireText(release.verdict, "Release presentation verdict")
  requireText(release.reason, "Release presentation reason")
  if (!Object.hasOwn(releaseStates, release.state)) throw new Error("Release presentation state must be supported")
  if (release.freshnessDateTime !== undefined) {
    requireText(release.freshnessDateTime, "Release presentation freshnessDateTime")
    requireText(release.freshnessTime, "Release presentation freshnessTime")
  }

  const factIds = new Set<string>()
  for (const fact of release.facts) {
    const id = requireText(fact.id, "Release presentation fact id")
    if (factIds.has(id)) throw new Error(`Release presentation fact ids must be unique: ${id}`)
    factIds.add(id)
    requireText(fact.label, `Release presentation fact label for ${id}`)
    requireText(fact.value, `Release presentation fact value for ${id}`)
  }
  return release
}
