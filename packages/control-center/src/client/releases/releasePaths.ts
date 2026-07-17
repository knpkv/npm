import type { ReleaseId, WorkspaceId } from "../../domain/identifiers.js"

const segment = (value: string): string => encodeURIComponent(value)

/** Build the semantic parent for release routes in one workspace. */
export const releaseParentPath = (workspaceId: WorkspaceId): string => `/w/${segment(workspaceId)}/overview`

/** Build the workspace-wide normalized delivery item index path. */
export const workspaceItemsPath = (workspaceId: WorkspaceId): string => `/w/${segment(workspaceId)}/items`

/** Build the workspace review queue with one release selected. */
export const releaseActiveWorkPath = (workspaceId: WorkspaceId, releaseId: ReleaseId): string =>
  `/w/${segment(workspaceId)}/work?release=${segment(releaseId)}`

/** Build the canonical preview route for one immutable release identity. */
export const releasePreviewPath = (workspaceId: WorkspaceId, releaseId: ReleaseId): string =>
  `/w/${segment(workspaceId)}/releases/${segment(releaseId)}/preview`

/** Build the canonical full route for one immutable release identity. */
export const releaseFullPath = (workspaceId: WorkspaceId, releaseId: ReleaseId): string =>
  `/w/${segment(workspaceId)}/releases/${segment(releaseId)}`

/** Build the canonical release-owned agent thread route. */
export const releaseAgentPath = (workspaceId: WorkspaceId, releaseId: ReleaseId): string =>
  `/w/${segment(workspaceId)}/releases/${segment(releaseId)}/agent`
