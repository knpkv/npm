import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import {
  EntityId,
  type EntityId as EntityIdType,
  ReleaseId,
  type ReleaseId as ReleaseIdType,
  WorkspaceId,
  type WorkspaceId as WorkspaceIdType
} from "../../domain/identifiers.js"
import { contextualAgentPath } from "../contextualAgentPath.js"
import { releaseAgentPath } from "../releases/releasePaths.js"
import { type ReleaseRouteState, ReleaseRouteStateSchema, retainReleaseRouteState } from "../releases/releaseRoutes.js"
import { workspaceEntityParentPath } from "../workspaceEntityPaths.js"

export { workspaceEntityParentPath, workspaceEntityPath } from "../workspaceEntityPaths.js"

/** Exact in-application location preserved while a canonical entity route is open. */
export interface WorkspaceEntityOrigin {
  readonly hash: string
  readonly pathname: string
  readonly search: string
  readonly state: ReleaseRouteState | null
}

/** Versioned, bounded router state for one canonical entity activation. */
export interface WorkspaceEntityRouteState {
  readonly entityOrigin: {
    readonly _tag: "entity-origin/v2"
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

/** Release membership evidence used to select an unambiguous entity-owned agent thread. */
export interface WorkspaceEntityReleaseContext {
  readonly canonicalReleaseId: ReleaseIdType | null
  readonly releaseIds: ReadonlyArray<ReleaseIdType>
  readonly releaseMembershipsTruncated: boolean
}

interface LocationParts {
  readonly hash: string
  readonly pathname: string
  readonly search: string
  readonly state?: unknown
}

const WorkspaceEntityOriginSchema = Schema.Struct({
  hash: Schema.String,
  pathname: Schema.String,
  search: Schema.String,
  state: Schema.NullOr(ReleaseRouteStateSchema)
})

const WorkspaceEntityRouteStateSchema = Schema.Struct({
  entityOrigin: Schema.Struct({
    _tag: Schema.Literal("entity-origin/v2"),
    entityId: EntityId,
    origin: WorkspaceEntityOriginSchema,
    workspaceId: WorkspaceId
  })
})

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

const fallbackOrigin = (workspaceId: WorkspaceIdType): WorkspaceEntityOrigin => ({
  hash: "",
  pathname: workspaceEntityParentPath(workspaceId),
  search: "",
  state: null
})

const isSearch = (search: string): boolean => search.length <= 2_048 && (search.length === 0 || search.startsWith("?"))

const isHash = (hash: string): boolean => hash.length <= 1_024 && (hash.length === 0 || hash.startsWith("#"))

const releaseOriginTarget = (
  parts: ReadonlyArray<string>,
  workspaceId: WorkspaceIdType
): { readonly releaseId: ReleaseIdType; readonly workspaceId: WorkspaceIdType } | null => {
  if (parts.length !== 5 && parts.length !== 6) return null
  if (parts[0] !== "" || parts[1] !== "w" || parts[2] !== workspaceId || parts[3] !== "releases") return null
  const releaseId = Schema.decodeUnknownOption(ReleaseId)(parts[4])
  if (Option.isNone(releaseId) || (parts.length === 6 && parts[5] !== "preview")) return null
  return { releaseId: releaseId.value, workspaceId }
}

const isRecognizedOriginPath = (pathname: string, workspaceId: WorkspaceIdType): boolean => {
  if (pathname.length > 2_048) return false
  const parts = pathname.split("/")
  if (parts[0] !== "" || parts[1] !== "w" || parts[2] !== workspaceId) return false
  if (parts.length === 4) return ["overview", "work", "items", "timeline"].includes(parts[3] ?? "")
  return releaseOriginTarget(parts, workspaceId) !== null
}

/** Capture an exact location while retaining only matching, bounded release origin state. */
export const entityOriginFromLocation = ({
  hash,
  pathname,
  search,
  state
}: LocationParts): WorkspaceEntityOrigin => {
  const workspaceId = Schema.decodeUnknownOption(WorkspaceId)(pathname.split("/")[2])
  const target = Option.isSome(workspaceId) ? releaseOriginTarget(pathname.split("/"), workspaceId.value) : null
  return {
    hash,
    pathname,
    search,
    state: target === null ? null : retainReleaseRouteState(state, target.workspaceId, target.releaseId)
  }
}

/** Confirm an origin is bounded and belongs to a supported page in the exact workspace. */
export const isSafeWorkspaceEntityOrigin = (
  origin: WorkspaceEntityOrigin,
  workspaceId: WorkspaceIdType
): boolean => {
  if (!isRecognizedOriginPath(origin.pathname, workspaceId) || !isSearch(origin.search) || !isHash(origin.hash)) {
    return false
  }
  if (origin.state === null) return true
  const target = releaseOriginTarget(origin.pathname.split("/"), workspaceId)
  return target !== null && retainReleaseRouteState(origin.state, workspaceId, target.releaseId) !== null
}

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
 * Construct bounded entity route state.
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
  entityOrigin: {
    _tag: "entity-origin/v2",
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

/** Resolve a release-owned agent thread only when the stored origin is an exact release route. */
export const workspaceEntityOriginAgentPath = (
  origin: WorkspaceEntityOrigin,
  workspaceId: WorkspaceIdType,
  routableReleaseIds: ReadonlySet<ReleaseIdType>
): string | null => {
  const target = releaseOriginTarget(origin.pathname.split("/"), workspaceId)
  return target === null || !routableReleaseIds.has(target.releaseId)
    ? null
    : releaseAgentPath(target.workspaceId, target.releaseId)
}

/** Keep entity actions in a release-owned thread, falling back to the current-page context. */
export const workspaceEntityAgentPath = (
  origin: WorkspaceEntityOrigin,
  workspaceId: WorkspaceIdType,
  current: Pick<LocationParts, "hash" | "pathname" | "search">,
  releaseContext: WorkspaceEntityReleaseContext,
  routableReleaseIds: ReadonlySet<ReleaseIdType>
): string => {
  const originRelease = releaseOriginTarget(origin.pathname.split("/"), workspaceId)
  const canonicalReleaseId = releaseContext.canonicalReleaseId
  const releasePath = originRelease === null
    ? releaseContext.releaseMembershipsTruncated ||
        releaseContext.releaseIds.length !== 1 ||
        releaseContext.releaseIds[0] !== canonicalReleaseId ||
        canonicalReleaseId === null ||
        !routableReleaseIds.has(canonicalReleaseId)
      ? null
      : releaseAgentPath(workspaceId, canonicalReleaseId)
    : !releaseContext.releaseMembershipsTruncated &&
        releaseContext.releaseIds.includes(originRelease.releaseId) &&
        routableReleaseIds.has(originRelease.releaseId)
    ? releaseAgentPath(workspaceId, originRelease.releaseId)
    : null
  if (releasePath !== null) return releasePath

  const entity = workspaceEntityTargetFromHref(current.pathname)
  if (entity === null || entity.workspaceId !== workspaceId) {
    return contextualAgentPath(current.pathname, current.search, current.hash)
  }
  const itemSearch = new URLSearchParams(
    origin.pathname === workspaceEntityParentPath(workspaceId) ? origin.search : ""
  )
  itemSearch.set("object", entity.entityId)
  return contextualAgentPath(
    workspaceEntityParentPath(workspaceId),
    `?${itemSearch.toString()}`,
    "#item-details"
  )
}
