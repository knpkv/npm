import { renderTimelineDetailQueries, renderTimelineQueries } from "@knpkv/control-center-sql"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import type { WorkspaceId } from "../../../domain/identifiers.js"
import type {
  TimelineActorKind,
  TimelineCursor,
  TimelineService,
  TimelineSourceKind
} from "../../../domain/timeline.js"
import type { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { Database } from "../Database.js"
import { mapPersistenceOperation } from "./internal.js"

const TimelineRow = Schema.Struct({
  eventKey: Schema.String,
  occurredAt: Schema.String,
  actorKind: Schema.String,
  actorId: Schema.NullOr(Schema.String),
  actorLabel: Schema.NullOr(Schema.String),
  eventType: Schema.String,
  sourceKind: Schema.String,
  service: Schema.NullOr(Schema.String),
  releaseId: Schema.NullOr(Schema.String),
  entityId: Schema.NullOr(Schema.String),
  actionId: Schema.NullOr(Schema.String),
  relationshipId: Schema.NullOr(Schema.String),
  pluginConnectionId: Schema.NullOr(Schema.String),
  agentJobId: Schema.NullOr(Schema.String)
})

/** Trusted durable Timeline row after SQL result decoding. */
export interface TimelineRecord {
  readonly eventKey: string
  readonly occurredAt: UtcTimestamp
  readonly actorKind: TimelineActorKind
  readonly actorId: string | null
  readonly actorLabel: string | null
  readonly eventType: string
  readonly sourceKind: TimelineSourceKind
  readonly service: TimelineService | null
  readonly releaseId: string | null
  readonly entityId: string | null
  readonly actionId: string | null
  readonly relationshipId: string | null
  readonly pluginConnectionId: string | null
  readonly agentJobId: string | null
}

/** Workspace-safe inputs for one bounded newest-first Timeline page. */
export interface ReadTimelinePageInput {
  readonly actorKind: TimelineActorKind | null
  readonly before: TimelineCursor | null
  readonly from: UtcTimestamp | null
  readonly limit: number
  readonly to: UtcTimestamp | null
  readonly workspaceId: WorkspaceId
}

const compareRecords = (left: TimelineRecord, right: TimelineRecord): number => {
  const leftTime = DateTime.toEpochMillis(left.occurredAt)
  const rightTime = DateTime.toEpochMillis(right.occurredAt)
  if (leftTime !== rightTime) return rightTime - leftTime
  return left.eventKey < right.eventKey ? 1 : left.eventKey > right.eventKey ? -1 : 0
}

const makeTimelineRepository = Effect.gen(function*() {
  const { sql } = yield* Database

  const execute = Effect.fn("TimelineRepository.execute")(function*(
    plans: ReturnType<typeof renderTimelineQueries>
  ) {
    const sourceRows = yield* Effect.forEach(plans, (plan) =>
      sql.unsafe(plan.sql, [...plan.params]).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TimelineRow)))
      ), { concurrency: 4 })
    return yield* Effect.forEach(sourceRows.flat(), (row) =>
      Effect.gen(function*() {
        const occurredAt = yield* Schema.decodeUnknownEffect(
          Schema.DateTimeUtcFromString
        )(row.occurredAt)
        const actorKind = yield* Schema.decodeUnknownEffect(
          Schema.Literals(["agent", "human", "plugin", "system"])
        )(row.actorKind)
        const sourceKind = yield* Schema.decodeUnknownEffect(
          Schema.Literals(["action", "plugin-sync", "relationship", "system"])
        )(row.sourceKind)
        const service = yield* Schema.decodeUnknownEffect(
          Schema.NullOr(Schema.Literals(["codecommit", "codepipeline", "jira", "confluence", "clockify"]))
        )(row.service)
        return { ...row, actorKind, occurredAt, service, sourceKind } satisfies TimelineRecord
      }))
  })

  return {
    page: Effect.fn("TimelineRepository.page")(function*(input: ReadTimelinePageInput) {
      const sourceLimit = Math.min(Math.max(input.limit, 1), 100) + 1
      const plans = renderTimelineQueries({
        actorKind: input.actorKind,
        before: input.before === null
          ? null
          : { eventKey: input.before.eventKey, occurredAt: DateTime.formatIso(input.before.occurredAt) },
        from: input.from === null ? null : DateTime.formatIso(input.from),
        limit: sourceLimit,
        to: input.to === null ? null : DateTime.formatIso(input.to),
        workspaceId: input.workspaceId
      })
      const records = yield* execute(plans)
      return records.sort(compareRecords).slice(0, sourceLimit)
    }, mapPersistenceOperation("timeline.page")),
    detail: Effect.fn("TimelineRepository.detail")(function*(input: {
      readonly workspaceId: WorkspaceId
      readonly eventKey: string
    }) {
      const records = yield* execute(renderTimelineDetailQueries(input))
      if (records.length > 1) return yield* Effect.die("Timeline event key resolved more than once")
      return records[0] ?? null
    }, mapPersistenceOperation("timeline.detail"))
  }
})

/** Deep persistence interface for the merged durable activity Timeline. */
export interface TimelineRepositoryService extends Success<typeof makeTimelineRepository> {}

/** Effect service exposing bounded Timeline reads. */
export class TimelineRepository extends Context.Service<TimelineRepository, TimelineRepositoryService>()(
  "@knpkv/control-center/TimelineRepository"
) {
  /** Layer binding Timeline reads to the shared database. */
  static readonly layer = Layer.effect(TimelineRepository, makeTimelineRepository)
}
