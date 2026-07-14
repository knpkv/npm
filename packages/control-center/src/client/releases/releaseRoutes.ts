import type { RlyReleaseTransitionNames } from "@knpkv/rly/patterns"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import {
  ReleaseId,
  type ReleaseId as ReleaseIdType,
  WorkspaceId,
  type WorkspaceId as WorkspaceIdType
} from "../../domain/identifiers.js"

/** Exact in-application location preserved while release routes are open. */
export interface ReleaseOrigin {
  readonly hash: string
  readonly pathname: string
  readonly search: string
}

/** Router state carried from a release activation through preview and full view. */
export interface ReleaseRouteState {
  readonly _tag: "release-origin/v1"
  readonly origin: ReleaseOrigin
  readonly releaseId: ReleaseIdType
  readonly workspaceId: WorkspaceIdType
}

/** Decoded release origin plus whether it came from trusted versioned history state. */
export interface ResolvedReleaseOrigin {
  readonly isStored: boolean
  readonly origin: ReleaseOrigin
}

interface LocationParts {
  readonly hash: string
  readonly pathname: string
  readonly search: string
}

const ReleaseOriginSchema = Schema.Struct({
  hash: Schema.String,
  pathname: Schema.String,
  search: Schema.String
})

const ReleaseRouteStateSchema = Schema.Struct({
  _tag: Schema.Literal("release-origin/v1"),
  origin: ReleaseOriginSchema,
  releaseId: ReleaseId,
  workspaceId: WorkspaceId
})

const segment = (value: string): string => encodeURIComponent(value)

/** Decode one workspace route segment at the browser boundary. */
export const decodeWorkspaceRouteId = (value: unknown): WorkspaceIdType | null => {
  const decoded = Schema.decodeUnknownOption(WorkspaceId)(value)
  return Option.isSome(decoded) ? decoded.value : null
}

/** Decode one release route segment at the browser boundary. */
export const decodeReleaseRouteId = (value: unknown): ReleaseIdType | null => {
  const decoded = Schema.decodeUnknownOption(ReleaseId)(value)
  return Option.isSome(decoded) ? decoded.value : null
}

/** Build the semantic parent for release routes in one workspace. */
export const releaseParentPath = (workspaceId: WorkspaceIdType): string => `/w/${segment(workspaceId)}/overview`

/** Build the canonical preview route for one immutable release identity. */
export const releasePreviewPath = (workspaceId: WorkspaceIdType, releaseId: ReleaseIdType): string =>
  `/w/${segment(workspaceId)}/releases/${segment(releaseId)}/preview`

/** Build the canonical full route for one immutable release identity. */
export const releaseFullPath = (workspaceId: WorkspaceIdType, releaseId: ReleaseIdType): string =>
  `/w/${segment(workspaceId)}/releases/${segment(releaseId)}`

/** Stable, collision-free geometry names for one release's orchestrated route transition. */
export const releaseTransitionNames = (releaseId: ReleaseIdType): RlyReleaseTransitionNames => ({
  relay: `release-${releaseId}-relay`,
  verdict: `release-${releaseId}-verdict`,
  version: `release-${releaseId}-version`
})

/** Capture a location without retaining mutable router objects. */
export const releaseOriginFromLocation = ({ hash, pathname, search }: LocationParts): ReleaseOrigin => ({
  hash,
  pathname,
  search
})

const isSearch = (search: string): boolean => search.length <= 2_048 && (search.length === 0 || search.startsWith("?"))

const isHash = (hash: string): boolean => hash.length <= 1_024 && (hash.length === 0 || hash.startsWith("#"))

/** Construct bounded route state without retaining session or snapshot data. */
export const makeReleaseRouteState = (
  workspaceId: WorkspaceIdType,
  releaseId: ReleaseIdType,
  origin: ReleaseOrigin
): ReleaseRouteState => ({ _tag: "release-origin/v1", origin, releaseId, workspaceId })

/** Decode history state without permitting external or malformed navigation targets. */
export const resolveReleaseOrigin = (
  state: unknown,
  workspaceId: WorkspaceIdType,
  releaseId: ReleaseIdType
): ResolvedReleaseOrigin => {
  const fallback = { hash: "", pathname: releaseParentPath(workspaceId), search: "" }
  const decoded = Schema.decodeUnknownOption(ReleaseRouteStateSchema)(state)
  if (Option.isNone(decoded)) return { isStored: false, origin: fallback }
  const routeState = decoded.value
  const isMatchingTarget = routeState.workspaceId === workspaceId && routeState.releaseId === releaseId
  const isRecognizedOrigin = routeState.origin.pathname === releaseParentPath(workspaceId)
  return isMatchingTarget && isRecognizedOrigin && isSearch(routeState.origin.search) && isHash(routeState.origin.hash)
    ? { isStored: true, origin: routeState.origin }
    : { isStored: false, origin: fallback }
}

/** Decode the exact safe origin or return the release's semantic parent. */
export const readReleaseOrigin = (
  state: unknown,
  workspaceId: WorkspaceIdType,
  releaseId: ReleaseIdType
): ReleaseOrigin => resolveReleaseOrigin(state, workspaceId, releaseId).origin

/** Serialize an exact origin for React Router navigation. */
export const releaseOriginHref = ({ hash, pathname, search }: ReleaseOrigin): string => `${pathname}${search}${hash}`
