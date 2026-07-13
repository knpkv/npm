import type { RlyIconName } from "../foundations/Icon.js"
import { requireText } from "../internal/component.js"
import type { RlyPerson } from "./Person.js"
import { RLY_SERVICE_MARK_VARIANTS, type RlyService } from "./ServiceMark.js"

/** Lifecycle words supplied by an application presenter. */
export type RlyRelationshipLifecycle =
  | "missing"
  | "inferred"
  | "proposed"
  | "verified"
  | "governed"
  | "rejected"
  | "superseded"

/** Direction supplied by an application presenter. */
export type RlyRelationshipDirection = "forward" | "reverse" | "bidirectional"

/** A resolvable endpoint with complete visible identity. */
export interface RlyPresentRelationshipEndpoint {
  readonly state: "present"
  readonly id: string
  readonly title: string
  readonly reference: string
  readonly service: RlyService
  readonly href?: string
  readonly person?: RlyPerson
}

/** An explicit gap where an endpoint would otherwise be silently absent. */
export interface RlyMissingRelationshipEndpoint {
  readonly state: "missing"
  readonly label: string
  readonly reason: string
  readonly service?: RlyService
}

/** Presentation-only endpoint supplied without lookup or derivation. */
export type RlyRelationshipEndpoint = RlyPresentRelationshipEndpoint | RlyMissingRelationshipEndpoint

/** One ordered, application-owned relationship record. */
export interface RlyRelationship {
  readonly id: string
  readonly kind: string
  readonly direction: RlyRelationshipDirection
  readonly lifecycle: RlyRelationshipLifecycle
  readonly source: RlyRelationshipEndpoint
  readonly target: RlyRelationshipEndpoint
  readonly evidence?: string
  readonly actor?: RlyPerson
}

/** Stable, color-independent lifecycle presentation. */
export const RLY_RELATIONSHIP_LIFECYCLE_PRESENTATION = {
  missing: { icon: "alert", label: "Missing" },
  inferred: { icon: "search", label: "Inferred" },
  proposed: { icon: "plus", label: "Proposed" },
  verified: { icon: "check", label: "Verified" },
  governed: { icon: "link", label: "Governed" },
  rejected: { icon: "close", label: "Rejected" },
  superseded: { icon: "arrow-right", label: "Superseded" }
} satisfies Readonly<Record<RlyRelationshipLifecycle, { readonly icon: RlyIconName; readonly label: string }>>

/** Stable direction words and arrows; arrows never carry direction alone. */
export const RLY_RELATIONSHIP_DIRECTION_PRESENTATION = {
  forward: { arrow: "→", label: "Forward" },
  reverse: { arrow: "←", label: "Reverse" },
  bidirectional: { arrow: "↔", label: "Bidirectional" }
} satisfies Readonly<Record<RlyRelationshipDirection, { readonly arrow: string; readonly label: string }>>

const validatePerson = (person: RlyPerson, context: string): void => {
  requireText(person.id, `${context} person id`)
  requireText(person.name, `${context} person name`)
  requireText(person.role, `${context} person role`)
  if (person.avatarFallback !== undefined) requireText(person.avatarFallback, `${context} person avatarFallback`)
  if (person.avatarSrc !== undefined) requireText(person.avatarSrc, `${context} person avatarSrc`)
}

const validateService = (service: RlyService, context: string): void => {
  if (!Object.hasOwn(RLY_SERVICE_MARK_VARIANTS.service, service)) {
    throw new Error(`${context} service must be a supported rly service`)
  }
}

const validateEndpoint = (endpoint: RlyRelationshipEndpoint, context: string): void => {
  if (endpoint.state === "present") {
    requireText(endpoint.id, `${context} id`)
    requireText(endpoint.title, `${context} title`)
    requireText(endpoint.reference, `${context} reference`)
    validateService(endpoint.service, context)
    if (endpoint.href !== undefined) requireText(endpoint.href, `${context} href`)
    if (endpoint.person !== undefined) validatePerson(endpoint.person, context)
    return
  }

  if (endpoint.state === "missing") {
    requireText(endpoint.label, `${context} missing label`)
    requireText(endpoint.reason, `${context} missing reason`)
    if (endpoint.service !== undefined) validateService(endpoint.service, context)
    return
  }

  throw new Error(`${context} state must be present or missing`)
}

/** Validate runtime data without sorting, grouping, or deriving domain meaning. */
export const validateRelationships = (relationships: ReadonlyArray<RlyRelationship>): void => {
  const ids = new Set<string>()
  for (const relationship of relationships) {
    const id = requireText(relationship.id, "Relationship id")
    if (ids.has(id)) throw new Error(`Relationship ids must be unique: ${id}`)
    ids.add(id)
    requireText(relationship.kind, `Relationship kind for ${id}`)
    if (!Object.hasOwn(RLY_RELATIONSHIP_DIRECTION_PRESENTATION, relationship.direction)) {
      throw new Error(`Relationship direction for ${id} must be supported`)
    }
    if (!Object.hasOwn(RLY_RELATIONSHIP_LIFECYCLE_PRESENTATION, relationship.lifecycle)) {
      throw new Error(`Relationship lifecycle for ${id} must be supported`)
    }
    validateEndpoint(relationship.source, `Relationship ${id} source`)
    validateEndpoint(relationship.target, `Relationship ${id} target`)
    if (relationship.evidence !== undefined) requireText(relationship.evidence, `Relationship evidence for ${id}`)
    if (relationship.actor !== undefined) validatePerson(relationship.actor, `Relationship ${id} actor`)
  }
}
