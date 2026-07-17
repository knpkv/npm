import type { ReleaseId, WorkspaceId } from "../domain/identifiers.js"
import { releaseAgentPath } from "./releases/releasePaths.js"

const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/** Narrow one route segment to the canonical workspace identity used by browser paths. */
export const isWorkspaceRouteId = (value: string | undefined): value is WorkspaceId =>
  value !== undefined && CANONICAL_ID.test(value)

const isReleaseRouteId = (value: string | undefined): value is ReleaseId =>
  value !== undefined && CANONICAL_ID.test(value)

/** Route Relay to an exact release thread when possible, otherwise preserve the complete calling page. */
export const contextualAgentPath = (pathname: string, search: string, hash = ""): string => {
  const segments = pathname.split("/")
  const workspaceId = segments[2]
  const releaseId = segments[4]
  if (
    segments[1] === "w" &&
    isWorkspaceRouteId(workspaceId) &&
    segments[3] === "releases" &&
    isReleaseRouteId(releaseId)
  ) {
    return releaseAgentPath(workspaceId, releaseId)
  }
  const activeWorkReleaseId = new URLSearchParams(search).get("release") ?? undefined
  if (
    segments[1] === "w" &&
    isWorkspaceRouteId(workspaceId) &&
    segments[3] === "work" &&
    isReleaseRouteId(activeWorkReleaseId)
  ) {
    return releaseAgentPath(workspaceId, activeWorkReleaseId)
  }
  return `/agent?from=${encodeURIComponent(`${pathname}${search}${hash}`)}`
}
