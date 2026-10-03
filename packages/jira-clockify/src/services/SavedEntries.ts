/** Update one retained provider entry after checking its owner and current contents. */
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { JiraApiClient } from "@knpkv/jira-api-client"
import { Context, DateTime, Effect, Layer, Predicate, Schema, Semaphore } from "effect"
import * as SourceConsumption from "../agent/sourceConsumption.js"
import { ClockifyAuth } from "./ClockifyAuth.js"
import { parseTicketKey } from "./ReconcileService.js"

/** The entire provider entry. Day slices must retain these original bounds and description. */
export const RecordedEntry = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["jira", "clockify"]),
  ticketKey: Schema.NullOr(Schema.String),
  startMs: Schema.Number,
  endMs: Schema.Number,
  description: Schema.NullOr(Schema.String)
})
export interface RecordedEntry extends Schema.Schema.Type<typeof RecordedEntry> {}

export class SavedEntryError extends Schema.TaggedError<SavedEntryError>()("SavedEntryError", {
  reason: Schema.Literals(["validation", "conflict", "provider"]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export interface SavedEntryUpdate {
  /** Retained server-owned snapshot; never accept this value directly from a browser. */
  readonly expected: RecordedEntry
  readonly startMs: number
  readonly endMs: number
  readonly description: string
}

export class SavedEntries extends Context.Service<SavedEntries, {
  readonly update: (input: SavedEntryUpdate) => Effect.Effect<RecordedEntry, SavedEntryError>
}>()("jcf/SavedEntries") {}

const failure = (reason: SavedEntryError["reason"], message: string) => new SavedEntryError({ reason, message })
const providerError = (cause: unknown) => {
  const status = Predicate.isTagged(cause, "HttpClientError") && "response" in cause &&
      Predicate.isObject(cause.response) ?
    cause.response.status :
    undefined
  return new SavedEntryError({
    reason:
      Predicate.isTagged(cause, "GetWorklog404") || Predicate.isTagged(cause, "UpdateWorklog404") || status === 404
        ? "conflict" :
        "provider",
    message: status === 404 || Predicate.isTagged(cause, "GetWorklog404")
      ? "Saved entry no longer exists; refresh before editing." :
      "Could not read or update the saved provider entry.",
    cause
  })
}

interface AdfNode {
  readonly type: string
  readonly text?: string
  readonly attrs?: { readonly text?: string; readonly shortName?: string }
  readonly content?: ReadonlyArray<AdfNode>
}
const AdfNode: Schema.Codec<AdfNode> = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  attrs: Schema.optionalKey(Schema.Struct({
    text: Schema.optionalKey(Schema.String),
    shortName: Schema.optionalKey(Schema.String)
  })),
  content: Schema.optionalKey(Schema.Array(Schema.suspend(() => AdfNode)))
})

/**
 * Read text and mention/emoji labels without trimming or inserting spaces between inline nodes.
 * Missing labels get explicit markers. Cards, media and other embeds have no text representation
 * here; time-only edits retain them because the update omits the original comment entirely.
 */
const adfText = (node: AdfNode): string => {
  if (node.text !== undefined) return node.text
  if (node.type === "hardBreak") return "\n"
  if (node.type === "mention") return node.attrs?.text ?? "[mention]"
  if (node.type === "emoji") return node.attrs?.text ?? node.attrs?.shortName ?? "[emoji]"
  const separator = node.type === "doc" || node.type === "bulletList" || node.type === "orderedList" ? "\n" : ""
  return (node.content ?? []).map(adfText).join(separator)
}

/** Jira comments can be absent, plain strings, or ADF; malformed documents are a provider failure. */
export const jiraWorklogDescription = Effect.fn("SavedEntries.jiraWorklogDescription")(
  function*(comment: Schema.Json | undefined) {
    if (comment === undefined || comment === null) return null
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Union([Schema.String, AdfNode]))(comment).pipe(
      Effect.mapError(providerError)
    )
    return Predicate.isString(decoded) ? decoded : adfText(decoded)
  }
)

const assertExpected = (actual: RecordedEntry, expected: RecordedEntry) =>
  actual.id === expected.id && actual.source === expected.source && actual.ticketKey === expected.ticketKey &&
    actual.startMs === expected.startMs && actual.endMs === expected.endMs &&
    actual.description === expected.description
    ? Effect.void
    : Effect.fail(failure("conflict", "Saved entry changed; refresh before editing."))

const instant = (value: string | null | undefined) =>
  Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(value).pipe(
    Effect.map(DateTime.toEpochMillis),
    Effect.mapError(providerError)
  )

export const layer = Layer.effect(
  SavedEntries,
  Effect.gen(function*() {
    const clockify = yield* ClockifyApiClient
    const clockifyAuth = yield* ClockifyAuth
    const jira = yield* JiraApiClient
    // One permit also bounds provider writes. It covers re-read through save, including across callers.
    const permit = yield* Semaphore.make(1)

    const updateClockify = Effect.fn("SavedEntries.updateClockify")(function*(input: SavedEntryUpdate) {
      const { description, endMs, expected, startMs } = input
      const auth = yield* clockifyAuth.getConfig.pipe(Effect.mapError(providerError))
      const owner = yield* clockify.getUser().pipe(Effect.mapError(providerError))
      const current = yield* clockify.getTimeEntry(auth.workspaceId, expected.id).pipe(Effect.mapError(providerError))
      if (owner.id !== auth.userId || current.userId !== owner.id || current.workspaceId !== auth.workspaceId) {
        return yield* failure("conflict", "Saved entry is not owned by the current Clockify user.")
      }
      if (current.timeInterval.end == null) return yield* failure("conflict", "Running entries cannot be edited here.")
      const actual: RecordedEntry = {
        id: current.id,
        source: "clockify",
        ticketKey: parseTicketKey(current.description),
        startMs: yield* instant(current.timeInterval.start),
        endMs: yield* instant(current.timeInterval.end),
        description: current.description
      }
      yield* assertExpected(actual, expected)
      const retainedDescription = SourceConsumption.retainMarkers(current.description ?? "", description)
      if (
        current.isLocked === true ||
        (current.type !== undefined && current.type !== "REGULAR" && current.type !== "BREAK")
      ) {
        return yield* failure("conflict", "This Clockify entry is locked or managed by time off.")
      }
      // The generated custom-field schema cannot round-trip arbitrary values. Refuse to erase them.
      if ((current.customFieldValues?.length ?? 0) > 0) {
        return yield* failure("validation", "Clockify entries with custom fields cannot be edited safely yet.")
      }
      const saved = yield* clockify.updateTimeEntry(auth.workspaceId, expected.id, {
        start: DateTime.formatIso(DateTime.makeUnsafe(startMs)),
        end: DateTime.formatIso(DateTime.makeUnsafe(endMs)),
        description: retainedDescription,
        billable: current.billable,
        ...(current.projectId != null && { projectId: current.projectId }),
        ...(current.taskId != null && { taskId: current.taskId }),
        ...(current.tagIds != null && { tagIds: current.tagIds }),
        ...(current.type !== undefined && { type: current.type })
      }).pipe(Effect.mapError(providerError))
      return {
        id: saved.id,
        source: "clockify",
        ticketKey: parseTicketKey(saved.description),
        startMs: yield* instant(saved.timeInterval.start),
        endMs: yield* instant(saved.timeInterval.end),
        description: saved.description
      } satisfies RecordedEntry
    })

    const updateJira = Effect.fn("SavedEntries.updateJira")(function*(input: SavedEntryUpdate) {
      const { description, endMs, expected, startMs } = input
      if (expected.ticketKey === null) return yield* failure("validation", "Jira worklogs require an issue key.")
      const owner = yield* jira.getCurrentUser(undefined).pipe(Effect.mapError(providerError))
      if (owner.accountId === undefined) {
        return yield* failure("conflict", "Cannot establish the current Jira worklog owner.")
      }
      const current = yield* jira.getWorklog(expected.ticketKey, expected.id, undefined).pipe(
        Effect.mapError(providerError)
      )
      if (current.author?.accountId !== owner.accountId) {
        return yield* failure("conflict", "Saved worklog is not owned by the current Jira user.")
      }
      const currentStart = yield* instant(current.started)
      if (current.timeSpentSeconds === undefined || current.id === undefined) {
        return yield* failure("provider", "Jira returned a worklog without its identity or duration.")
      }
      const actual: RecordedEntry = {
        id: current.id,
        source: "jira",
        ticketKey: expected.ticketKey,
        startMs: currentStart,
        endMs: currentStart + current.timeSpentSeconds * 1000,
        description: yield* jiraWorklogDescription(current.comment)
      }
      yield* assertExpected(actual, expected)
      const retainedDescription = SourceConsumption.retainMarkers(actual.description ?? "", description)
      const timeChanged = startMs !== expected.startMs || endMs !== expected.endMs
      const saved = yield* jira.updateWorklog(expected.ticketKey, expected.id, {
        params: { adjustEstimate: "leave" },
        payload: {
          ...(timeChanged &&
            {
              started: DateTime.formatIso(DateTime.makeUnsafe(startMs)).replace("Z", "+0000"),
              timeSpentSeconds: (endMs - startMs) / 1000
            }),
          // Omitting unchanged comments preserves their full ADF and long original content.
          ...(retainedDescription !== (expected.description ?? "") && {
            comment: {
              type: "doc",
              version: 1,
              content: retainedDescription.split("\n").map((text) => ({
                type: "paragraph",
                content: text === "" ? [] : [{ type: "text", text }]
              }))
            }
          })
        }
      }).pipe(Effect.mapError(providerError))
      if (saved.id === undefined || saved.timeSpentSeconds === undefined) {
        return yield* failure("provider", "Jira returned an incomplete saved worklog.")
      }
      const savedStart = yield* instant(saved.started)
      return {
        id: saved.id,
        source: "jira",
        ticketKey: expected.ticketKey,
        startMs: savedStart,
        endMs: savedStart + saved.timeSpentSeconds * 1000,
        description: yield* jiraWorklogDescription(saved.comment)
      } satisfies RecordedEntry
    })

    const update = Effect.fn("SavedEntries.update")(function*(input: SavedEntryUpdate) {
      const { endMs, expected, startMs } = input
      const changed = startMs !== expected.startMs || endMs !== expected.endMs
      if (
        !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) ||
        Math.abs(startMs) > 8.64e15 || Math.abs(endMs) > 8.64e15 || endMs <= startMs ||
        (changed && (startMs % 1000 !== 0 || endMs % 1000 !== 0))
      ) {
        return yield* failure(
          "validation",
          "Use valid start and end times with whole-second precision and a positive duration."
        )
      }
      if (expected.source === "jira" && changed && endMs - startMs < 60_000) {
        return yield* failure("validation", "Jira worklogs require at least 60 seconds when changing time.")
      }
      return yield* (expected.source === "jira" ? updateJira(input) : updateClockify(input))
    }, permit.withPermits(1))
    return SavedEntries.of({ update })
  })
)
