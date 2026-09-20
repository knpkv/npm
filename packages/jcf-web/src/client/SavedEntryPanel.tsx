import { Button, Field } from "@knpkv/rly/primitives"
import { useEffect, useRef, useState } from "react"
import type { SavedEntry, UpdateSavedEntryRequest } from "../shared/contracts.js"
import * as Predicate from "effect/Predicate"
import { describeSavedEntry } from "./api.js"
import { formatDuration } from "./format.js"
import { resolveLocalDateTime } from "./localDateTime.js"

/** Local controls include seconds; an unchanged field keeps the original instant, including a DST fold. */
const localDateTime = (milliseconds: number): string => {
  const date = new Date(milliseconds)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Edit exactly one whole provider entry. Generation only suggests text; Save is a separate action. */
export const SavedEntryPanel = (props: {
  readonly entry: SavedEntry
  readonly targetVisible: boolean
  readonly planId: string
  readonly busy: boolean
  readonly unavailable: boolean
  readonly descriptionDisabled: boolean
  readonly onSave: (request: UpdateSavedEntryRequest) => Promise<void>
  readonly onCancel: () => void
}) => {
  const { entry } = props
  const [start, setStart] = useState(localDateTime(entry.startMs))
  const [end, setEnd] = useState(localDateTime(entry.endMs))
  const [description, setDescription] = useState(entry.description ?? "")
  const [generating, setGenerating] = useState(false)
  const [generationStatus, setGenerationStatus] = useState<string | null>(null)
  const revision = useRef(0)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  useEffect(() => {
    if (props.descriptionDisabled && pending.current !== null) {
      pending.current.abort()
      pending.current = null
      setGenerating(false)
      setGenerationStatus("Agent settings changed. Generate the description again.")
    }
  }, [props.descriptionDisabled])
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const parsedStart: ReturnType<typeof resolveLocalDateTime> =
    start === localDateTime(entry.startMs)
      ? { _tag: "Valid", instantMs: entry.startMs }
      : resolveLocalDateTime(start, timeZone)
  const parsedEnd: ReturnType<typeof resolveLocalDateTime> =
    end === localDateTime(entry.endMs) ? { _tag: "Valid", instantMs: entry.endMs } : resolveLocalDateTime(end, timeZone)
  const startMs = parsedStart._tag === "Valid" ? parsedStart.instantMs : NaN
  const endMs = parsedEnd._tag === "Valid" ? parsedEnd.instantMs : NaN
  const changedTime = startMs !== entry.startMs || endMs !== entry.endMs
  const invalid =
    parsedStart._tag === "Invalid" || parsedEnd._tag === "Invalid"
      ? "Choose local times that exist only once."
      : endMs <= startMs
        ? "End must be after start."
        : entry.source === "jira" && changedTime && endMs - startMs < 60_000
          ? "Jira time must be at least one minute."
          : undefined
  const provider = entry.source === "jira" ? "Jira" : "Clockify"

  const generate = async () => {
    if (generating || props.busy || props.descriptionDisabled) return
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    const atRevision = revision.current
    setGenerating(true)
    setGenerationStatus(null)
    try {
      const result = await describeSavedEntry(
        { planId: props.planId, source: entry.source, entryId: entry.id },
        controller.signal
      )
      if (controller.signal.aborted) return
      if (revision.current !== atRevision) {
        setGenerationStatus("Your edits were kept. Generate again to replace them.")
      } else if (result.note === null) {
        setGenerationStatus(
          result.sessionCount === 0
            ? "No matching scanned sessions for this entry. Rescan sessions to gather evidence."
            : "No description returned for the matching sessions."
        )
      } else {
        setDescription(result.note)
        setGenerationStatus(
          `Suggested from ${result.sessionCount} matching session${result.sessionCount === 1 ? "" : "s"}. Review the text, then Save changes.`
        )
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setGenerationStatus(Predicate.isError(cause) ? cause.message : "Could not generate a description. Try again.")
    } finally {
      if (pending.current === controller) {
        pending.current = null
        setGenerating(false)
      }
    }
  }

  return (
    <form
      className="jcf-panel"
      onSubmit={(event) => {
        event.preventDefault()
        if (invalid !== undefined || props.unavailable || generating || !props.targetVisible) return
        void props.onSave({
          planId: props.planId,
          source: entry.source,
          entryId: entry.id,
          revision: entry.revision,
          startMs,
          endMs,
          description
        })
      }}
    >
      <h2>
        {entry.ticketKey ?? "No ticket"} · {provider}
      </h2>
      <p className="jcf-muted">Editing the saved {provider} entry. Changes apply only to this entry.</p>
      <div className="jcf-fields">
        <Field className="jcf-field jcf-field-wide" label="Start" required>
          {(control) => (
            <input
              {...control}
              type="datetime-local"
              step="1"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          )}
        </Field>
        <Field
          className="jcf-field jcf-field-wide"
          label="End"
          required
          {...(invalid === undefined ? {} : { error: invalid })}
        >
          {(control) => (
            <input
              {...control}
              type="datetime-local"
              step="1"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          )}
        </Field>
        <p>{invalid === undefined ? formatDuration((endMs - startMs) / 1000) : "Check the time range"}</p>
        <Field className="jcf-field jcf-field-wide" label="What was done (optional)">
          {(control) => (
            <textarea
              {...control}
              rows={4}
              maxLength={32000}
              value={description}
              aria-busy={generating}
              onChange={(event) => {
                revision.current += 1
                setDescription(event.target.value)
              }}
            />
          )}
        </Field>
      </div>
      <Button
        disabled={props.busy || props.descriptionDisabled}
        aria-disabled={generating}
        onClick={() => void generate()}
        size="compact"
        type="button"
      >
        {generating ? "Generating description…" : "Generate description"}
      </Button>
      {generating ? (
        <div className="jcf-description-status" role="status">
          <progress aria-label="Generating work description" />
          <span>Matching scanned sessions and drafting the description…</span>
        </div>
      ) : null}
      {generationStatus === null ? null : (
        <p role="status" className="jcf-muted">
          {generationStatus}
        </p>
      )}
      {props.targetVisible ? null : <p role="status">Select the {provider} layer to save changes to this entry.</p>}
      <div className="jcf-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={props.unavailable || generating || invalid !== undefined || !props.targetVisible}
        >
          {props.busy ? "Saving…" : "Save changes"}
        </Button>
        <Button type="button" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
