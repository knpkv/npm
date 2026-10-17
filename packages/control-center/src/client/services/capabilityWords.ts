import type { PluginConnectionPermission } from "../../api/plugins.js"
import type { PluginCapabilityId } from "../../domain/plugins/descriptor.js"

/**
 * Each negotiated provider operation in words a person reads on the connection card. A total record, so a new
 * capability can't ship without its words.
 */
export const capabilityWords = {
  "entity.read": "read items",
  "sync.incremental": "sync changes",
  "action.propose": "propose changes",
  "action.execute": "apply approved changes",
  "action.cancel": "cancel changes",
  "action.reconcile": "confirm applied changes",
  "diff.inventory": "list changed files",
  "diff.content": "read file changes",
  "pipeline.logs": "read pipeline logs",
  "pipeline.artifact": "read pipeline artifacts"
} satisfies Readonly<Record<PluginCapabilityId, string>>

const sentence = (permissions: ReadonlyArray<PluginConnectionPermission>): string | null => {
  const words = [...new Set(permissions.map(({ capabilityId }) => capabilityWords[capabilityId]))].join(", ")
  return words.length === 0 ? null : `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}`
}

/** What a connection can do and what is turned off, each as one sentence, or null when there is none. */
export interface PermissionSummary {
  readonly available: string | null
  readonly disabled: string | null
}

export const permissionSummary = (permissions: ReadonlyArray<PluginConnectionPermission>): PermissionSummary => ({
  available: sentence(permissions.filter(({ state }) => state === "available")),
  disabled: sentence(permissions.filter(({ state }) => state === "disabled"))
})
