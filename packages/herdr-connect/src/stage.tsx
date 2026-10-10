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
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  useId,
  useRef,
  useState
} from "react"

import { AgentStateLabel, agentStageLead, agentStatePresentation } from "./agent-state.js"
import { agentCharacter } from "./character.js"
import { Creature } from "./creature.js"
import type { ConnectAgent } from "./model.js"
import { arrangePins, type Pins } from "./pins.js"
import {
  AgentStateGlyph,
  connectAgentFamilies,
  connectAgentKey,
  connectLineageRows,
  connectRelationLabel
} from "./view.js"
import type { WorkSnapshots } from "@knpkv/herdr-work/model"
import type { ConnectWorkGoalResolution } from "./work-goal-link.js"

/** The fleet as a strip of characters, the ones that need you first; each opens its agent's stage. */
export const AgentCast = ({
  agents,
  arrivals = new Set(),
  onOpen,
  silentHosts = [],
  stale
}: {
  readonly agents: ReadonlyArray<ConnectAgent>
  /** Agents that started needing you on this poll: they turn to you once. */
  readonly arrivals?: ReadonlySet<string>
  readonly onOpen: (agent: ConnectAgent) => void
  readonly stale: boolean
  readonly silentHosts?: ReadonlyArray<string>
}): ReactElement => {
  const families = connectAgentFamilies(agents).filter((family) =>
    family.rows.some(({ agent }) => agentStatePresentation(agent.state).bucket === "needs-you")
  )
  const cast = families.flatMap((family) =>
    family.rows
      .filter((row, index) => index === 0 || agentStatePresentation(row.agent.state).bucket === "needs-you")
      .map(({ agent }) => agent)
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
  if (families.length === 0) return <></>
  return (
    <nav aria-label="Agents at a glance" className="connect-cast" onKeyDown={move}>
      {families.map((family) => (
        <div
          aria-label={`${family.rows[0]?.agent.name ?? "Agent"} family`}
          className="connect-cast-family"
          key={family.key}
          role="group"
        >
          {family.rows
            .filter((row, index) => index === 0 || agentStatePresentation(row.agent.state).bucket === "needs-you")
            .map(({ agent }) => (
              <button
                aria-haspopup="dialog"
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
                  stale={stale || silentHosts.includes(agent.host)}
                  state={agent.state}
                />
                <AgentStateGlyph state={agent.state} />
                <span className="connect-visually-hidden">{agentStatePresentation(agent.state).word}, </span>
                <span className="connect-cast-name">{agent.name}</span>
                <small>
                  {agent.relationship === undefined ? "Primary" : connectRelationLabel(agent.relationship.relation)}
                </small>
              </button>
            ))}
        </div>
      ))}
    </nav>
  )
}

/** PR ownership comes only from a bound Work goal with an actual PR URL, deduplicated across windows. */
export const connectOwnedPullRequests = (agent: ConnectAgent, snapshots: WorkSnapshots): ReadonlyArray<string> => {
  const latest = new Map<string, WorkSnapshots["now"]["goals"][number]>()
  for (const snapshot of [snapshots.now, snapshots.day, snapshots.week, snapshots.month]) {
    for (const goal of snapshot.goals) {
      const previous = latest.get(goal.id)
      if (previous === undefined || goal.updatedAt > previous.updatedAt) latest.set(goal.id, goal)
    }
  }
  const urls = new Set<string>()
  for (const goal of latest.values()) {
    const identity = goal.agentHierarchy?.agent ?? goal.connectTarget
    if (identity?.agentId !== agent.id || identity.host.toLowerCase() !== agent.host.toLowerCase()) continue
    const url = goal.review?.url
    if (url !== undefined && url !== null && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/.test(url))
      urls.add(url)
  }
  return [...urls]
}

/** The stage follows recorded lineage, with partners distinguished from workers and reviewers. */
const AgentLineage = ({
  agent,
  agents,
  onOpen,
  stale
}: {
  readonly agent: ConnectAgent
  readonly agents: ReadonlyArray<ConnectAgent>
  readonly onOpen: (agent: ConnectAgent) => void
  readonly stale: boolean
}) => {
  const [expanded, setExpanded] = useState(false)
  const rows = connectLineageRows(agents)
  const row = rows.find((row) => connectAgentKey(row.agent) === connectAgentKey(agent))
  const ancestors: Array<ConnectAgent> = []
  let current = agent
  while (current.relationship !== undefined && row?.issue === null) {
    const parent = agents.find(
      (candidate) =>
        candidate.host.toLowerCase() === current.host.toLowerCase() &&
        candidate.id === current.relationship?.parentAgentId
    )
    if (parent === undefined) break
    ancestors.push(parent)
    current = parent
  }
  const children =
    row?.issue === null
      ? agents.filter(
          (candidate) =>
            candidate.host.toLowerCase() === agent.host.toLowerCase() &&
            candidate.relationship?.parentAgentId === agent.id &&
            rows.find((entry) => connectAgentKey(entry.agent) === connectAgentKey(candidate))?.issue === null
        )
      : []
  const workers = children.filter((child) => child.relationship?.relation !== "pair")
  const visibleWorkers = workers.filter(
    (child, index) => expanded || index < 3 || agentStatePresentation(child.state).bucket === "needs-you"
  )
  const hiddenWorkers = workers.length - visibleWorkers.length
  const member = (member: ConnectAgent, role: string) => (
    <button
      className="connect-stage-crew-member"
      key={connectAgentKey(member)}
      onClick={() => onOpen(member)}
      type="button"
    >
      <Creature host={member.host} id={String(member.id)} size="row" stale={stale} state={member.state} />
      <span>
        {member.name}
        <small>{role}</small>
      </span>
      <AgentStateLabel state={member.state} />
    </button>
  )
  return (
    <section aria-label="Lineage" className="connect-stage-lineage">
      <h2>{agent.relationship?.relation === "pair" ? "Paired with" : "This family"}</h2>
      {row?.issue === "unknown_parent" ? <p>Primary not listed: {agent.relationship?.parentAgentId}</p> : null}
      {row?.issue === "cross_host" ? <p>Cross-host parent. Relationship unavailable.</p> : null}
      {row?.issue === "cycle" ? <p>Cyclic relationship. Lineage unavailable.</p> : null}
      {row?.issue === "ambiguous" ? <p>Ambiguous ownership. Lineage unavailable.</p> : null}
      {ancestors.map((ancestor, index) => member(ancestor, index === 0 ? "Primary" : "Ancestor"))}
      {ancestors.length === 0 && children.length === 0 && row?.issue === null ? <p>Independent agent</p> : null}
      {children.filter((child) => child.relationship?.relation === "pair").length === 0 ? null : (
        <nav aria-label="Pair partners" className="connect-stage-crew">
          {children
            .filter((child) => child.relationship?.relation === "pair")
            .map((child) => member(child, "Pair partner"))}
        </nav>
      )}
      {workers.length === 0 ? null : (
        <nav aria-label="Workers and reviewers" className="connect-stage-crew">
          {visibleWorkers.map((child) =>
            member(
              child,
              child.relationship === undefined ? "Worker" : connectRelationLabel(child.relationship.relation)
            )
          )}
          {hiddenWorkers === 0 ? null : (
            <button className="connect-family-more" onClick={() => setExpanded(true)} type="button">
              Show {String(hiddenWorkers)} more
            </button>
          )}
        </nav>
      )}
    </section>
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
  agents,
  crew,
  onClose,
  onOpen,
  onOpenTerminal,
  onPinChange,
  pinned,
  stale,
  workGoal,
  workSnapshots = null
}: {
  readonly agent: ConnectAgent | null
  readonly agents?: ReadonlyArray<ConnectAgent>
  readonly workSnapshots?: WorkSnapshots | null
  /** The open agent's goal on the Work board, linked from its stage when there is exactly one. */
  readonly workGoal: ConnectWorkGoalResolution
  /** Whether this agent is the one this device keeps pinned. */
  readonly pinned: boolean
  readonly onPinChange: (pinned: boolean) => void
  /** Its direct children, used when a complete directory is not supplied. */
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
                {workGoal._tag === "available" ? (
                  <a className="connect-stage-goal" href={workGoal.href}>
                    Work goal: {workGoal.title}
                  </a>
                ) : null}
              </p>
              <AgentLineage
                key={connectAgentKey(agent)}
                agent={agent}
                agents={agents ?? [agent, ...crew]}
                onOpen={onOpen}
                stale={stale}
              />
              <section aria-label="Pull requests" className="connect-stage-prs">
                <h2>
                  Pull requests
                  {workSnapshots === null ? (
                    ""
                  ) : (
                    <span>owned {String(connectOwnedPullRequests(agent, workSnapshots).length)}</span>
                  )}
                </h2>
                {workSnapshots === null ? (
                  <p>Work snapshot unavailable.</p>
                ) : (
                  <>
                    <p>Owned in this Work snapshot.</p>
                    {connectOwnedPullRequests(agent, workSnapshots).map((url) => (
                      <a href={url} key={url} rel="noreferrer" target="_blank">
                        {url.replace("https://github.com/", "")}
                      </a>
                    ))}
                  </>
                )}
              </section>
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

/** How many chips each placement shows before the rest go behind "+N". */
export const PIN_ROOM = { bar: 2, float: 3 } satisfies Record<"bar" | "float", number>

const sameDayTime = new Intl.DateTimeFormat("en", { hour: "2-digit", hourCycle: "h23", minute: "2-digit" })
const otherDayTime = new Intl.DateTimeFormat("en", {
  day: "numeric",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "short"
})

/** "not seen since 14:05", with the date when it wasn't today; a pin no poll has seen yet says so. */
const sinceLabel = (at: number | null, now: number): string => {
  if (at === null) return "not seen yet"
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  return `not seen since ${(sameDay ? sameDayTime : otherDayTime).format(at)}`
}

/** A button's place in a roving group: the one stop has tab index 0, the rest -1. */
interface RovingStop {
  readonly onFocus: () => void
  readonly tabIndex: 0 | -1
}

/** A pinned agent that is here this poll: its character, name and state, opening its stage, and its unpin. */
const PinChip = ({
  agent,
  onOpen,
  onUnpin,
  pinKey,
  roving,
  stale
}: {
  readonly agent: ConnectAgent
  readonly onOpen: () => void
  readonly onUnpin: (event: MouseEvent<HTMLButtonElement>) => void
  readonly pinKey: string
  /** The open and unpin buttons' places in the set's single tab stop. */
  readonly roving: readonly [RovingStop, RovingStop]
  readonly stale: boolean
}): ReactElement => (
  // Two sibling buttons, never one inside the other: open is the chip, unpin its own small control.
  <span className="connect-pin">
    <button
      aria-label={`Pinned: ${agent.name}, ${agentStatePresentation(agent.state).word}`}
      className="connect-pin-open"
      data-pin-key={pinKey}
      onClick={onOpen}
      type="button"
      {...roving[0]}
    >
      <Creature host={agent.host} id={String(agent.id)} size="row" stale={stale} state={agent.state} />
      <span className="connect-pin-name">{agent.name}</span>
      <span className="connect-pin-state">
        <AgentStateLabel state={agent.state} />
      </span>
    </button>
    <button
      aria-label={`Unpin ${agent.name}`}
      className="connect-pin-unpin"
      data-pin-key={pinKey}
      onClick={onUnpin}
      type="button"
      {...roving[1]}
    >
      <span aria-hidden="true">×</span>
    </button>
  </span>
)

/**
 * The agents this device keeps pinned, small and always to hand, in the order they were pinned. The first
 * few that are here show as chips; the rest, and any pinned agent this poll didn't list, wait behind a "+N"
 * button, the away ones dimmed with when they were last seen, so a pin never seems lost. Over the directory
 * they stack in the end corner, clear of the safe area; in the terminal they sit inside its bar, never over
 * the output or the key rail.
 *
 * One tab stop for the whole set; arrows move through it, and Delete or Backspace unpins the focused pin.
 */
export const PinnedAgents = ({
  agentFor,
  hiddenKey = null,
  now,
  onOpen,
  onUnpin,
  pins,
  placement,
  room = PIN_ROOM[placement],
  stale
}: {
  readonly pins: Pins
  /** How many chips show before the rest go behind the overflow button; a phone's terminal bar shows none. */
  readonly room?: number | undefined
  readonly agentFor: (key: string) => ConnectAgent | undefined
  /** The agent whose stage or terminal is open: its own pin isn't repeated beside it. */
  readonly hiddenKey?: string | null
  readonly now: number
  readonly onOpen: (agent: ConnectAgent) => void
  readonly onUnpin: (key: string) => void
  readonly placement: "bar" | "float"
  readonly stale: boolean
}): ReactElement | null => {
  const { overflow, shown } = arrangePins(pins, agentFor, room, (key) => key === hiddenKey)
  const [expanded, setExpanded] = useState(false)
  const [active, setActive] = useState(0)
  const group = useRef<HTMLDivElement>(null)
  const listId = `connect-pins-${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  const open = expanded && overflow.length > 0
  if (shown.length === 0 && overflow.length === 0) return null
  const buttons = (): ReadonlyArray<HTMLButtonElement> => [...(group.current?.querySelectorAll("button") ?? [])]
  const focusAt = (index: number): void => {
    const all = buttons()
    const target = all[Math.min(Math.max(index, 0), all.length - 1)]
    if (target === undefined) {
      document.querySelector<HTMLElement>("#connect-agent-search")?.focus()
      return
    }
    setActive(all.indexOf(target))
    target.focus()
  }
  // Unpinning with the × keeps focus in the set, as Delete does: on the control now in its place, or search.
  const unpinFrom =
    (key: string) =>
    (event: MouseEvent<HTMLButtonElement>): void => {
      const index = buttons().indexOf(event.currentTarget)
      onUnpin(key)
      requestAnimationFrame(() => focusAt(index))
    }
  const keyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const all = buttons()
    const index = all.findIndex((button) => button === document.activeElement)
    if (index === -1) return
    if (event.key === "Escape" && open) {
      event.preventDefault()
      setExpanded(false)
      group.current?.querySelector<HTMLButtonElement>(".connect-pins-more")?.focus()
      return
    }
    const pinKey = all[index]?.dataset.pinKey
    if ((event.key === "Delete" || event.key === "Backspace") && pinKey !== undefined) {
      event.preventDefault()
      onUnpin(pinKey)
      // The pin's buttons leave on the next render; focus the control now at its place, or search if none.
      requestAnimationFrame(() => focusAt(index))
      return
    }
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0
    if (step === 0) return
    event.preventDefault()
    focusAt((index + step + all.length) % all.length)
  }
  // Chip i's open and unpin buttons are stops 2i and 2i + 1, and "+N" comes last. The list behind "+N" is
  // reached with the arrows once open, and takes focus when it opens.
  const stops = shown.length * 2 + (overflow.length > 0 ? 1 : 0)
  const stop = (index: number): RovingStop => ({
    onFocus: () => setActive(index),
    tabIndex: index === Math.min(active, stops - 1) ? 0 : -1
  })
  const toggle = (): void => {
    setExpanded(!open)
    if (!open)
      requestAnimationFrame(() => group.current?.querySelector<HTMLElement>(".connect-pins-overflow button")?.focus())
  }
  return (
    <div
      aria-label="Pinned agents"
      className="connect-pins"
      data-placement={placement}
      // Light dismiss: focus leaving the set, by a press elsewhere or Tab, closes the list.
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false)
      }}
      onKeyDown={keyDown}
      ref={group}
      role="group"
    >
      {shown.map(({ agent, pin }, index) =>
        agent === undefined ? null : (
          <PinChip
            agent={agent}
            key={pin.key}
            onOpen={() => onOpen(agent)}
            onUnpin={unpinFrom(pin.key)}
            pinKey={pin.key}
            roving={[stop(index * 2), stop(index * 2 + 1)]}
            stale={stale}
          />
        )
      )}
      {overflow.length === 0 ? null : (
        <div className="connect-pins-more-wrap">
          <button
            aria-controls={listId}
            aria-expanded={open}
            aria-label={
              shown.length === 0 ? `${String(overflow.length)} pinned` : `${String(overflow.length)} more pinned`
            }
            className="connect-pins-more"
            onClick={toggle}
            type="button"
            {...stop(stops - 1)}
          >
            {shown.length === 0 ? `Pins ${String(overflow.length)}` : `+${String(overflow.length)}`}
          </button>
          {open ? (
            <ul className="connect-pins-overflow" id={listId}>
              {overflow.map(({ agent, pin }) => (
                <li className="connect-pins-entry" data-away={agent === undefined ? "" : undefined} key={pin.key}>
                  {agent === undefined ? (
                    <span className="connect-pin-open">
                      {/* Drawn as away: still, eyes closed, colour drained. */}
                      <Creature host={pin.host} id={pin.id} size="row" stale state="done" />
                      <span className="connect-pin-text">
                        <span className="connect-pin-name">{pin.name}</span>
                        <small className="connect-pin-since">{sinceLabel(pin.seenAt, now)}</small>
                      </span>
                    </span>
                  ) : (
                    <button
                      aria-label={`Pinned: ${agent.name}, ${agentStatePresentation(agent.state).word}`}
                      className="connect-pin-open"
                      data-pin-key={pin.key}
                      onClick={() => {
                        setExpanded(false)
                        onOpen(agent)
                      }}
                      tabIndex={-1}
                      type="button"
                    >
                      <Creature host={agent.host} id={String(agent.id)} size="row" stale={stale} state={agent.state} />
                      <span className="connect-pin-name">{agent.name}</span>
                      <AgentStateLabel state={agent.state} />
                    </button>
                  )}
                  <button
                    aria-label={`Unpin ${pin.name}`}
                    className="connect-pin-unpin"
                    data-pin-key={pin.key}
                    onClick={unpinFrom(pin.key)}
                    tabIndex={-1}
                    type="button"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  )
}
