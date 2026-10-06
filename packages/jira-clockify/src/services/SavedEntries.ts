/** Edit, delete or replace retained provider entries after owner, contents and writer checks. */
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { JiraApiClient } from "@knpkv/jira-api-client"
import { Context, DateTime, Effect, FileSystem, Layer, Path, Predicate, Schema, Semaphore } from "effect"
import { isTicketKey } from "../agent/sessions.js"
import * as SourceConsumption from "../agent/sourceConsumption.js"
import * as WriterGuard from "../cli/writerGuard.js"
import { ClockifyAuth } from "./ClockifyAuth.js"
import { ConfigService } from "./ConfigService.js"
import { make as makeProviderSnapshots } from "./ProviderSnapshots.js"
import { parseTicketKey, type ProviderScopes } from "./ReconcileService.js"
import { SourceLedger } from "./SourceLedger.js"

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
  reason: Schema.Literals(["validation", "conflict", "provider", "partial"]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
  replacement: Schema.optionalKey(RecordedEntry)
}) {}

export interface SavedEntryUpdate {
  /** Retained server-owned snapshot; never accept this value directly from a browser. */
  readonly expected: RecordedEntry
  readonly startMs: number
  readonly endMs: number
  readonly description: string
  /** Changing the ticket creates a replacement before deleting the original. */
  readonly ticketKey?: string
  /** Server-private provider scope retained by the read, never accepted from the browser. */
  readonly expectedScopes?: ProviderScopes
}

export interface SavedEntryRemove {
  readonly expected: RecordedEntry
  readonly expectedScopes?: ProviderScopes
}

export class SavedEntries extends Context.Service<SavedEntries, {
  readonly update: (input: SavedEntryUpdate) => Effect.Effect<RecordedEntry, SavedEntryError>
  readonly remove: (input: SavedEntryRemove) => Effect.Effect<void, SavedEntryError>
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
    const snapshots = yield* makeProviderSnapshots
    const ledger = yield* SourceLedger
    const config = yield* ConfigService
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const guarded = <A>(effect: Effect.Effect<A, SavedEntryError>) =>
      WriterGuard.mutate(effect).pipe(
        Effect.mapError((cause) => cause._tag === "SavedEntryError" ? cause : failure("conflict", cause.message)),
        Effect.provideService(ConfigService, config),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path)
      )
    // One permit also bounds provider writes. It covers re-read through save, including across callers.
    const permit = yield* Semaphore.make(1)

    const checkScope = (source: RecordedEntry["source"], heldScope: string, expectedScopes?: ProviderScopes) =>
      expectedScopes !== undefined && expectedScopes[source] !== heldScope
        ? Effect.fail(failure("conflict", "The provider account changed; reload the week before changing this entry."))
        : Effect.void

    const checkLedger = Effect.fn("SavedEntries.checkLedger")(
      function*(expected: RecordedEntry, scope: string, legacyScope?: string, resolvingReplacement: boolean = false) {
        if (legacyScope !== undefined) {
          yield* ledger.assertNoLegacyClockify(legacyScope).pipe(Effect.mapError(providerError))
        }
        const stored = yield* ledger.read.pipe(Effect.mapError(providerError))
        const replacement = stored.replacementIntents.find((intent) =>
          intent.provider === expected.source && intent.scope === scope
        )
        // Only the move being resolved may pass its own verified replacement; anything else waits.
        const resolvesThisMove: boolean = resolvingReplacement === true && replacement?._tag === "Verified" &&
          (replacement.entryId === expected.id || replacement.replacement.entryId === expected.id)
        if (replacement !== undefined && !resolvesThisMove) {
          return yield* failure(
            "conflict",
            "This provider has an unresolved saved-entry replacement; review it before retrying."
          )
        }
        if (
          SourceConsumption.markers(expected.description ?? "").length > 0 &&
          !stored.bindings.some((binding) =>
            binding.provider === expected.source && binding.scope === scope && binding.entryId === expected.id
          )
        ) {
          return yield* failure(
            "conflict",
            "This entry has an unlinked session marker; review it before changing saved time."
          )
        }
        if (stored.pending.some((pending) => pending.provider === expected.source && pending.scope === scope)) {
          return yield* failure(
            "conflict",
            "This provider has an unresolved session write; review it before changing saved time."
          )
        }
        // A held window is readable but must not authorize a delete or replacement of a claimed entry.
        // An ordinary entry carries no claim, so a week never scanned for sessions does not hold it.
        const claimed = stored.bindings.some((binding) =>
          binding.provider === expected.source && binding.scope === scope && binding.entryId === expected.id
        )
        if (
          claimed &&
          !stored.reviewedWindows.some((window) =>
            window.provider === expected.source && window.scope === scope &&
            window.fromMs <= expected.startMs && window.toMs >= expected.endMs
          )
        ) {
          return yield* failure("conflict", "This provider window needs manual review before saved time can change.")
        }
      }
    )

    const readClockify = Effect.fn("SavedEntries.readClockify")(
      function*(input: SavedEntryRemove, resolvingReplacement: boolean = false) {
        const snapshot = yield* snapshots.clockify.pipe(Effect.mapError(providerError))
        yield* checkScope("clockify", snapshot.scope, input.expectedScopes)
        yield* checkLedger(input.expected, snapshot.scope, snapshot.legacyScope, resolvingReplacement)
        const current = yield* snapshot.client.getTimeEntry(snapshot.auth.workspaceId, input.expected.id, undefined)
          .pipe(
            Effect.mapError(providerError)
          )
        if (
          current.userId !== snapshot.auth.userId || current.workspaceId !== snapshot.auth.workspaceId ||
          current.timeInterval.end == null || current.isLocked === true ||
          (current.type !== undefined && current.type !== "REGULAR" && current.type !== "BREAK")
        ) {
          return yield* failure(
            "conflict",
            "This Clockify entry is running, locked, managed by time off, or owned by another user."
          )
        }
        const actual: RecordedEntry = {
          id: current.id,
          source: "clockify",
          ticketKey: parseTicketKey(current.description),
          startMs: yield* instant(current.timeInterval.start),
          endMs: yield* instant(current.timeInterval.end),
          description: current.description
        }
        yield* assertExpected(actual, input.expected)
        return { snapshot, current }
      }
    )

    const readJira = Effect.fn("SavedEntries.readJira")(
      function*(input: SavedEntryRemove, resolvingReplacement: boolean = false) {
        if (input.expected.ticketKey === null) {
          return yield* failure("validation", "Jira worklogs require an issue key.")
        }
        const snapshot = (yield* snapshots.jira).snapshot
        if (snapshot === null) return yield* failure("conflict", "Cannot verify the selected Jira account.")
        yield* checkScope("jira", snapshot.heldScope, input.expectedScopes)
        yield* checkLedger(input.expected, snapshot.ledgerScope, undefined, resolvingReplacement)
        const current = yield* snapshot.client.getWorklog(input.expected.ticketKey, input.expected.id, undefined).pipe(
          Effect.mapError(providerError)
        )
        if (current.author?.accountId !== snapshot.accountId) {
          return yield* failure("conflict", "Saved worklog is not owned by the current Jira user.")
        }
        if (current.id === undefined || current.timeSpentSeconds === undefined) {
          return yield* failure("provider", "Jira returned an incomplete worklog.")
        }
        const startMs = yield* instant(current.started)
        yield* assertExpected({
          id: current.id,
          source: "jira",
          ticketKey: input.expected.ticketKey,
          startMs,
          endMs: startMs + current.timeSpentSeconds * 1000,
          description: yield* jiraWorklogDescription(current.comment)
        }, input.expected)
        return { snapshot, current, ticketKey: input.expected.ticketKey }
      }
    )

    const remove = Effect.fn("SavedEntries.remove")(function*(input: SavedEntryRemove) {
      let scope: string
      if (input.expected.source === "jira") {
        const { snapshot, ticketKey } = yield* readJira(input, true)
        scope = snapshot.ledgerScope
        yield* snapshot.client.deleteWorklog(ticketKey, input.expected.id, { params: { adjustEstimate: "leave" } })
          .pipe(Effect.mapError(providerError))
      } else {
        const { snapshot } = yield* readClockify(input, true)
        scope = snapshot.scope
        yield* snapshot.client.deleteTimeEntry(snapshot.auth.workspaceId, input.expected.id, undefined).pipe(
          Effect.mapError(providerError)
        )
      }
      yield* ledger.removeEntry({ provider: input.expected.source, scope, entryId: input.expected.id }).pipe(
        Effect.mapError((cause) =>
          new SavedEntryError({
            reason: "provider",
            message:
              "The entry was deleted, but its session claim could not be released, so its time is not suggested again. Reload the week.",
            cause
          })
        )
      )
    }, (effect) => permit.withPermits(1)(guarded(effect)))

    const finishReplacement = Effect.fn("SavedEntries.finishReplacement")(function*(options: {
      readonly expected: RecordedEntry
      readonly replacement: RecordedEntry
      readonly scope: string
      readonly deleteOriginal: Effect.Effect<void, SavedEntryError>
      readonly createdAtMs?: number
    }) {
      const partial = (cause: unknown) =>
        new SavedEntryError({
          reason: "partial",
          message:
            "A replacement was created; the original entry may still exist. Refresh and review both entries before retrying.",
          replacement: options.replacement,
          cause
        })
      const identity = { provider: options.expected.source, scope: options.scope, entryId: options.expected.id }
      yield* ledger.verifyReplacement(identity, {
        entryId: options.replacement.id,
        ticketKey: options.replacement.ticketKey ?? "",
        startMs: options.replacement.startMs,
        endMs: options.replacement.endMs,
        ...(options.createdAtMs !== undefined && { jiraCreatedAtMs: options.createdAtMs })
      }).pipe(Effect.mapError(partial))
      yield* options.deleteOriginal.pipe(Effect.mapError(partial))
      yield* ledger.removeEntry(identity).pipe(Effect.mapError(partial))
      return options.replacement
    })

    const reserveReplacement = (input: SavedEntryUpdate, ticketKey: string, scope: string, description: string) =>
      ledger.reserveReplacement({
        provider: input.expected.source,
        scope,
        entryId: input.expected.id,
        originalTicketKey: input.expected.ticketKey,
        ticketKey,
        startMs: input.startMs,
        endMs: input.endMs,
        description
      }).pipe(Effect.mapError((cause) => new SavedEntryError({ reason: "conflict", message: cause.message, cause })))

    const identifyReplacement = (expected: RecordedEntry, scope: string, replacement: RecordedEntry) =>
      ledger.identifyReplacement({ provider: expected.source, scope, entryId: expected.id }, replacement.id).pipe(
        Effect.mapError((cause) =>
          new SavedEntryError({
            reason: "partial",
            message:
              "A replacement was created but its identity could not be retained. Refresh and review before retrying.",
            replacement,
            cause
          })
        )
      )

    const retarget = Effect.fn("SavedEntries.retarget")(function*(input: SavedEntryUpdate, ticketKey: string) {
      if (input.expected.source === "jira") {
        const { current, snapshot, ticketKey: oldTicketKey } = yield* readJira(input)
        if (input.endMs - input.startMs < 60_000) {
          return yield* failure("validation", "Jira worklogs require at least 60 seconds when changing tickets.")
        }
        const text = SourceConsumption.retainMarkers(input.expected.description ?? "", input.description)
        yield* reserveReplacement(input, ticketKey, snapshot.ledgerScope, text)
        const created = yield* snapshot.client.addWorklog(ticketKey, {
          params: { adjustEstimate: "leave" },
          payload: {
            started: DateTime.formatIso(DateTime.makeUnsafe(input.startMs)).replace("Z", "+0000"),
            timeSpentSeconds: Math.floor((input.endMs - input.startMs) / 1000),
            // A restricted worklog must not reappear unrestricted under the new ticket.
            ...(current.visibility !== undefined && { visibility: current.visibility }),
            ...(text === (input.expected.description ?? "") && current.comment !== undefined
              ? { comment: current.comment }
              : {
                comment: {
                  type: "doc",
                  version: 1,
                  content: text.split("\n").map((line) => ({
                    type: "paragraph",
                    content: line === "" ? [] : [{ type: "text", text: line }]
                  }))
                }
              })
          }
        }).pipe(Effect.mapError(providerError))
        if (created.id === undefined || created.id.trim() === "") {
          return yield* failure(
            "partial",
            "Jira may have created a replacement without returning its identity; the original was retained. Refresh before retrying."
          )
        }
        const knownReplacement: RecordedEntry = {
          id: created.id,
          source: "jira",
          ticketKey,
          startMs: input.startMs,
          endMs: input.endMs,
          description: text
        }
        yield* identifyReplacement(input.expected, snapshot.ledgerScope, knownReplacement)
        const saved = yield* snapshot.client.getWorklog(ticketKey, created.id, undefined).pipe(
          Effect.mapError((cause) =>
            new SavedEntryError({
              reason: "partial",
              message:
                "A Jira replacement was created but could not be verified; the original was retained. Refresh before retrying.",
              replacement: knownReplacement,
              cause
            })
          )
        )
        if (
          saved.id !== created.id || saved.author?.accountId !== snapshot.accountId ||
          saved.timeSpentSeconds === undefined ||
          saved.visibility?.type !== current.visibility?.type ||
          (current.visibility?.value !== undefined && saved.visibility?.value !== current.visibility.value) ||
          (current.visibility?.identifier != null && saved.visibility?.identifier !== current.visibility.identifier)
        ) {
          return yield* new SavedEntryError({
            reason: "partial",
            message: "Jira returned an incomplete replacement; the original was retained. Refresh before retrying.",
            replacement: knownReplacement
          })
        }
        const startMs = yield* instant(saved.started)
        const replacement: RecordedEntry = {
          id: saved.id,
          source: "jira",
          ticketKey,
          startMs,
          endMs: startMs + saved.timeSpentSeconds * 1000,
          description: yield* jiraWorklogDescription(saved.comment)
        }
        if (
          replacement.startMs !== input.startMs ||
          saved.timeSpentSeconds !== Math.floor((input.endMs - input.startMs) / 1000) ||
          replacement.description !== text
        ) {
          return yield* new SavedEntryError({
            reason: "partial",
            message: "Jira returned an unexpected replacement; the original was retained. Refresh before retrying.",
            replacement: knownReplacement
          })
        }
        return yield* finishReplacement({
          expected: input.expected,
          replacement,
          scope: snapshot.ledgerScope,
          ...(saved.created !== undefined && { createdAtMs: yield* instant(saved.created) }),
          deleteOriginal: readJira({
            expected: input.expected,
            expectedScopes: input.expectedScopes ?? { jira: snapshot.heldScope, clockify: null }
          }, true).pipe(
            Effect.andThen(
              snapshot.client.deleteWorklog(oldTicketKey, input.expected.id, {
                params: { adjustEstimate: "leave" }
              }).pipe(Effect.mapError(providerError))
            )
          )
        })
      }
      const { current, snapshot } = yield* readClockify(input)
      if ((current.customFieldValues?.length ?? 0) > 0) {
        return yield* failure("validation", "Clockify entries with custom fields cannot be moved safely yet.")
      }
      const text = SourceConsumption.retainMarkers(input.expected.description ?? "", input.description)
      const description = `[${ticketKey}] ${text.replace(/^\s*(?:\[[A-Z0-9]+-\d+\]|[A-Z0-9]+-\d+:)\s*/, "")}`
      yield* reserveReplacement(input, ticketKey, snapshot.scope, description)
      const saved = yield* snapshot.client.createTimeEntry(snapshot.auth.workspaceId, {
        payload: {
          start: DateTime.formatIso(DateTime.makeUnsafe(input.startMs)),
          end: DateTime.formatIso(DateTime.makeUnsafe(input.endMs)),
          description,
          billable: current.billable,
          ...(current.projectId != null && { projectId: current.projectId }),
          ...(current.taskId != null && { taskId: current.taskId }),
          ...(current.tagIds != null && { tagIds: current.tagIds }),
          ...((current.type === "BREAK" || current.type === "REGULAR") && { type: current.type })
        }
      }).pipe(Effect.mapError(providerError))
      const knownReplacement: RecordedEntry = {
        id: saved.id,
        source: "clockify",
        ticketKey,
        startMs: input.startMs,
        endMs: input.endMs,
        description
      }
      yield* identifyReplacement(input.expected, snapshot.scope, knownReplacement)
      const replacement: RecordedEntry = {
        id: saved.id,
        source: "clockify",
        ticketKey: parseTicketKey(saved.description),
        startMs: yield* instant(saved.timeInterval.start),
        endMs: yield* instant(saved.timeInterval.end),
        description: saved.description
      }
      if (
        saved.userId !== snapshot.auth.userId || saved.workspaceId !== snapshot.auth.workspaceId ||
        replacement.ticketKey !== ticketKey || replacement.startMs !== input.startMs ||
        replacement.endMs !== input.endMs || replacement.description !== description
      ) {
        return yield* new SavedEntryError({
          reason: "partial",
          message: "Clockify returned an unexpected replacement; the original was retained. Refresh before retrying.",
          replacement: knownReplacement
        })
      }
      return yield* finishReplacement({
        expected: input.expected,
        replacement,
        scope: snapshot.scope,
        deleteOriginal: readClockify({
          expected: input.expected,
          expectedScopes: input.expectedScopes ?? { clockify: snapshot.scope, jira: null }
        }, true).pipe(
          Effect.andThen(
            snapshot.client.deleteTimeEntry(snapshot.auth.workspaceId, input.expected.id, undefined).pipe(
              Effect.mapError(providerError)
            )
          )
        )
      })
    })

    const updateClockify = Effect.fn("SavedEntries.updateClockify")(function*(input: SavedEntryUpdate) {
      const { description, endMs, expected, startMs } = input
      const snapshot = input.expectedScopes === undefined
        ? undefined
        : yield* snapshots.clockify.pipe(Effect.mapError(providerError))
      if (snapshot !== undefined) yield* checkScope("clockify", snapshot.scope, input.expectedScopes)
      const auth = snapshot?.auth ?? (yield* clockifyAuth.getConfig.pipe(Effect.mapError(providerError)))
      const owner = yield* (snapshot === undefined ? clockify.getUser() : snapshot.client.getLoggedUser(undefined))
        .pipe(Effect.mapError(providerError))
      const current = yield* (snapshot === undefined
        ? clockify.getTimeEntry(auth.workspaceId, expected.id)
        : snapshot.client.getTimeEntry(auth.workspaceId, expected.id, undefined)).pipe(Effect.mapError(providerError))
      if (owner.id !== auth.userId || current.userId !== owner.id || current.workspaceId !== auth.workspaceId) {
        return yield* failure("conflict", "Saved entry is not owned by the current Clockify user.")
      }
      if (current.timeInterval.end == null) {
        return yield* failure("conflict", "Running entries cannot be edited here.")
      }
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
      const payload = {
        start: DateTime.formatIso(DateTime.makeUnsafe(startMs)),
        end: DateTime.formatIso(DateTime.makeUnsafe(endMs)),
        description: retainedDescription,
        billable: current.billable,
        ...(current.projectId != null && { projectId: current.projectId }),
        ...(current.taskId != null && { taskId: current.taskId }),
        ...(current.tagIds != null && { tagIds: current.tagIds }),
        ...((current.type === "BREAK" || current.type === "REGULAR") && { type: current.type })
      }
      const saved = yield* (snapshot === undefined
        ? clockify.updateTimeEntry(auth.workspaceId, expected.id, payload)
        : snapshot.client.updateTimeEntry(auth.workspaceId, expected.id, { payload })).pipe(
          Effect.mapError(providerError)
        )
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
      const snapshot = input.expectedScopes === undefined ? undefined : (yield* snapshots.jira).snapshot
      if (snapshot === null) return yield* failure("conflict", "Cannot verify the selected Jira account.")
      if (snapshot !== undefined) yield* checkScope("jira", snapshot.heldScope, input.expectedScopes)
      const client = snapshot?.client ?? jira
      const accountId = snapshot?.accountId ??
        (yield* client.getCurrentUser(undefined).pipe(Effect.mapError(providerError))).accountId
      if (accountId === undefined) {
        return yield* failure("conflict", "Cannot establish the current Jira worklog owner.")
      }
      const current = yield* client.getWorklog(expected.ticketKey, expected.id, undefined).pipe(
        Effect.mapError(providerError)
      )
      if (current.author?.accountId !== accountId) {
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
      const saved = yield* client.updateWorklog(expected.ticketKey, expected.id, {
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
      if (input.ticketKey !== undefined && !isTicketKey(input.ticketKey)) {
        return yield* failure("validation", "Choose a valid Jira issue key.")
      }
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
      return yield* (input.ticketKey !== undefined && input.ticketKey !== expected.ticketKey
        ? guarded(retarget(input, input.ticketKey))
        : expected.source === "jira"
        ? updateJira(input)
        : updateClockify(input))
    }, (effect) => permit.withPermits(1)(guarded(effect)))
    return SavedEntries.of({ update, remove })
  })
)
