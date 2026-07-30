import type { WorkspacePresentationReadModel, WorkspaceSettingsReadModel } from "../../api/workspaceSettings.js"

type WorkspaceSettingsListener = (settings: WorkspaceSettingsReadModel) => void
type WorkspacePresentationListener = (settings: WorkspacePresentationReadModel) => void

const listeners = new Set<WorkspaceSettingsListener>()
const presentationListeners = new Set<WorkspacePresentationListener>()

/** Notify mounted workspace consumers after an authoritative settings read or save. */
export const publishWorkspaceSettings = (settings: WorkspaceSettingsReadModel): void => {
  for (const listener of listeners) listener(settings)
  publishWorkspacePresentation({
    workspaceId: settings.workspaceId,
    revision: settings.revision,
    presentation: settings.settings.presentation
  })
}

/** Notify every collaborator-facing presentation consumer without exposing governed settings. */
export const publishWorkspacePresentation = (
  settings: WorkspacePresentationReadModel
): void => {
  for (const listener of presentationListeners) listener(settings)
}

/** Subscribe to authoritative settings changes without coupling route-level hooks. */
export const subscribeWorkspaceSettings = (
  listener: WorkspaceSettingsListener
): () => void => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Subscribe to the safe presentation projection shared across workspace roles. */
export const subscribeWorkspacePresentation = (
  listener: WorkspacePresentationListener
): () => void => {
  presentationListeners.add(listener)
  return () => presentationListeners.delete(listener)
}
