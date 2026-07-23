/** Schema-backed Clockify time-entry normalization. @internal */
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Schema from "effect/Schema"

import { NormalizedPluginEventV1 } from "../../../domain/plugins/index.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { PluginConfigurationFailure, PluginMalformedResponseFailure } from "../failures.js"

const ClockifyIdentifier = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const ClockifyText = Schema.String.check(Schema.isMaxLength(4_000))
const ClockifyDuration = Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(100))
// Clockify's workspace-user response has no profile revision timestamp. Keep the
// observation deterministic so an unchanged person has one immutable payload.
const ClockifyPersonObservedAt = DateTime.makeUnsafe(0)
const ClockifyPersonResponse = Schema.Struct({
  id: ClockifyIdentifier,
  name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  status: Schema.optionalKey(
    Schema.Literals(["ACTIVE", "PENDING_EMAIL_VERIFICATION", "DELETED", "NOT_REGISTERED", "LIMITED", "LIMITED_DELETED"])
  )
})

const ClockifyTimeEntryResponse = Schema.Struct({
  billable: Schema.Boolean,
  description: ClockifyText,
  id: ClockifyIdentifier,
  isLocked: Schema.optionalKey(Schema.Boolean),
  projectId: Schema.optionalKey(ClockifyIdentifier),
  tagIds: Schema.optionalKey(
    Schema.Array(ClockifyIdentifier).check(
      Schema.makeFilter((values) => values.length <= 100, { expected: "at most 100 Clockify tags" }),
      Schema.isUnique()
    )
  ),
  taskId: Schema.optionalKey(ClockifyIdentifier),
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

interface NormalizeClockifyTimeEntryInput {
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
  const cryptoService = yield* Crypto.Crypto
  const json = JSON.stringify(value)
  const bytes = yield* Effect.fromResult(Encoding.decodeBase64(Encoding.encodeBase64(json))).pipe(
    Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "clockify-revision-encoding-failed" }))
  )
  const digest = yield* cryptoService
    .digest("SHA-256", bytes)
    .pipe(Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "clockify-revision-digest-failed" })))
  return Encoding.encodeHex(digest)
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
}): Effect.fn.Return<
  ClockifyPersonEvent,
  PluginConfigurationFailure | PluginMalformedResponseFailure,
  Crypto.Crypto
> {
  const user = yield* Schema.decodeUnknownEffect(ClockifyPersonResponse)(input.user).pipe(
    Effect.mapError(() => malformed("clockify-person-shape-invalid"))
  )
  const active = user.status !== "DELETED" && user.status !== "LIMITED_DELETED"
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

/** Normalize one untrusted provider entry into a stable vendor-neutral event. @internal */
export const normalizeClockifyTimeEntry = Effect.fn("ClockifyTimeEntryNormalization.normalize")(function*(
  input: NormalizeClockifyTimeEntryInput
): Effect.fn.Return<
  ClockifyTimeEntryEvent,
  PluginConfigurationFailure | PluginMalformedResponseFailure,
  Crypto.Crypto
> {
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

  const start = DateTime.formatIso(entry.timeInterval.start)
  const end = entry.timeInterval.end === null || entry.timeInterval.end === undefined
    ? null
    : DateTime.formatIso(entry.timeInterval.end)
  if (
    entry.timeInterval.end !== null &&
    entry.timeInterval.end !== undefined &&
    DateTime.toEpochMillis(entry.timeInterval.end) < DateTime.toEpochMillis(entry.timeInterval.start)
  ) {
    return yield* malformed("clockify-time-entry-interval-backward")
  }
  const observedAt = entry.timeInterval.end ?? entry.timeInterval.start
  const tagIds = [...(entry.tagIds ?? [])].sort()
  const revision = yield* digestJson({
    billable: entry.billable,
    description: entry.description,
    id: entry.id,
    isLocked: entry.isLocked ?? false,
    projectId: entry.projectId ?? null,
    tagIds,
    taskId: entry.taskId ?? null,
    timeInterval: {
      duration: entry.timeInterval.duration ?? null,
      end,
      start
    },
    type: entry.type ?? "REGULAR",
    userId: entry.userId,
    workspaceId: entry.workspaceId
  })
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
      projectId: entry.projectId ?? null,
      taskId: entry.taskId ?? null,
      tagIds,
      locked: entry.isLocked ?? false,
      entryType: entry.type ?? "REGULAR",
      interval: {
        start,
        end,
        duration: entry.timeInterval.duration ?? null,
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
