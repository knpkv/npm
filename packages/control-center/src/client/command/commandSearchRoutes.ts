import type { EntityId, WorkspaceId } from "../../domain/identifiers.js"
import { workspaceItemsPath } from "../releases/releasePaths.js"

const searchParameters = (query: string): URLSearchParams => {
  const parameters = new URLSearchParams()
  const normalized = query.trim()
  if (normalized.length > 0) parameters.set("q", normalized)
  return parameters
}

/** Open the workspace Items route with the exact command-search text. */
export const commandSearchItemsHref = (workspaceId: WorkspaceId, query: string): string => {
  const parameters = searchParameters(query)
  const search = parameters.size === 0 ? "" : `?${parameters.toString()}`
  return `${workspaceItemsPath(workspaceId)}${search}#results`
}

/** Open one command-search result without inventing a release membership. */
export const commandSearchItemHref = (
  workspaceId: WorkspaceId,
  entityId: EntityId
): string => `${workspaceItemsPath(workspaceId)}/${encodeURIComponent(entityId)}`
