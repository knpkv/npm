import type { PluginConnectionPermission } from "../../api/plugins.js"
import type { PluginCapabilityId } from "../../domain/plugins/descriptor.js"

/**
 * Each operation the connection's adapter negotiated, in words a person reads on the connection card. These are
 * what Control Center uses, not what the account's own permissions allow. A total record, so a new capability
 * can't ship without its words.
 */
export const capabilityWords = {
  "entity.read": "read items",
  "sync.incremental": "sync changes",
  "action.propose": "propose changes",
  "action.execute": "apply approved changes",
  "action.cancel": "cancel pending changes",
  "action.reconcile": "check whether changes were applied",
  "diff.inventory": "list changed files",
  "diff.content": "read file changes",
  "pipeline.logs": "read pipeline logs",
  "pipeline.artifact": "read pipeline artifacts"
} satisfies Readonly<Record<PluginCapabilityId, string>>

const sentence = (permissions: ReadonlyArray<PluginConnectionPermission>): string | null => {
  const words = [...new Set(permissions.map(({ capabilityId }) => capabilityWords[capabilityId]))].join(", ")
  return words.length === 0 ? null : `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}`
}

/**
 * The connection's operations as one sentence (null when none were negotiated), and whether they are paused.
 * Availability follows the connection's own on/off switch, so the operations pause together, never one by one.
 */
export interface PermissionSummary {
  readonly operations: string | null
  readonly paused: boolean
}

export const permissionSummary = (permissions: ReadonlyArray<PluginConnectionPermission>): PermissionSummary => ({
  operations: sentence(permissions),
  paused: permissions.length > 0 && permissions.every(({ state }) => state === "disabled")
})
