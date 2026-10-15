import { Effect, Predicate, Schema } from "effect"
import type * as SqlClient from "effect/sql/SqlClient"
import { PRCommentLocationJson } from "../../Domain.js"
import { CacheError } from "../CacheError.js"
import { commentCoordinatePredicate } from "../repos/commentCoordinates.js"

const maxBytes = 1_048_576
const CommentRows = Schema.Array(Schema.Struct({
  locationsJson: Schema.NullOr(Schema.String),
  observedAt: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
})).check(Schema.isMaxLength(1))
const Locations = Schema.Array(PRCommentLocationJson)

/** Valid owner snapshots can exceed host presentation bounds; corruption is a different failure. */
export class HostCommentsReadError extends Schema.TaggedError<HostCommentsReadError>()("HostCommentsReadError", {
  reason: Schema.Literals(["over_limit", "corrupt"])
}) {}

/**
 * Server-private cached owner reading. Raw provider authors and commit locators need normalization
 * before HTTP; the timestamp records cache capture, not current provider freshness.
 */
export interface HostCachedComments {
  readonly observedAt: number
  readonly locations: ReadonlyArray<typeof PRCommentLocationJson.Type>
}

/** Reads existing rows only. The byte cap is applied in SQLite before returning the JSON column. */
export const readHostComments = Effect.fn("HostCache.comments")(function*(
  sql: SqlClient.SqlClient,
  target: Parameters<typeof commentCoordinatePredicate>[1]
) {
  const rows = yield* sql`SELECT
    CASE WHEN length(CAST(locations_json AS BLOB)) <= ${maxBytes} THEN locations_json ELSE NULL END AS locations_json,
    CAST(strftime('%s', fetched_at) AS REAL) * 1000 AS observed_at
    FROM pr_comments
    WHERE aws_account_id = ${target.accountId} AND pull_request_id = ${target.id}
      AND ${commentCoordinatePredicate(sql, target)}
    ORDER BY CASE WHEN repository_name = ${target.repository} AND account_region = ${target.region} THEN 0 ELSE 1 END
    LIMIT 1`.pipe(
    Effect.mapError((cause) => new CacheError({ operation: "HostCache.comments", cause })),
    Effect.flatMap((rows) =>
      Schema.decodeUnknownEffect(CommentRows, { onExcessProperty: "error" })(rows).pipe(
        Effect.mapError(() => new HostCommentsReadError({ reason: "corrupt" }))
      )
    )
  )
  const row = rows[0]
  if (row === undefined) return null
  if (row.locationsJson === null) {
    return yield* new HostCommentsReadError({ reason: "over_limit" })
  }
  const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(row.locationsJson).pipe(
    Effect.mapError(() => new HostCommentsReadError({ reason: "corrupt" }))
  )
  // Bound untrusted JSON before recursive domain decoding; no unparsed value crosses a helper boundary.
  const tree = [{ value: json, depth: 0 }]
  let nodes = 0
  let bounded = true
  while (tree.length > 0) {
    const next = tree.pop()
    if (next === undefined) break
    if (++nodes > 20_000 || next.depth > 256) {
      bounded = false
      break
    }
    const children: ReadonlyArray<unknown> = Array.isArray(next.value)
      ? next.value
      : Predicate.isObject(next.value)
      ? Object.values(next.value)
      : []
    for (const value of children) tree.push({ value, depth: next.depth + 1 })
  }
  if (!bounded || (Array.isArray(json) && json.length > 500)) {
    return yield* new HostCommentsReadError({ reason: "over_limit" })
  }
  const locations = yield* Schema.decodeUnknownEffect(Locations, { onExcessProperty: "error" })(json).pipe(
    Effect.mapError(() => new HostCommentsReadError({ reason: "corrupt" }))
  )
  const pending = locations.flatMap((location) => location.comments.map((thread) => ({ thread, depth: 0 })))
  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined) break
    if (next.depth > 64) return yield* new HostCommentsReadError({ reason: "over_limit" })
    for (const thread of next.thread.replies) pending.push({ thread, depth: next.depth + 1 })
  }
  return { observedAt: row.observedAt, locations } satisfies HostCachedComments
})
