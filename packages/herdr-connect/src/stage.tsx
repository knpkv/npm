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
import { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactElement, useState } from "react"

import { AgentStateLabel, agentBuckets, agentStageLead, agentStatePresentation } from "./agent-state.js"
import { agentCharacter } from "./character.js"
import { Creature } from "./creature.js"
import type { ConnectAgent } from "./model.js"
import { connectAgentKey } from "./view.js"

/** The fleet as a strip of characters, the ones that need you first; each opens its agent's stage. */
export const AgentCast = ({
  agents,
  arrivals = new Set(),
  onOpen,
  stale
}: {
  readonly agents: ReadonlyArray<ConnectAgent>
  /** Agents that started needing you on this poll: they turn to you once. */
  readonly arrivals?: ReadonlySet<string>
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
  // The stop is held by agent key, so a poll that re-sorts the cast keeps exactly one, falling back to the first.
  const [active, setActive] = useState<string | null>(null)
  const keys = cast.map(connectAgentKey)
  const activeKey = active !== null && keys.includes(active) ? active : (keys[0] ?? null)
  const move = (event: KeyboardEvent<HTMLElement>): void => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    if (step === 0 || activeKey === null) return
    const next = keys[(keys.indexOf(activeKey) + step + keys.length) % keys.length]
    if (next === undefined) return
    event.preventDefault()
    setActive(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-agent-key="${CSS.escape(next)}"]`)?.focus()
  }
  return (
    <nav aria-label="Agents at a glance" className="connect-cast" onKeyDown={move}>
      {cast.map((agent) => (
        <button
          className="connect-cast-member"
          onFocus={() => setActive(connectAgentKey(agent))}
          tabIndex={connectAgentKey(agent) === activeKey ? 0 : -1}
          data-agent-key={connectAgentKey(agent)}
          key={connectAgentKey(agent)}
          onClick={() => onOpen(agent)}
          type="button"
        >
          <Creature
            arrived={arrivals.has(connectAgentKey(agent))}
            host={agent.host}
            id={String(agent.id)}
            size="cast"
            stale={stale}
            state={agent.state}
          />
          <span className="connect-cast-name">{agent.name}</span>
          <AgentStateLabel state={agent.state} />
        </button>
      ))}
    </nav>
  )
}

const MOTES: ReadonlyArray<string> = ["one", "two", "three", "four", "five"]

/**
 * Shifts the stage's field a little against the pointer, for depth. Written to a custom property the
 * stylesheet only reads while motion is allowed, so reduced motion and a stale stage stay put.
 */
const parallax = (event: PointerEvent<HTMLDivElement>): void => {
  const box = event.currentTarget.getBoundingClientRect()
  if (box.width === 0 || box.height === 0) return
  event.currentTarget.style.setProperty(
    "--connect-stage-px",
    `${String(((event.clientX - box.left) / box.width - 0.5) * -24)}px`
  )
  event.currentTarget.style.setProperty(
    "--connect-stage-py",
    `${String(((event.clientY - box.top) / box.height - 0.5) * -18)}px`
  )
}

/** The open agent's stage, or nothing; closing it hands focus back to whatever opened it. */
export const AgentStage = ({
  agent,
  crew,
  onClose,
  onOpen,
  onOpenTerminal,
  onPinChange,
  pinned,
  stale
}: {
  readonly agent: ConnectAgent | null
  /** Whether this agent is the one this device keeps pinned. */
  readonly pinned: boolean
  readonly onPinChange: (pinned: boolean) => void
  /** The agents it started, each a way to its own stage. */
  readonly crew: ReadonlyArray<ConnectAgent>
  readonly onClose: () => void
  readonly onOpen: (agent: ConnectAgent) => void
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
            <Sheet.Body
              className="connect-stage"
              data-stale={stale ? "" : undefined}
              onPointerMove={parallax}
              style={field}
            >
              {/* Drifting light in the agent's hues; it holds still with reduced motion or a stale directory. */}
              <div aria-hidden="true" className="connect-stage-field">
                {MOTES.map((mote) => (
                  <span className="connect-stage-mote" key={mote} />
                ))}
              </div>
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
              {crew.length === 0 ? null : (
                <nav aria-label={`Agents ${agent.name} started`} className="connect-stage-crew">
                  {crew.map((member) => (
                    <button
                      className="connect-stage-crew-member"
                      key={connectAgentKey(member)}
                      onClick={() => onOpen(member)}
                      type="button"
                    >
                      <Creature
                        host={member.host}
                        id={String(member.id)}
                        size="row"
                        stale={stale}
                        state={member.state}
                      />
                      <span>{member.name}</span>
                      <AgentStateLabel state={member.state} />
                    </button>
                  ))}
                </nav>
              )}
            </Sheet.Body>
            <Sheet.Footer className="connect-stage-actions">
              <Button onClick={() => onOpenTerminal(agent)} variant="primary">
                Open terminal
              </Button>
              {/* The label says the action; no aria-pressed as well, or it reads "Unpin, pressed". */}
              <Button onClick={() => onPinChange(!pinned)} variant="secondary">
                {pinned ? "Unpin" : "Pin"}
              </Button>
            </Sheet.Footer>
          </Sheet.Content>
        )}
      </Sheet.Root>
    </PortalProvider>
  )
}

/**
 * The agent this device keeps pinned, small and always to hand: its character, name and state, opening its
 * stage. It floats over the directory's corner, and sits inside the terminal's bar there, never over the
 * output or the key rail.
 */
export const PinnedAgent = ({
  agent,
  onOpen,
  placement,
  stale
}: {
  readonly agent: ConnectAgent
  readonly onOpen: () => void
  readonly placement: "bar" | "float"
  readonly stale: boolean
}): ReactElement => (
  <button
    aria-label={`Pinned: ${agent.name}, ${agentStatePresentation(agent.state).word}`}
    className="connect-pin"
    data-placement={placement}
    onClick={onOpen}
    type="button"
  >
    <Creature host={agent.host} id={String(agent.id)} size="row" stale={stale} state={agent.state} />
    <span className="connect-pin-name">{agent.name}</span>
    <AgentStateLabel state={agent.state} />
  </button>
)
