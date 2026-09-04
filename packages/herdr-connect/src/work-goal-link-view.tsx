import type { ReactElement } from "react"
import type { ConnectAgent } from "./model.js"
import type { ConnectWorkGoalResolution } from "./work-goal-link.js"

export const ConnectAgentIdentity = ({
  agent,
  resolution
}: {
  readonly agent: ConnectAgent
  readonly resolution: ConnectWorkGoalResolution
}): ReactElement => (
  <div className="connect-agent-identity" data-work-goal-state={resolution._tag}>
    {resolution._tag === "available" ? (
      <a
        aria-label={`${agent.name} · Work goal ${resolution.title}`}
        className="connect-agent-work-link"
        href={resolution.href}
      >
        <strong>{agent.name}</strong>
      </a>
    ) : (
      <strong>{agent.name}</strong>
    )}
    {resolution._tag === "available" ? (
      <small>Work goal · {resolution.title}</small>
    ) : resolution._tag === "ambiguous" ? (
      <small role="status">Work goal unavailable · multiple Work goals</small>
    ) : resolution._tag === "missing" ? (
      <small role="status">Work goal unavailable · no associated goal</small>
    ) : (
      <small role="status">Work goal unavailable · snapshot unavailable</small>
    )}
  </div>
)
