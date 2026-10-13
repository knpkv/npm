import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"

import type { PluginConnectionSummary } from "../../api/plugins.js"
import { PluginHealth } from "../../domain/freshness.js"
import type { PluginConnectionId } from "../../domain/identifiers.js"

const detailToken = (connection: PluginConnectionSummary): string =>
  JSON.stringify([
    DateTime.formatIso(connection.updatedAt),
    connection.runtimeRevision ??
      (connection.health === null ? null : Schema.encodeSync(PluginHealth)(connection.health)),
    connection.isEnabled,
    connection.supportsSynchronization
  ])

/** Compare each connection's own server token, retaining unrelated in-flight and cached reads. */
export const makeConnectionDetailTracker = () => {
  const tokens = new Map<PluginConnectionId, string>()
  return {
    reconcile: (connections: ReadonlyArray<PluginConnectionSummary>) => {
      const ids = new Set(connections.map(({ pluginConnectionId }) => pluginConnectionId))
      const removed = [...tokens.keys()].filter((id) => !ids.has(id))
      for (const id of removed) tokens.delete(id)
      const changed = connections.filter((connection) => {
        const token = detailToken(connection)
        const previous = tokens.get(connection.pluginConnectionId)
        tokens.set(connection.pluginConnectionId, token)
        return token !== previous
      })
      return { changed, removed }
    },
    failed: (id: PluginConnectionId): void => {
      tokens.delete(id)
    },
    reset: (): void => tokens.clear()
  }
}
