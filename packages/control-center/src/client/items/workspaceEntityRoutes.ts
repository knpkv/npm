import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import {
  EntityId,
  type EntityId as EntityIdType,
  ReleaseId,
  WorkspaceId,
  type WorkspaceId as WorkspaceIdType
} from "../../domain/identifiers.js"

/** Exact in-application location preserved while a canonical entity route is open. */
export interface WorkspaceEntityOrigin {
  readonly hash: string
  readonly pathname: string
  readonly search: string
}

/** Versioned marker merged into router state for one canonical entity activation. */
export interface WorkspaceEntityRouteState {
  readonly entityOrigin: {
    readonly _tag: "entity-origin/v1"
    readonly entityId: EntityIdType
    readonly origin: WorkspaceEntityOrigin
    readonly workspaceId: WorkspaceIdType
  }
}

/** Decoded entity origin plus whether it came from trusted matching history state. */
export interface ResolvedWorkspaceEntityOrigin {
  readonly isStored: boolean
  readonly origin: WorkspaceEntityOrigin
}

/** Decoded target of one exact canonical workspace entity href. */
export interface WorkspaceEntityTarget {
  readonly entityId: EntityIdType
  readonly workspaceId: WorkspaceIdType
}

interface LocationParts {
  readonly hash: string
  readonly pathname: string
  readonly search: string
}

const WorkspaceEntityOriginSchema = Schema.Struct({
  hash: Schema.String,
  pathname: Schema.String,
  search: Schema.String
})

const WorkspaceEntityRouteStateSchema = Schema.Struct({
  entityOrigin: Schema.Struct({
    _tag: Schema.Literal("entity-origin/v1"),
    entityId: EntityId,
    origin: WorkspaceEntityOriginSchema,
    workspaceId: WorkspaceId
  })
})

const segment = (value: string): string => encodeURIComponent(value)

/** Build the workspace-wide normalized delivery item index path. */
export const workspaceEntityParentPath = (workspaceId: WorkspaceIdType): string => `/w/${segment(workspaceId)}/items`

/** Build the canonical full-page path for one normalized workspace entity. */
export const workspaceEntityPath = (workspaceId: WorkspaceIdType, entityId: EntityIdType): string =>
  `${workspaceEntityParentPath(workspaceId)}/${segment(entityId)}`

/** Decode only an exact canonical entity path, rejecting query, hash, and extra path material. */
export const workspaceEntityTargetFromHref = (href: string): WorkspaceEntityTarget | null => {
  if (href.includes("?") || href.includes("#")) return null
  const parts = href.split("/")
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== "w" || parts[3] !== "items") return null
  const workspaceId = Schema.decodeUnknownOption(WorkspaceId)(parts[2])
  const entityId = Schema.decodeUnknownOption(EntityId)(parts[4])
  return Option.isSome(workspaceId) && Option.isSome(entityId)
    ? { entityId: entityId.value, workspaceId: workspaceId.value }
    : null
}

/** Decode one entity route segment at the browser boundary. */
export const decodeEntityRouteId = (value: unknown): EntityIdType | null => {
  const decoded = Schema.decodeUnknownOption(EntityId)(value)
  return Option.isSome(decoded) ? decoded.value : null
}

/** Capture a location without retaining mutable router objects. */
export const entityOriginFromLocation = ({
  hash,
  pathname,
  search
}: LocationParts): WorkspaceEntityOrigin => ({ hash, pathname, search })

const fallbackOrigin = (workspaceId: WorkspaceIdType): WorkspaceEntityOrigin => ({
  hash: "",
  pathname: workspaceEntityParentPath(workspaceId),
  search: ""
})

const isSearch = (search: string): boolean => search.length <= 2_048 && (search.length === 0 || search.startsWith("?"))

const isHash = (hash: string): boolean => hash.length <= 1_024 && (hash.length === 0 || hash.startsWith("#"))

const isReleaseOriginPath = (parts: ReadonlyArray<string>, workspaceId: WorkspaceIdType): boolean => {
  if (parts.length !== 5 && parts.length !== 6) return false
  if (parts[0] !== "" || parts[1] !== "w" || parts[2] !== workspaceId || parts[3] !== "releases") return false
  const releaseId = Schema.decodeUnknownOption(ReleaseId)(parts[4])
  if (Option.isNone(releaseId)) return false
  return parts.length === 5 || parts[5] === "preview"
}

const isRecognizedOriginPath = (pathname: string, workspaceId: WorkspaceIdType): boolean => {
  if (pathname.length > 2_048) return false
  const parts = pathname.split("/")
  if (parts[0] !== "" || parts[1] !== "w" || parts[2] !== workspaceId) return false
  if (parts.length === 4) return ["overview", "work", "items", "timeline"].includes(parts[3] ?? "")
  return isReleaseOriginPath(parts, workspaceId)
}

/** Confirm an origin is bounded and belongs to a supported page in the exact workspace. */
export const isSafeWorkspaceEntityOrigin = (
  origin: WorkspaceEntityOrigin,
  workspaceId: WorkspaceIdType
): boolean => isRecognizedOriginPath(origin.pathname, workspaceId) && isSearch(origin.search) && isHash(origin.hash)

const reusableStoredOrigin = (
  state: unknown,
  workspaceId: WorkspaceIdType
): WorkspaceEntityOrigin | null => {
  const decoded = Schema.decodeUnknownOption(WorkspaceEntityRouteStateSchema)(state)
  if (Option.isNone(decoded)) return null
  const marker = decoded.value.entityOrigin
  return marker.workspaceId === workspaceId && isSafeWorkspaceEntityOrigin(marker.origin, workspaceId)
    ? marker.origin
    : null
}

/**
 * Merge a bounded entity marker into existing router state.
 *
 * A previously validated entity origin is carried through related-entity navigation so the
 * shell's explicit Back action still returns to the root activation surface.
 */
export const makeWorkspaceEntityRouteState = (
  state: unknown,
  workspaceId: WorkspaceIdType,
  entityId: EntityIdType,
  origin: WorkspaceEntityOrigin
): WorkspaceEntityRouteState => ({
  ...(Predicate.isObject(state) ? state : {}),
  entityOrigin: {
    _tag: "entity-origin/v1",
    entityId,
    origin: reusableStoredOrigin(state, workspaceId) ??
      (isSafeWorkspaceEntityOrigin(origin, workspaceId) ? origin : fallbackOrigin(workspaceId)),
    workspaceId
  }
})

/** Decode safe history state for the exact workspace/entity pair or use the Items parent. */
export const resolveWorkspaceEntityOrigin = (
  state: unknown,
  workspaceId: WorkspaceIdType,
  entityId: EntityIdType
): ResolvedWorkspaceEntityOrigin => {
  const fallback = fallbackOrigin(workspaceId)
  const decoded = Schema.decodeUnknownOption(WorkspaceEntityRouteStateSchema)(state)
  if (Option.isNone(decoded)) return { isStored: false, origin: fallback }
  const marker = decoded.value.entityOrigin
  return marker.workspaceId === workspaceId &&
      marker.entityId === entityId &&
      isSafeWorkspaceEntityOrigin(marker.origin, workspaceId)
    ? { isStored: true, origin: marker.origin }
    : { isStored: false, origin: fallback }
}

/** Serialize an exact validated origin for React Router navigation. */
export const workspaceEntityOriginHref = ({
  hash,
  pathname,
  search
}: WorkspaceEntityOrigin): string => `${pathname}${search}${hash}`
