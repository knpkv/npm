import type { WorkspaceSettingsReadModel } from "../../api/workspaceSettings.js"

type WorkspaceSettingsListener = (settings: WorkspaceSettingsReadModel) => void

const listeners = new Set<WorkspaceSettingsListener>()

/** Notify mounted workspace consumers after an authoritative settings read or save. */
export const publishWorkspaceSettings = (settings: WorkspaceSettingsReadModel): void => {
  for (const listener of listeners) listener(settings)
}

/** Subscribe to authoritative settings changes without coupling route-level hooks. */
export const subscribeWorkspaceSettings = (
  listener: WorkspaceSettingsListener
): () => void => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
