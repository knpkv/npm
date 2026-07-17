import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type { NavigateFunction } from "react-router"

import {
  EntityId,
  type EntityId as EntityIdType,
  RelationshipId,
  type RelationshipId as RelationshipIdType
} from "../../domain/identifiers.js"

const RelationshipDetailMarker = Schema.Struct({
  _tag: Schema.Literal("relationship-detail-origin/v1"),
  objectId: EntityId,
  relationshipId: RelationshipId
})

const RelationshipDetailRouteState = Schema.Struct({
  relationshipDetailOrigin: RelationshipDetailMarker
})

/** Preserve existing release-origin state while marking an in-app relationship-detail activation. */
export const makeRelationshipDetailRouteState = (
  state: unknown,
  objectId: EntityIdType,
  relationshipId: RelationshipIdType
): unknown => ({
  ...(Predicate.isObject(state) ? state : {}),
  relationshipDetailOrigin: {
    _tag: "relationship-detail-origin/v1",
    objectId,
    relationshipId
  }
})

/** Accept Back navigation only for the exact versioned object/relationship activation. */
export const matchesRelationshipDetailRouteState = (
  state: unknown,
  objectId: EntityIdType,
  relationshipId: RelationshipIdType
): boolean => {
  const decoded = Schema.decodeUnknownOption(RelationshipDetailRouteState)(state)
  return Option.isSome(decoded) &&
    decoded.value.relationshipDetailOrigin.objectId === objectId &&
    decoded.value.relationshipDetailOrigin.relationshipId === relationshipId
}

/** Close an in-app detail with Back; canonicalize direct detail URLs in place. */
export const closeRelationshipDetailRoute = (
  navigate: NavigateFunction,
  location: Readonly<{ hash: string; pathname: string; search: string; state: unknown }>,
  objectId: EntityIdType,
  relationshipId: RelationshipIdType
): void => {
  if (matchesRelationshipDetailRouteState(location.state, objectId, relationshipId)) {
    navigate(-1)
    return
  }
  const next = new URLSearchParams(location.search)
  next.delete("relationship")
  navigate(
    { hash: location.hash, pathname: location.pathname, search: next.size === 0 ? "" : `?${next.toString()}` },
    { replace: true, state: location.state }
  )
}
