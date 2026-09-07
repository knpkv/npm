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
import type { UnattributedDayResponse, WeekRowResponse } from "../server/Api.js"
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
}

/**
 * Accept one proposed row.
 *
 * The amount box takes a duration the way the CLI does (`45m`, `1h30m`), because a person editing an
 * amount is thinking in hours and minutes, not seconds.
 */
export const ConfirmPanel = (props: {
  readonly row: WeekRowResponse
  readonly busy: boolean
  readonly onConfirm: (submission: ConfirmSubmission) => void
  readonly onCancel: () => void
}) => {
  const proposal = props.row.proposal
  const [amount, setAmount] = useState(proposal === undefined ? "" : formatDuration(proposal.maxSeconds))
  const [ticketKey, setTicketKey] = useState(props.row.ticketKey)
  const [note, setNote] = useState("")
  if (proposal === undefined) return null

  const requested = parseDuration(amount.trim())
  const amountProblem =
    requested === null
      ? "Enter a duration like 45m or 1h30m."
      : requested > proposal.maxSeconds
        ? `The sessions evidence ${formatDuration(proposal.maxSeconds)}. Log more as a manual entry.`
        : null
  const retargeted = ticketKey !== props.row.ticketKey
  const adjusted = requested !== null && requested !== proposal.maxSeconds
  const ticketProblem = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(ticketKey) ? null : "That is not an Issue Key."

  return (
    <section aria-label={`Confirm ${props.row.ticketKey} on ${props.row.day}`} className="jcf-panel">
      <h2>
        {props.row.ticketKey} · {props.row.day} · {proposalTargets(proposal)}
      </h2>
      <dl>
        <dt>Evidence</dt>
        <dd>
          {duration(proposal.maxSeconds)} credited from {proposal.sessionCount} session
          {proposal.sessionCount === 1 ? "" : "s"}
          {proposal.activeSeconds > proposal.maxSeconds
            ? ` · ${duration(proposal.activeSeconds)} active, shared with work on other tickets`
            : ""}
        </dd>
        <dt>Placed by</dt>
        <dd>
          {proposal.signal} — {signalMeaning[proposal.signal] ?? "unknown signal"}
          {proposal.confidence === null ? "" : ` · confidence ${proposal.confidence.toFixed(2)}`}
        </dd>
        <dt>When</dt>
        <dd className="jcf-spans">{proposal.spans.map(spanRange).join(", ")}</dd>
        <dt>Already held</dt>
        <dd>
          Clockify {duration(props.row.clockifySeconds)} · Jira {duration(props.row.jiraSeconds)}
        </dd>
      </dl>
      <div className="jcf-fields">
        <TextField label="Amount" onChange={setAmount} value={amount} />
        <TextField label="Issue Key" onChange={setTicketKey} value={ticketKey} />
        <TextField
          label="What was done (optional)"
          onChange={setNote}
          placeholder="goes into both systems"
          value={note}
          wide
        />
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
      <div className="jcf-actions">
        <Button
          disabled={props.busy || amountProblem !== null || ticketProblem !== null}
          loading={props.busy}
          onClick={() =>
            props.onConfirm({
              note: note.trim() === "" ? undefined : note.trim(),
              seconds: requested === proposal.maxSeconds ? undefined : (requested ?? undefined),
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
  readonly onLog: (submission: ManualSubmission) => void
  readonly onCancel: () => void
}) => {
  const [ticketKey, setTicketKey] = useState("")
  const [amount, setAmount] = useState("")
  const [startClock, setStartClock] = useState("")
  const [note, setNote] = useState("")

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
      </div>
      {clockOk ? null : (
        <p className="jcf-note" data-tone="failure">
          Start time reads as HH:MM.
        </p>
      )}
      <div className="jcf-actions">
        <Button
          disabled={props.busy || seconds === null || !ticketOk || !clockOk}
          loading={props.busy}
          onClick={() => {
            if (seconds === null) return
            props.onLog({
              note: note.trim() === "" ? undefined : note.trim(),
              seconds,
              startClock: startClock.trim() === "" ? undefined : startClock.trim(),
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
