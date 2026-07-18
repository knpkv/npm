import type { PluginConnectionSummary, PluginConnectionTestResult } from "../../api/plugins.js"

export type ConnectionTestState =
  | { readonly _tag: "testing" }
  | { readonly _tag: "result"; readonly result: PluginConnectionTestResult }
  | { readonly _tag: "request-failed" }

export type ConnectionEnablementState = "changing" | "request-failed"

/** Present durable and freshly tested connection state with one consistent vocabulary. */
export const connectionStatus = (
  connection: PluginConnectionSummary,
  testState: ConnectionTestState | undefined
): { readonly label: string; readonly tone: "neutral" | "positive" | "critical" | "caution" | "progress" } => {
  if (!connection.isEnabled) return { label: "Disabled", tone: "neutral" }
  if (testState?._tag === "testing") return { label: "Checking", tone: "progress" }
  if (testState?._tag === "result") {
    return testState.result._tag === "healthy"
      ? { label: "Healthy", tone: "positive" }
      : { label: "Unavailable", tone: "critical" }
  }
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
