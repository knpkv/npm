/**
 * An agent's stage and the cast strip that opens it: the character large on a field in its own hues, its
 * work as what it is saying, quiet details, and the way into its terminal.
 *
 * A row or a cast member opens the stage; Open terminal leaves it for the terminal. The stage is an rly
 * sheet, so focus moves in, stays in, and returns to the control that opened it on close or Escape.
 *
 * @module
 */
import { PortalProvider } from "@knpkv/rly/foundations"
import { Button, Sheet } from "@knpkv/rly/primitives"
import type { CSSProperties, KeyboardEvent, ReactElement } from "react"

import { AgentStateLabel, agentBuckets, agentStageLead, agentStatePresentation } from "./agent-state.js"
import { agentCharacter } from "./character.js"
import { Creature } from "./creature.js"
import type { ConnectAgent } from "./model.js"
import { connectAgentKey } from "./view.js"

/** The fleet as a strip of characters, the ones that need you first; each opens its agent's stage. */
export const AgentCast = ({
  agents,
  onOpen,
  stale
}: {
  readonly agents: ReadonlyArray<ConnectAgent>
  readonly onOpen: (agent: ConnectAgent) => void
  readonly stale: boolean
}): ReactElement => {
  const order = ["needs-you", ...agentBuckets.filter((bucket) => bucket !== "needs-you")]
  const cast = [...agents].sort(
    (left, right) =>
      order.indexOf(agentStatePresentation(left.state).bucket) -
      order.indexOf(agentStatePresentation(right.state).bucket)
  )
  // One tab stop for the whole strip, so the cast doesn't double every row's stop; arrows move along it.
  const move = (event: KeyboardEvent<HTMLElement>): void => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    if (step === 0) return
    const members = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".connect-cast-member")]
    const index = members.findIndex((member) => member === event.target)
    const next = members[(index + step + members.length) % members.length]
    if (index === -1 || next === undefined) return
    event.preventDefault()
    for (const member of members) member.tabIndex = member === next ? 0 : -1
    next.focus()
  }
  return (
    <nav aria-label="Agents at a glance" className="connect-cast" onKeyDown={move}>
      {cast.map((agent, index) => (
        <button
          className="connect-cast-member"
          tabIndex={index === 0 ? 0 : -1}
          data-agent-key={connectAgentKey(agent)}
          key={connectAgentKey(agent)}
          onClick={() => onOpen(agent)}
          type="button"
        >
          <Creature host={agent.host} id={String(agent.id)} size="cast" stale={stale} state={agent.state} />
          <span className="connect-cast-name">{agent.name}</span>
          <AgentStateLabel state={agent.state} />
        </button>
      ))}
    </nav>
  )
}

/** The open agent's stage, or nothing; closing it hands focus back to whatever opened it. */
export const AgentStage = ({
  agent,
  onClose,
  onOpenTerminal,
  stale
}: {
  readonly agent: ConnectAgent | null
  readonly onClose: () => void
  readonly onOpenTerminal: (agent: ConnectAgent) => void
  readonly stale: boolean
}): ReactElement => {
  const hues = agent === null ? [0, 0, 0] : agentCharacter(agent.host, String(agent.id)).hues
  const field: CSSProperties & Record<"--connect-stage-h1" | "--connect-stage-h2" | "--connect-stage-h3", string> = {
    "--connect-stage-h1": String(hues[0]),
    "--connect-stage-h2": String(hues[1]),
    "--connect-stage-h3": String(hues[2])
  }
  return (
    // Its own portal target: Connect runs standalone and inside the hub, and neither provides one.
    <PortalProvider>
      <Sheet.Root onOpenChange={(open) => (open ? undefined : onClose())} open={agent !== null}>
        {agent === null ? null : (
          <Sheet.Content className="connect-stage-sheet" closeLabel="Close" title={agent.name}>
            <Sheet.Body className="connect-stage" data-stale={stale ? "" : undefined} style={field}>
              <div className="connect-stage-hero">
                <Creature host={agent.host} id={String(agent.id)} size="stage" stale={stale} state={agent.state} />
              </div>
              <p className="connect-stage-speech">
                <span className="connect-stage-lead">{agentStageLead(agent.state, stale)}</span>
                <span className="connect-stage-work">{agent.work}</span>
              </p>
              <p className="connect-stage-details">
                <AgentStateLabel state={agent.state} />
                <span>
                  {agent.kind} on {agent.host}
                </span>
              </p>
            </Sheet.Body>
            <Sheet.Footer className="connect-stage-actions">
              <Button onClick={() => onOpenTerminal(agent)} variant="primary">
                Open terminal
              </Button>
            </Sheet.Footer>
          </Sheet.Content>
        )}
      </Sheet.Root>
    </PortalProvider>
  )
}
