import type { RlyStateTone } from "@knpkv/rly/primitives"
import type { PluginConnectionSummary, PluginConnectionTestResult } from "../../api/plugins.js"
import type { ConnectionSynchronizationViewState } from "./ConnectionSynchronization.js"

export type ConnectionTestState =
  | { readonly _tag: "testing" }
  | { readonly _tag: "result"; readonly result: PluginConnectionTestResult }
  | { readonly _tag: "request-failed" }

export type ConnectionEnablementState = "changing" | "request-failed"

export interface ConnectionStatusPresentation {
  readonly label: string
  readonly tone: RlyStateTone
}

/**
 * Present durable and freshly tested connection state with one consistent vocabulary. For a
 * connection that syncs, health is not data: until its first sync succeeds it reads "Not synced yet"
 * (or "Syncing…", or "Sync failed"), never "Healthy".
 */
export const connectionStatus = (
  connection: PluginConnectionSummary,
  testState: ConnectionTestState | undefined,
  synchronization?: ConnectionSynchronizationViewState | undefined
): ConnectionStatusPresentation => {
  if (!connection.isEnabled) return { label: "Disabled", tone: "neutral" }
  if (testState?._tag === "testing") return { label: "Checking", tone: "progress" }
  if (testState?._tag === "result" && testState.result._tag !== "healthy") {
    return { label: "Unavailable", tone: "critical" }
  }
  const sync = connection.supportsSynchronization ? syncStatus(synchronization) : undefined
  if (sync !== undefined) return sync
  if (testState?._tag === "result") return { label: "Healthy", tone: "positive" }
  if (connection.health === null) return { label: "Not checked", tone: "neutral" }
  switch (connection.health._tag) {
    case "healthy":
      return { label: "Healthy", tone: "positive" }
    case "degraded":
      return { label: "Degraded", tone: "caution" }
    case "unavailable":
      return { label: "Unavailable", tone: "critical" }
    case "disabled":
      return { label: "Not checked", tone: "neutral" }
  }
}

/**
 * The sync state that outranks health, or nothing once a sync has succeeded. State that hasn't
 * loaded or couldn't be read is no proof of data, so it never falls through to "Healthy".
 */
const syncStatus = (
  synchronization: ConnectionSynchronizationViewState | undefined
): ConnectionStatusPresentation | undefined => {
  if (synchronization === undefined || synchronization._tag === "loading") {
    return { label: "Checking sync…", tone: "neutral" }
  }
  if (synchronization._tag === "failed") return { label: "Sync state unknown", tone: "neutral" }
  if (synchronization._tag === "syncing") return { label: "Syncing…", tone: "progress" }
  switch (synchronization.synchronization.result) {
    case "never":
      return { label: "Not synced yet", tone: "neutral" }
    case "running":
      return { label: "Syncing…", tone: "progress" }
    case "source-unavailable":
    case "interrupted":
      return { label: "Sync failed", tone: "critical" }
    case "synchronized":
      return undefined
  }
}
