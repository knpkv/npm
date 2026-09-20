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
import { Button, Field } from "@knpkv/rly/primitives"
import { useAtomValue } from "@effect/atom-react"
import { useEffect, useState } from "react"
import type { UnattributedDayResponse, WeekRowResponse, WriteTargetsRequest } from "../server/Api.js"
import { consumedFromWeekBlocks, prepareProposal } from "../shared/writePlanning.js"
import { duration, formatDuration, parseDuration, signalMeaning, spanRange } from "./format.js"
import type { RowDescriptionDraft } from "./rowDescriptions.js"

/** Rly owns field labels, focus, input sizing and announced validation. */
const TextField = (props: {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly wide?: boolean
  readonly placeholder?: string
  readonly error?: string | undefined
  readonly type?: "text" | "time"
  readonly maxLength?: number
  readonly loading?: boolean
  readonly multiline?: boolean
}) => (
  <Field
    className={props.wide === true ? "jcf-field jcf-field-wide" : "jcf-field"}
    label={props.label}
    {...(props.error === undefined ? {} : { error: props.error })}
  >
    {(control) =>
      props.multiline === true ? (
        <textarea
          {...control}
          rows={4}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={props.placeholder}
          value={props.value}
          maxLength={props.maxLength}
          aria-busy={props.loading}
        />
      ) : (
        <input
          {...control}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={props.placeholder}
          value={props.value}
          type={props.type ?? "text"}
          maxLength={props.maxLength}
          aria-busy={props.loading}
        />
      )
    }
  </Field>
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
 * A write can narrow the selected provider layers. Hidden layers cannot be re-enabled here.
 */
const TargetPicker = (props: {
  readonly allowed: WriteTargetsRequest
  readonly targets: WriteTargetsRequest
  readonly onChange: (targets: WriteTargetsRequest) => void
}) => (
  <fieldset className="jcf-targets">
    <legend>Write to selected layers</legend>
    <label>
      <input
        checked={props.targets.clockify}
        disabled={!props.allowed.clockify}
        onChange={(event) => props.onChange({ ...props.targets, clockify: event.target.checked })}
        type="checkbox"
      />
      <span>Clockify</span>
    </label>
    <label>
      <input
        checked={props.targets.jira}
        disabled={!props.allowed.jira}
        onChange={(event) => props.onChange({ ...props.targets, jira: event.target.checked })}
        type="checkbox"
      />
      <span>Jira</span>
    </label>
  </fieldset>
)

/** Editable and confirmation amounts must round-trip through parseDuration without losing seconds. */
const exactDuration = (seconds: number): string => {
  if (seconds <= 0) return "—"
  const remainder = seconds % 60
  return seconds < 3600 || remainder === 0 ? formatDuration(seconds) : `${formatDuration(seconds)} ${remainder}s`
}

/**
 * Review the one block clicked in the calendar.
 *
 * The amount box takes a duration the way the CLI does (`45m`, `1h30m47s`), preserving any seconds
 * already in the block. The clicked block caps the editable amount.
 */
export const ConfirmPanel = (props: {
  readonly description: RowDescriptionDraft
  readonly descriptionDisabled: boolean
  readonly row: WeekRowResponse
  readonly busy: boolean
  readonly unavailable: boolean
  readonly scopeTargets: WriteTargetsRequest
  /** The only block this editor can submit. */
  readonly blockIndex: number
  readonly onConfirm: (submission: ConfirmSubmission) => void
  readonly onCancel: () => void
}) => {
  const proposal = props.row.proposal
  const block = proposal?.blocks[props.blockIndex]
  const selected = block?.seconds ?? 0
  const [amount, setAmount] = useState(() => exactDuration(selected))
  const [ticketKey, setTicketKey] = useState(props.row.ticketKey)
  const draft = useAtomValue(props.description.state)
  useEffect(() => {
    if (!props.descriptionDisabled && draft.status === "idle" && !draft.edited) void props.description.load()
  }, [props.description, props.descriptionDisabled, draft.status, draft.edited])
  const note = draft.text
  const suggesting =
    !draft.edited && !props.descriptionDisabled && (draft.status === "loading" || draft.status === "idle")
  const [chosenTargets, setTargets] = useState({ jira: true, clockify: true })
  const targets = {
    jira: props.scopeTargets.jira && chosenTargets.jira,
    clockify: props.scopeTargets.clockify && chosenTargets.clockify
  }
  if (proposal === undefined || block === undefined) return null

  const requested = parseDuration(amount.trim())
  const minimumSeconds = targets.jira && !targets.clockify ? 60 : 1
  const amountProblem =
    requested === null || requested < minimumSeconds || requested > 86400
      ? targets.clockify
        ? "Enter between 1s and 24h, for example 45s or 1h30m."
        : "Enter between 1m and 24h, for example 45m or 1h30m."
      : requested > selected
        ? `This block contains ${exactDuration(selected)}. Use Log time to add other work.`
        : null
  const retargeted = ticketKey !== props.row.ticketKey
  const adjusted = requested !== null && requested !== selected
  const ticketProblem = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(ticketKey) ? null : "That is not an Issue Key."
  const noTargets = !targets.clockify && !targets.jira
  const requestSeconds = requested === selected ? undefined : (requested ?? undefined)
  const prepared =
    retargeted || amountProblem !== null || noTargets
      ? undefined
      : prepareProposal({
          evidence: {
            blocks: proposal.blocks,
            credited: proposal.maxSeconds,
            ticketKey: props.row.ticketKey,
            day: props.row.day
          },
          request: { blocks: [props.blockIndex], seconds: requestSeconds, targets },
          targets,
          consumed: consumedFromWeekBlocks(proposal.blocks)
        })
  const preview = prepared?._tag === "Prepared" ? prepared.plan([props.row]) : undefined

  return (
    <section aria-label={`Confirm ${props.row.ticketKey} on ${props.row.day}`} className="jcf-panel">
      <h2>
        {props.row.ticketKey} · {props.row.day} · {spanRange(block)}
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
      <div className="jcf-fields">
        <TextField label="Amount" onChange={setAmount} value={amount} error={amountProblem ?? undefined} />
        <TextField
          label="Issue key"
          onChange={(value) => setTicketKey(value.toUpperCase())}
          value={ticketKey}
          error={ticketProblem ?? undefined}
        />
        <TextField
          maxLength={500}
          label="What was done (optional)"
          multiline
          loading={suggesting}
          onChange={props.description.edit}
          placeholder={suggesting ? "Agent is writing a description…" : "Describe this work"}
          value={note}
          wide
        />
        <div className="jcf-field-wide jcf-muted" role="status" aria-label="Description suggestion">
          {suggesting ? (
            <progress className="jcf-description-progress" aria-label="Generating work description" />
          ) : null}
          {draft.edited ? (
            "Your description will be used."
          ) : props.descriptionDisabled ? (
            "Waiting for agent settings to save…"
          ) : draft.status === "loading" || draft.status === "idle" ? (
            "Suggesting a description from session evidence…"
          ) : draft.status === "ready" ? (
            "Suggested from this ticket’s sessions for the day. Edit as needed."
          ) : (
            <>
              <span>
                {draft.status === "failed"
                  ? draft.failure
                  : "Couldn’t suggest a description from session evidence. You can write one."}
              </span>{" "}
              {draft.status === "failed" ? (
                <Button size="compact" variant="quiet" onClick={() => void props.description.load()}>
                  Try description again
                </Button>
              ) : null}
            </>
          )}
        </div>
        <TargetPicker allowed={props.scopeTargets} onChange={setTargets} targets={targets} />
      </div>
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
      {preview?._tag === "Write" ? (
        <p className="jcf-muted">
          Will add{" "}
          {targets.clockify
            ? preview.clockify.refusal === "unlinked-overlap"
              ? "Clockify 0s (held for review)"
              : `Clockify ${exactDuration(preview.clockify.seconds)}`
            : ""}
          {targets.clockify && targets.jira ? " · " : ""}
          {targets.jira ? `Jira ${exactDuration(preview.jira.seconds)}` : ""}.
          {(targets.clockify &&
            preview.clockify.refusal === undefined &&
            preview.clockify.seconds < (requested ?? selected)) ||
          (targets.jira && preview.jira.seconds < (requested ?? selected))
            ? " Reduced to the time this block can still write in the current read."
            : ""}
        </p>
      ) : preview === undefined ? null : (
        <p className="jcf-muted">No additional time from this block in the current read.</p>
      )}
      {preview?._tag === "Write" && preview.clockify.refusal === "unlinked-overlap" ? (
        <p className="jcf-note" data-tone="warning" role="status">
          An unlinked Clockify entry overlaps this block. Review it before logging Clockify time; Jira can proceed.
        </p>
      ) : null}
      <div className="jcf-actions">
        <Button
          disabled={props.unavailable || amountProblem !== null || ticketProblem !== null || noTargets}
          loading={props.busy}
          onClick={() =>
            props.onConfirm({
              // Positions, never durations: the server holds the blocks and sizes the write.
              blocks: [props.blockIndex],
              note: note.trim() === "" ? undefined : note.trim(),
              seconds: requestSeconds,
              targets,
              ticketKey: retargeted ? ticketKey : undefined
            })
          }
          variant="primary"
        >
          Log selected time
        </Button>
        <Button disabled={props.busy} onClick={props.onCancel} variant="quiet">
          Cancel
        </Button>
      </div>
    </section>
  )
}

export interface ManualSubmission {
  readonly day: string
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
  readonly days: ReadonlyArray<string>
  readonly day: string
  readonly busy: boolean
  readonly startClock: string
  readonly scopeTargets: WriteTargetsRequest
  readonly onLog: (submission: ManualSubmission) => void
  readonly onCancel: () => void
}) => {
  const [ticketKey, setTicketKey] = useState("")
  const [amount, setAmount] = useState("")
  const [day, setDay] = useState(props.day)
  const [startClock, setStartClock] = useState(props.startClock)
  const [note, setNote] = useState("")
  const [chosenTargets, setTargets] = useState({ jira: true, clockify: true })
  const targets = {
    jira: props.scopeTargets.jira && chosenTargets.jira,
    clockify: props.scopeTargets.clockify && chosenTargets.clockify
  }

  const seconds = parseDuration(amount.trim())
  const ticketOk = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(ticketKey)
  const clockOk = startClock.trim() === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(startClock.trim())
  const amountOk = seconds !== null && seconds >= (targets.jira ? 60 : 1) && seconds <= 86400

  return (
    <section aria-label={`Log time by hand on ${day}`} className="jcf-panel">
      <h2>Log time</h2>
      <p className="jcf-muted">
        Adds the amount you enter to the selected systems. Use this for meetings or other work your sessions did not
        record.
      </p>
      <div className="jcf-fields">
        <TextField
          label="Issue key"
          onChange={(value) => setTicketKey(value.toUpperCase())}
          placeholder="PROJ-123"
          value={ticketKey}
          error={ticketKey !== "" && !ticketOk ? "Enter an issue key such as PROJ-123." : undefined}
        />
        <Field label="Day" className="jcf-field">
          {(control) => (
            <select {...control} value={day} onChange={(event) => setDay(event.target.value)}>
              {props.days.map((date) => (
                <option key={date} value={date}>
                  {new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric"
                  })}
                </option>
              ))}
            </select>
          )}
        </Field>
        <TextField
          label="Amount"
          onChange={setAmount}
          placeholder="45m"
          value={amount}
          error={
            amount !== "" && !amountOk
              ? targets.jira
                ? "Enter between 1m and 24h, for example 45m."
                : "Enter between 1s and 24h, for example 45s."
              : undefined
          }
        />
        <TextField
          label="Started (optional)"
          type="time"
          onChange={setStartClock}
          value={startClock}
          error={clockOk ? undefined : "Enter a time between 00:00 and 23:59."}
        />
        <TextField maxLength={500} label="What was done (optional)" multiline onChange={setNote} value={note} wide />
        <TargetPicker allowed={props.scopeTargets} onChange={setTargets} targets={targets} />
      </div>
      {clockOk ? null : (
        <p className="jcf-note" data-tone="failure">
          Start time reads as HH:MM.
        </p>
      )}
      <div className="jcf-actions">
        <Button
          disabled={props.busy || !amountOk || !ticketOk || !clockOk || (!targets.clockify && !targets.jira)}
          loading={props.busy}
          onClick={() => {
            if (seconds === null) return
            props.onLog({
              day,
              note: note.trim() === "" ? undefined : note.trim(),
              seconds,
              startClock: startClock.trim() === "" ? undefined : startClock.trim(),
              targets,
              ticketKey
            })
          }}
          variant="primary"
        >
          Log time
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
      <h2>Map sessions to a ticket</h2>
      <p className="jcf-muted">
        Sessions under this directory will be placed on this Issue Key from now on, unless a branch or a path names one.
        This saves the mapping and refreshes the week. It does not log time.
      </p>
      <div className="jcf-fields">
        <TextField label="Directory" onChange={setCwd} value={cwd} wide />
        <TextField
          label="Issue key"
          onChange={(value) => setTicketKey(value.toUpperCase())}
          placeholder="PROJ-123"
          value={ticketKey}
          error={ticketKey !== "" && !ticketOk ? "Enter an issue key such as PROJ-123." : undefined}
        />
      </div>
      <div className="jcf-actions">
        <Button
          disabled={props.busy || !ticketOk || cwd.trim() === ""}
          loading={props.busy}
          onClick={() => props.onMap({ cwd: cwd.trim(), ticketKey })}
          variant="primary"
        >
          Save mapping
        </Button>
        <Button disabled={props.busy} onClick={props.onCancel} variant="quiet">
          Cancel
        </Button>
      </div>
    </section>
  )
}
