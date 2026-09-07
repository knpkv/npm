/**
 * The three things a person can do to a week, each behind an explicit confirmation.
 *
 * **Mental model**
 *
 * - **Nothing is written until the text that will be written is on screen.** Every panel shows the
 *   description that lands in Clockify and Jira before its confirm button does anything.
 * - **A panel, not a modal.** Filling several gaps in a row means comparing each one against the
 *   grid it came from, and a dialog covers exactly what the reader is comparing against.
 * - **The amount is capped by the evidence, and the cap is stated.** Overruling it downward is a
 *   person saying the evidence overstates the work. Upward is not on offer — that is what the manual
 *   entry is for, and it says so.
 *
 * @module
 */
import { Button } from "@knpkv/rly"
import { useState } from "react"
import type { UnattributedDayResponse, WeekRowResponse, WriteTargetsRequest } from "../server/Api.js"
import { duration, formatDuration, parseDuration, proposalTargets, signalMeaning, spanRange } from "./format.js"

/** A labelled text input. rly owns the look through tokens; the label stays a real `<label>`. */
const TextField = (props: {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly wide?: boolean
  readonly placeholder?: string
}) => (
  <label className={props.wide === true ? "jcf-field jcf-field-wide" : "jcf-field"}>
    <span>{props.label}</span>
    <input
      onChange={(event) => props.onChange(event.target.value)}
      placeholder={props.placeholder}
      value={props.value}
    />
  </label>
)

export interface ConfirmSubmission {
  readonly seconds: number | undefined
  readonly ticketKey: string | undefined
  readonly note: string | undefined
  readonly targets: WriteTargetsRequest
  /** Which blocks to write, by position. Undefined when every one of them is selected. */
  readonly blocks: ReadonlyArray<number> | undefined
}

/**
 * Which systems this write touches, defaulted to the week's own scope.
 *
 * Per write rather than only per week: most days both systems want the same hours, and the day they
 * do not is a deliberate choice someone should be able to make without re-reading the week.
 */
const TargetPicker = (props: {
  readonly targets: WriteTargetsRequest
  readonly onChange: (targets: WriteTargetsRequest) => void
}) => (
  <fieldset className="jcf-targets">
    <legend>Write to</legend>
    <label>
      <input
        checked={props.targets.clockify}
        onChange={(event) => props.onChange({ ...props.targets, clockify: event.target.checked })}
        type="checkbox"
      />
      <span>Clockify</span>
    </label>
    <label>
      <input
        checked={props.targets.jira}
        onChange={(event) => props.onChange({ ...props.targets, jira: event.target.checked })}
        type="checkbox"
      />
      <span>Jira</span>
    </label>
  </fieldset>
)

/**
 * Which stretches of the row this write is for.
 *
 * The whole point of the list: a day's evidence arrives as several blocks, and the answer to "did
 * that hour go on this ticket?" is often yes for three of them and no for the fourth. Ticking is
 * cheaper than typing an amount, and unlike an amount it keeps the evidence attached — a chosen
 * block still has a transcript behind when it happened.
 */
const BlockPicker = (props: {
  readonly blocks: ReadonlyArray<{ readonly startMs: number; readonly endMs: number; readonly seconds: number }>
  readonly chosen: ReadonlySet<number>
  readonly onChange: (chosen: ReadonlySet<number>) => void
}) => {
  const all = props.chosen.size === props.blocks.length
  return (
    <fieldset className="jcf-blocks">
      <legend>Blocks to write</legend>
      <ul>
        {props.blocks.map((block, index) => (
          <li key={`${block.startMs}:${index}`}>
            <label>
              <input
                checked={props.chosen.has(index)}
                onChange={(event) => {
                  const next = new Set(props.chosen)
                  if (event.target.checked) next.add(index)
                  else next.delete(index)
                  props.onChange(next)
                }}
                type="checkbox"
              />
              <span className="jcf-spans">{spanRange(block)}</span>
              <span>{duration(block.seconds)}</span>
            </label>
          </li>
        ))}
      </ul>
      {props.blocks.length < 2 ? null : (
        <Button
          onClick={() => props.onChange(all ? new Set() : new Set(props.blocks.map((_, index) => index)))}
          size="compact"
          variant="quiet"
        >
          {all ? "None" : "All"}
        </Button>
      )}
    </fieldset>
  )
}

/**
 * Accept one proposed row, or one block of it.
 *
 * The amount box takes a duration the way the CLI does (`45m`, `1h30m`), because a person editing an
 * amount is thinking in hours and minutes, not seconds. It follows the blocks that are ticked, so
 * the number on screen is always the number that would be written.
 */
export const ConfirmPanel = (props: {
  readonly row: WeekRowResponse
  readonly busy: boolean
  readonly scopeTargets: WriteTargetsRequest
  /** The block the reader clicked. Its siblings start unticked, so one click writes one stretch. */
  readonly blockIndex: number | undefined
  readonly onConfirm: (submission: ConfirmSubmission) => void
  readonly onCancel: () => void
}) => {
  const proposal = props.row.proposal
  const blocks = proposal?.blocks ?? []
  // Only the clicked block, or all of them when the panel was opened without one. The parent keys
  // this component by row and block, so clicking another block mounts a fresh panel rather than
  // leaving one block's amount attached to another block's times.
  const chosenAtFirst = new Set(props.blockIndex === undefined ? blocks.map((_, index) => index) : [props.blockIndex])
  const secondsOf = (chosen: ReadonlySet<number>): number =>
    [...chosen].reduce((sum, index) => sum + (blocks[index]?.seconds ?? 0), 0)
  const [chosen, setChosen] = useState<ReadonlySet<number>>(chosenAtFirst)
  const [amount, setAmount] = useState(() => formatDuration(secondsOf(chosenAtFirst)))
  const [ticketKey, setTicketKey] = useState(props.row.ticketKey)
  const [note, setNote] = useState("")
  const [targets, setTargets] = useState(props.scopeTargets)
  if (proposal === undefined) return null

  const selected = secondsOf(chosen)

  const chooseBlocks = (next: ReadonlySet<number>) => {
    setChosen(next)
    // The amount is a consequence of the selection, not an independent field: leaving a stale
    // number behind would offer to write time the ticked blocks do not account for.
    setAmount(formatDuration(secondsOf(next)))
  }

  const requested = parseDuration(amount.trim())
  const amountProblem =
    chosen.size === 0
      ? "Tick at least one block, or use the manual entry below the grid."
      : requested === null
        ? "Enter a duration like 45m or 1h30m."
        : requested > selected
          ? `The blocks you ticked evidence ${formatDuration(selected)}. Tick more, or log the rest by hand.`
          : null
  const retargeted = ticketKey !== props.row.ticketKey
  const adjusted = requested !== null && requested !== selected
  const ticketProblem = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(ticketKey) ? null : "That is not an Issue Key."
  const noTargets = !targets.clockify && !targets.jira

  return (
    <section aria-label={`Confirm ${props.row.ticketKey} on ${props.row.day}`} className="jcf-panel">
      <h2>
        {props.row.ticketKey} · {props.row.day} ·{" "}
        {selected === proposal.maxSeconds
          ? proposalTargets(proposal)
          : `+${formatDuration(selected)} of ${formatDuration(proposal.maxSeconds)}`}
      </h2>
      {props.row.ticketTitle === null ? null : <p className="jcf-muted">{props.row.ticketTitle}</p>}
      <dl>
        <dt>Evidence</dt>
        <dd>
          {duration(proposal.maxSeconds)} credited from {proposal.sessionCount} session
          {proposal.sessionCount === 1 ? "" : "s"} in {proposal.blocks.length} block
          {proposal.blocks.length === 1 ? "" : "s"}
          {proposal.activeSeconds > proposal.maxSeconds
            ? ` · ${duration(proposal.activeSeconds)} active, shared with work on other tickets`
            : ""}
        </dd>
        <dt>Placed by</dt>
        <dd>
          {proposal.signal} — {signalMeaning[proposal.signal] ?? "unknown signal"}
          {proposal.confidence === null ? "" : ` · confidence ${proposal.confidence.toFixed(2)}`}
        </dd>
        <dt>Already held</dt>
        <dd>
          Clockify {duration(props.row.clockifySeconds)} · Jira {duration(props.row.jiraSeconds)}
        </dd>
      </dl>
      <BlockPicker blocks={proposal.blocks} chosen={chosen} onChange={chooseBlocks} />
      <div className="jcf-fields">
        <TextField label="Amount" onChange={setAmount} value={amount} />
        <TextField label="Issue Key" onChange={setTicketKey} value={ticketKey} />
        <TextField
          label="What was done (optional)"
          onChange={setNote}
          placeholder="goes with the entry"
          value={note}
          wide
        />
        <TargetPicker onChange={setTargets} targets={targets} />
      </div>
      {amountProblem === null ? null : (
        <p className="jcf-note" data-tone="failure">
          {amountProblem}
        </p>
      )}
      {ticketProblem === null ? null : (
        <p className="jcf-note" data-tone="failure">
          {ticketProblem}
        </p>
      )}
      {retargeted || adjusted ? (
        <p className="jcf-note" data-tone="warning">
          {retargeted && adjusted
            ? "The entry will say the amount and ticket were set by hand."
            : retargeted
              ? "The entry will say the ticket was set by hand."
              : "The entry will say the amount was set by hand."}
          {retargeted ? " The write is re-checked against what the new ticket already holds." : ""}
        </p>
      ) : null}
      {noTargets ? (
        <p className="jcf-note" data-tone="failure">
          Pick at least one system — a write to neither is not a write.
        </p>
      ) : null}
      <div className="jcf-actions">
        <Button
          disabled={props.busy || amountProblem !== null || ticketProblem !== null || noTargets}
          loading={props.busy}
          onClick={() =>
            props.onConfirm({
              // Positions, never durations: the server holds the blocks and sizes the write.
              blocks: chosen.size === proposal.blocks.length ? undefined : [...chosen].sort((a, b) => a - b),
              note: note.trim() === "" ? undefined : note.trim(),
              seconds: requested === selected ? undefined : (requested ?? undefined),
              targets,
              ticketKey: retargeted ? ticketKey : undefined
            })
          }
          variant="primary"
        >
          Write it
        </Button>
        <Button disabled={props.busy} onClick={props.onCancel} variant="quiet">
          Cancel
        </Button>
      </div>
    </section>
  )
}

export interface ManualSubmission {
  readonly ticketKey: string
  readonly seconds: number
  readonly startClock: string | undefined
  readonly note: string | undefined
  readonly targets: WriteTargetsRequest
}

/**
 * Log time no session evidences.
 *
 * Deliberately separate from a proposal, and deliberately unbounded: this is the honest home for the
 * hours a transcript cannot see — a meeting, a whiteboard, a review read on paper. It adds rather
 * than tops up, so it says so.
 */
export const ManualPanel = (props: {
  readonly day: string
  readonly busy: boolean
  readonly startClock: string
  readonly scopeTargets: WriteTargetsRequest
  readonly onLog: (submission: ManualSubmission) => void
  readonly onCancel: () => void
}) => {
  const [ticketKey, setTicketKey] = useState("")
  const [amount, setAmount] = useState("")
  const [startClock, setStartClock] = useState(props.startClock)
  const [note, setNote] = useState("")
  const [targets, setTargets] = useState(props.scopeTargets)

  const seconds = parseDuration(amount.trim())
  const ticketOk = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(ticketKey)
  const clockOk = startClock.trim() === "" || /^\d{2}:\d{2}$/.test(startClock.trim())

  return (
    <section aria-label={`Log time by hand on ${props.day}`} className="jcf-panel">
      <h2>Time by hand · {props.day}</h2>
      <p className="jcf-muted">
        Added to both systems as typed. Nothing is subtracted, so this is for work no session evidences rather than for
        topping up a row above.
      </p>
      <div className="jcf-fields">
        <TextField label="Issue Key" onChange={setTicketKey} placeholder="PROJ-123" value={ticketKey} />
        <TextField label="Amount" onChange={setAmount} placeholder="45m" value={amount} />
        <TextField label="Started (optional)" onChange={setStartClock} placeholder="14:30" value={startClock} />
        <TextField label="What was done (optional)" onChange={setNote} value={note} wide />
        <TargetPicker onChange={setTargets} targets={targets} />
      </div>
      {clockOk ? null : (
        <p className="jcf-note" data-tone="failure">
          Start time reads as HH:MM.
        </p>
      )}
      <div className="jcf-actions">
        <Button
          disabled={props.busy || seconds === null || !ticketOk || !clockOk || (!targets.clockify && !targets.jira)}
          loading={props.busy}
          onClick={() => {
            if (seconds === null) return
            props.onLog({
              note: note.trim() === "" ? undefined : note.trim(),
              seconds,
              startClock: startClock.trim() === "" ? undefined : startClock.trim(),
              targets,
              ticketKey
            })
          }}
          variant="primary"
        >
          Write it
        </Button>
        <Button disabled={props.busy} onClick={props.onCancel} variant="quiet">
          Cancel
        </Button>
      </div>
    </section>
  )
}

/**
 * Map a directory to an Issue Key, so recurring ticket-less work stops being unplaced.
 *
 * The directory is offered exactly as the session ran in it. Shortening it to a parent is a
 * deliberate edit, because a broad prefix absorbs every future session beneath it — and a Standing
 * Attribution loses to a branch or a path, so it can only ever add attribution, never redirect it.
 */
export const StandingPanel = (props: {
  readonly credit: UnattributedDayResponse
  readonly cwd: string
  readonly busy: boolean
  readonly onMap: (mapping: { readonly cwd: string; readonly ticketKey: string }) => void
  readonly onCancel: () => void
}) => {
  const [cwd, setCwd] = useState(props.cwd)
  const [ticketKey, setTicketKey] = useState("")
  const ticketOk = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(ticketKey)

  return (
    <section aria-label={`Map ${props.cwd} to an Issue Key`} className="jcf-panel">
      <h2>Standing Attribution · {props.credit.day}</h2>
      <p className="jcf-muted">
        Sessions under this directory will be placed on this Issue Key from now on, unless a branch or a path names one.
        Nothing is written to Jira or Clockify now — reload the week to see the hours become an ordinary proposal.
      </p>
      <div className="jcf-fields">
        <TextField label="Directory" onChange={setCwd} value={cwd} wide />
        <TextField label="Issue Key" onChange={setTicketKey} placeholder="PROJ-123" value={ticketKey} />
      </div>
      <div className="jcf-actions">
        <Button
          disabled={props.busy || !ticketOk || cwd.trim() === ""}
          loading={props.busy}
          onClick={() => props.onMap({ cwd: cwd.trim(), ticketKey })}
          variant="primary"
        >
          Save the mapping
        </Button>
        <Button disabled={props.busy} onClick={props.onCancel} variant="quiet">
          Cancel
        </Button>
      </div>
    </section>
  )
}
