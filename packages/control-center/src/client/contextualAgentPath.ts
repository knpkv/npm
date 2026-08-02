import type { ReleaseId, WorkspaceId } from "../domain/identifiers.js"
import { releaseAgentPath } from "./releases/releasePaths.js"

const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/** Narrow one route segment to the canonical workspace identity used by browser paths. */
export const isWorkspaceRouteId = (value: string | undefined): value is WorkspaceId =>
  value !== undefined && CANONICAL_ID.test(value)

const isReleaseRouteId = (value: string | undefined): value is ReleaseId =>
  value !== undefined && CANONICAL_ID.test(value)

/** Build an exact release-agent destination while preserving the page that opened Relay. */
export const contextualReleaseAgentPath = (
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  originPath: string
): string => `${releaseAgentPath(workspaceId, releaseId)}?from=${encodeURIComponent(originPath)}`

/** Route Relay to an exact release thread when possible, otherwise preserve the complete calling page. */
export const contextualAgentPath = (pathname: string, search: string, hash = ""): string => {
  const segments = pathname.split("/")
  const workspaceId = segments[2]
  const releaseId = segments[4]
  if (
    segments[1] === "w" &&
    isWorkspaceRouteId(workspaceId) &&
    segments[3] === "releases" &&
    isReleaseRouteId(releaseId) &&
    segments[5] === "agent"
  ) {
    return `${pathname}${search}${hash}`
  }
  if (
    segments[1] === "w" &&
    isWorkspaceRouteId(workspaceId) &&
    segments[3] === "releases" &&
    isReleaseRouteId(releaseId)
  ) {
    return contextualReleaseAgentPath(workspaceId, releaseId, `${pathname}${search}${hash}`)
  }
  const activeWorkReleaseId = new URLSearchParams(search).get("release") ?? undefined
  if (
    segments[1] === "w" &&
    isWorkspaceRouteId(workspaceId) &&
    segments[3] === "work" &&
    isReleaseRouteId(activeWorkReleaseId)
  ) {
    return contextualReleaseAgentPath(workspaceId, activeWorkReleaseId, `${pathname}${search}${hash}`)
  }
  return `/agent?from=${encodeURIComponent(`${pathname}${search}${hash}`)}`
}
