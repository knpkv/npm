import type { EntityId, WorkspaceId } from "../domain/identifiers.js"

const segment = (value: string): string => encodeURIComponent(value)

/** Build the workspace-wide normalized delivery item index path. */
export const workspaceEntityParentPath = (workspaceId: WorkspaceId): string => `/w/${segment(workspaceId)}/items`

/** Build the canonical full-page path for one normalized workspace entity. */
export const workspaceEntityPath = (workspaceId: WorkspaceId, entityId: EntityId): string =>
  `${workspaceEntityParentPath(workspaceId)}/${segment(entityId)}`
