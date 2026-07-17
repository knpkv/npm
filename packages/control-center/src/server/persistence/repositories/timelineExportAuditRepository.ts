import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import { PersonId, SessionId, WorkspaceId } from "../../../domain/identifiers.js"
import { TimelineActorKind } from "../../../domain/timeline.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import { mapPersistenceOperation } from "./internal.js"

/** Raised when Timeline export audit persistence input is invalid. */
export class TimelineExportAuditInputError extends Schema.TaggedErrorClass<TimelineExportAuditInputError>()(
  "TimelineExportAuditInputError",
  {}
) {}

/** One immutable attribution record for a successfully collected Timeline export. */
export const RecordTimelineExportAuditInput = Schema.Struct({
  workspaceId: WorkspaceId,
  personId: PersonId,
  sessionId: SessionId,
  format: Schema.Literals(["csv", "json"]),
  actorKind: Schema.NullOr(TimelineActorKind),
  from: Schema.NullOr(UtcTimestamp),
  to: Schema.NullOr(UtcTimestamp),
  requestedLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
  returnedCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 })),
  truncated: Schema.Boolean
}).check(
  Schema.makeFilter(
    ({ requestedLimit, returnedCount }) => returnedCount <= requestedLimit,
    { expected: "returned Timeline export count not to exceed its requested limit" }
  )
)

/** Decoded Timeline export audit append command. */
export type RecordTimelineExportAuditInput = typeof RecordTimelineExportAuditInput.Type

const makeTimelineExportAuditRepository = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const { sql } = yield* Database

  return {
    record: Effect.fn("TimelineExportAuditRepository.record")(function*(input: unknown) {
      const audit = yield* Schema.decodeUnknownEffect(Schema.toType(RecordTimelineExportAuditInput))(input).pipe(
        Effect.mapError(() => new TimelineExportAuditInputError())
      )
      const exportAuditId = yield* cryptoService.randomUUIDv7
      const recordedAt = yield* DateTime.now
      yield* sql`INSERT INTO timeline_export_audits (
        workspace_id, export_audit_id, schema_version, person_id, session_id,
        format, actor_filter, from_filter, to_filter, requested_limit,
        returned_count, is_truncated, recorded_at
      ) VALUES (
        ${audit.workspaceId}, ${exportAuditId}, 1, ${audit.personId}, ${audit.sessionId},
        ${audit.format}, ${audit.actorKind},
        ${audit.from === null ? null : Schema.encodeSync(UtcTimestamp)(audit.from)},
        ${audit.to === null ? null : Schema.encodeSync(UtcTimestamp)(audit.to)},
        ${audit.requestedLimit}, ${audit.returnedCount}, ${audit.truncated ? 1 : 0},
        ${Schema.encodeSync(UtcTimestamp)(recordedAt)}
      )`
    }, mapPersistenceOperation("timeline-export-audit.record"))
  }
})

/** Durable append-only Timeline export audit repository service. */
export interface TimelineExportAuditRepositoryService extends Success<typeof makeTimelineExportAuditRepository> {}

/** Private Timeline export attribution repository. */
export class TimelineExportAuditRepository extends Context.Service<
  TimelineExportAuditRepository,
  TimelineExportAuditRepositoryService
>()("@knpkv/control-center/server/persistence/TimelineExportAuditRepository") {
  static readonly layer = Layer.effect(TimelineExportAuditRepository, makeTimelineExportAuditRepository)
}
