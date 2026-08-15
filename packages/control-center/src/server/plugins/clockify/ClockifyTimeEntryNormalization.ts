/** Schema-backed Clockify time-entry normalization. @internal */
import type * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { NormalizedPluginEventV1 } from "../../../domain/plugins/index.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { digestCanonicalGovernedActionJson } from "../../governance/governedActionDigests.js"
import { PluginConfigurationFailure, PluginMalformedResponseFailure } from "../failures.js"

/** Bounded Clockify provider identity accepted by the adapter. @internal */
export const ClockifyIdentifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512)
)
/** Bounded description accepted from Clockify reads. @internal */
export const ClockifyDescription = Schema.String.check(Schema.isMaxLength(4_000))
/** Description accepted by Clockify's generated update contract. @internal */
export const ClockifyWritableDescription = Schema.String.check(Schema.isMaxLength(3_000))
/** Bounded duration returned by Clockify for a time-entry interval. @internal */
export const ClockifyDuration = Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(100))
const ClockifyCustomFieldValue = Schema.Union([
  Schema.String.check(Schema.isMaxLength(4_000)),
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.Json).check(Schema.isMaxLength(100)),
  Schema.Record(Schema.String, Schema.Json)
])
/** Canonical custom-field value required for safe replacement updates. @internal */
export const ClockifyCustomField = Schema.Struct({
  customFieldId: ClockifyIdentifier,
  value: Schema.optionalKey(ClockifyCustomFieldValue)
})
const ClockifyCustomFields = Schema.Array(ClockifyCustomField).check(
  Schema.isMaxLength(50),
  Schema.makeFilter(
    (fields) => new Set(fields.map(({ customFieldId }) => customFieldId)).size === fields.length,
    { expected: "unique Clockify custom field identifiers" }
  )
)
// Clockify's workspace-user response has no profile revision timestamp. Keep the
// observation deterministic so an unchanged person has one immutable payload.
const ClockifyPersonObservedAt = DateTime.makeUnsafe(0)
const ClockifyPersonResponse = Schema.Struct({
  id: ClockifyIdentifier,
  name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  memberships: Schema.optionalKey(Schema.Array(Schema.Struct({
    membershipStatus: Schema.optionalKey(Schema.String),
    membershipType: Schema.optionalKey(Schema.String),
    targetId: Schema.optionalKey(ClockifyIdentifier)
  }))),
  status: Schema.optionalKey(
    Schema.Literals(["ACTIVE", "PENDING_EMAIL_VERIFICATION", "DELETED", "NOT_REGISTERED", "LIMITED", "LIMITED_DELETED"])
  )
})

const ClockifyTimeEntryResponse = Schema.Struct({
  billable: Schema.Boolean,
  customFieldValues: Schema.optionalKey(ClockifyCustomFields),
  description: ClockifyDescription,
  id: ClockifyIdentifier,
  isLocked: Schema.optionalKey(Schema.Boolean),
  projectId: Schema.optionalKey(Schema.NullOr(ClockifyIdentifier)),
  tagIds: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(ClockifyIdentifier).check(
        Schema.makeFilter((values) => values.length <= 100, { expected: "at most 100 Clockify tags" }),
        Schema.isUnique()
      )
    )
  ),
  taskId: Schema.optionalKey(Schema.NullOr(ClockifyIdentifier)),
  timeInterval: Schema.Struct({
    duration: Schema.optionalKey(Schema.NullOr(ClockifyDuration)),
    end: Schema.optionalKey(Schema.NullOr(UtcTimestamp)),
    start: UtcTimestamp
  }),
  type: Schema.optionalKey(Schema.Literals(["REGULAR", "BREAK", "HOLIDAY", "TIME_OFF"])),
  userId: ClockifyIdentifier,
  workspaceId: ClockifyIdentifier
})

type ClockifyTimeEntryEvent = Extract<NormalizedPluginEventV1, { readonly _tag: "UpsertEntity" }>
type ClockifyPersonEvent = Extract<NormalizedPluginEventV1, { readonly _tag: "UpsertPerson" }>

/** Canonical decoded provider snapshot shared by sync and governed actions. @internal */
export interface ClockifyTimeEntrySnapshot {
  readonly billable: boolean
  readonly customFields: ReadonlyArray<typeof ClockifyCustomField.Type>
  readonly customFieldsComplete: boolean
  readonly description: string
  readonly end: DateTime.Utc | null
  readonly entryType: "REGULAR" | "BREAK" | "HOLIDAY" | "TIME_OFF"
  readonly id: string
  readonly isLocked?: boolean
  readonly projectId: string | null
  readonly start: DateTime.Utc
  readonly tagIds: ReadonlyArray<string>
  readonly taskId: string | null
  readonly userId: string
  readonly workspaceId: string
  readonly duration: string | null
}

export interface DecodeClockifyTimeEntryInput {
  readonly allowedUserIds?: ReadonlySet<string> | undefined
  readonly entry: unknown
  readonly expectedWorkspaceId: string
  readonly expectedUserId?: string | undefined
}

const malformed = (diagnosticCode: string) =>
  new PluginMalformedResponseFailure({
    operation: "clockify-normalize-time-entry",
    diagnosticCode
  })

const digestJson = Effect.fn("ClockifyTimeEntryNormalization.digestJson")(function*(value: Schema.Json) {
  return yield* digestCanonicalGovernedActionJson(value).pipe(
    Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "clockify-revision-digest-failed" }))
  )
})

const revisionMaterial = (entry: ClockifyTimeEntrySnapshot): Schema.Json => ({
  billable: entry.billable,
  ...(!(entry.customFields.length === 0) && { customFields: entry.customFields }),
  description: entry.description,
  id: entry.id,
  ...(!(entry.isLocked === undefined) && { isLocked: entry.isLocked }),
  projectId: entry.projectId,
  tagIds: [...entry.tagIds],
  taskId: entry.taskId,
  timeInterval: {
    duration: entry.duration,
    end: entry.end === null ? null : DateTime.formatIso(entry.end),
    start: DateTime.formatIso(entry.start)
  },
  type: entry.entryType,
  userId: entry.userId,
  workspaceId: entry.workspaceId
})

/** Derive the exact normalized source revision used by sync and action preconditions. @internal */
export const revisionOfClockifyTimeEntry = (
  entry: ClockifyTimeEntrySnapshot
): Effect.Effect<string, PluginConfigurationFailure, Crypto.Crypto> => digestJson(revisionMaterial(entry))

/** Decode and scope one untrusted provider entry before normalization or mutation. @internal */
export const decodeClockifyTimeEntry = Effect.fn("ClockifyTimeEntryNormalization.decode")(function*(
  input: DecodeClockifyTimeEntryInput
): Effect.fn.Return<ClockifyTimeEntrySnapshot, PluginMalformedResponseFailure> {
  const entry = yield* Schema.decodeUnknownEffect(ClockifyTimeEntryResponse)(input.entry).pipe(
    Effect.mapError(() => malformed("clockify-time-entry-shape-invalid"))
  )
  if (entry.workspaceId !== input.expectedWorkspaceId) {
    return yield* malformed("clockify-time-entry-workspace-mismatch")
  }
  if (input.expectedUserId !== undefined && entry.userId !== input.expectedUserId) {
    return yield* malformed("clockify-time-entry-user-mismatch")
  }
  if (input.allowedUserIds !== undefined && !input.allowedUserIds.has(entry.userId)) {
    return yield* malformed("clockify-time-entry-user-mismatch")
  }
  if (
    entry.timeInterval.end !== null &&
    entry.timeInterval.end !== undefined &&
    DateTime.toEpochMillis(entry.timeInterval.end) < DateTime.toEpochMillis(entry.timeInterval.start)
  ) {
    return yield* malformed("clockify-time-entry-interval-backward")
  }
  return {
    billable: entry.billable,
    customFields: [...(entry.customFieldValues ?? [])].sort(
      (left, right) => left.customFieldId.localeCompare(right.customFieldId)
    ),
    customFieldsComplete: entry.customFieldValues !== undefined,
    description: entry.description,
    duration: entry.timeInterval.duration ?? null,
    end: entry.timeInterval.end ?? null,
    entryType: entry.type ?? "REGULAR",
    id: entry.id,
    ...(!(entry.isLocked === undefined) && { isLocked: entry.isLocked }),
    projectId: entry.projectId ?? null,
    start: entry.timeInterval.start,
    tagIds: [...(entry.tagIds ?? [])].sort(),
    taskId: entry.taskId ?? null,
    userId: entry.userId,
    workspaceId: entry.workspaceId
  }
})

/** Bind resumable checkpoints to every configuration value that shapes provider pagination. @internal */
export const digestClockifySyncScope = (scope: {
  readonly maximumPages: number
  readonly pageSize: number
  readonly userIds: ReadonlyArray<string>
  readonly workspaceId: string
}) => digestJson(scope)

/** Normalize one workspace user, using its own digest as the stable event identity. @internal */
export const normalizeClockifyPerson = Effect.fn("ClockifyTimeEntryNormalization.normalizePerson")(function*(input: {
  readonly user: unknown
  readonly workspaceId: string
}): Effect.fn.Return<
  ClockifyPersonEvent,
  PluginConfigurationFailure | PluginMalformedResponseFailure,
  Crypto.Crypto
> {
  const user = yield* Schema.decodeUnknownEffect(ClockifyPersonResponse)(input.user).pipe(
    Effect.mapError(() => malformed("clockify-person-shape-invalid"))
  )
  const workspaceMembership = user.memberships?.find(
    ({ membershipType, targetId }) => membershipType === "WORKSPACE" && targetId === input.workspaceId
  )
  const active = workspaceMembership?.membershipStatus === undefined
    ? user.status !== "DELETED" && user.status !== "LIMITED_DELETED"
    : workspaceMembership.membershipStatus === "ACTIVE"
  const revision = yield* digestJson({
    active,
    id: user.id,
    name: user.name
  })
  const event = yield* Schema.decodeUnknownEffect(Schema.toType(NormalizedPluginEventV1))({
    _tag: "UpsertPerson",
    eventId: `clockify:person:${user.id.slice(0, 300)}:${revision}`,
    observedAt: ClockifyPersonObservedAt,
    revision,
    vendorPersonId: user.id,
    displayName: user.name,
    avatarUrl: null,
    active
  }).pipe(Effect.mapError(() => malformed("clockify-normalized-person-invalid")))
  if (event._tag !== "UpsertPerson") return yield* malformed("clockify-normalized-event-kind-invalid")
  return event
})

/** Normalize one decoded Clockify snapshot into a stable vendor-neutral event. @internal */
export const normalizeClockifyTimeEntrySnapshot = Effect.fn(
  "ClockifyTimeEntryNormalization.normalizeSnapshot"
)(function*(
  entry: ClockifyTimeEntrySnapshot
): Effect.fn.Return<
  ClockifyTimeEntryEvent,
  PluginConfigurationFailure | PluginMalformedResponseFailure,
  Crypto.Crypto
> {
  const start = DateTime.formatIso(entry.start)
  const end = entry.end === null
    ? null
    : DateTime.formatIso(entry.end)
  const observedAt = entry.end ?? entry.start
  const revision = yield* revisionOfClockifyTimeEntry(entry)
  const title = entry.description.trim().length === 0
    ? `Clockify entry ${entry.id}`
    : entry.description.trim().slice(0, 500)

  const event = yield* Schema.decodeUnknownEffect(Schema.toType(NormalizedPluginEventV1))({
    _tag: "UpsertEntity",
    eventId: `clockify:time-entry:${entry.id}:${revision}`,
    observedAt,
    revision,
    entityType: "clockify.time-entry",
    vendorImmutableId: entry.id,
    sourceUrl: null,
    title,
    attributes: {
      schemaVersion: 1,
      provider: "clockify",
      workspaceId: entry.workspaceId,
      userId: entry.userId,
      description: entry.description,
      billable: entry.billable,
      ...(!(entry.isLocked === undefined) && { locked: entry.isLocked }),
      projectId: entry.projectId,
      taskId: entry.taskId,
      tagIds: entry.tagIds,
      entryType: entry.entryType,
      interval: {
        start,
        end,
        duration: entry.duration,
        state: end === null ? "running" : "completed"
      },
      freshness: {
        sourceObservedAt: DateTime.formatIso(observedAt),
        sourceTimestamp: end === null ? "interval-start" : "interval-end"
      }
    }
  }).pipe(Effect.mapError(() => malformed("clockify-normalized-time-entry-invalid")))
  if (event._tag !== "UpsertEntity") return yield* malformed("clockify-normalized-event-kind-invalid")
  return event
})

/** Normalize one untrusted provider entry into a stable vendor-neutral event. @internal */
export const normalizeClockifyTimeEntry = Effect.fn("ClockifyTimeEntryNormalization.normalize")(function*(
  input: DecodeClockifyTimeEntryInput
): Effect.fn.Return<
  ClockifyTimeEntryEvent,
  PluginConfigurationFailure | PluginMalformedResponseFailure,
  Crypto.Crypto
> {
  return yield* normalizeClockifyTimeEntrySnapshot(yield* decodeClockifyTimeEntry(input))
})
