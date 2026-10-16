import { Schema } from "effect"
import type { AgentTaskKind } from "./model.js"

/** Normalized host-private evidence. Adapters decode their source before classifying it. */
export const AgentTaskFacts = Schema.Struct({
  status: Schema.String,
  activity: Schema.optionalKey(Schema.Struct({
    kind: Schema.Literals(["read", "search", "edit", "write", "test", "build", "wait", "other", "unknown"]),
    outcome: Schema.Literals(["running", "succeeded", "failed", "unknown"])
  })),
  ci: Schema.optionalKey(Schema.Literals(["pending", "passed", "failed", "unknown"])),
  review: Schema.optionalKey(Schema.Literals(["pending", "complete", "unknown"]))
})
export type AgentTaskFacts = typeof AgentTaskFacts.Type

/** Classifies supported evidence only; ordinary command failures never imply failing. */
export const classifyAgentTask = (facts: AgentTaskFacts): AgentTaskKind => {
  if (facts.status === "blocked") return "blocked"

  const activity = facts.status === "working" ? facts.activity : undefined
  const testOrBuild = activity?.kind === "test" || activity?.kind === "build"
  if (facts.ci === "failed" || (testOrBuild && activity?.outcome === "failed")) return "failing"
  if (activity?.outcome === "running") {
    switch (activity.kind) {
      case "read":
      case "search":
        return "reading"
      case "edit":
      case "write":
        return "writing"
      case "test":
      case "build":
        return "testing"
      // A running sleep or timer call: the agent is waiting on something, not working.
      case "wait":
        return "waiting"
    }
  }
  if (facts.ci === "pending" || facts.review === "pending") return "waiting"
  if (facts.status === "done") return "done"
  if (facts.status === "idle") return "idle"
  return "unknown"
}
