import { Equal, Predicate, Schema } from "effect"
import { WorkLaneClaimed } from "../model.js"

/**
 * How a pre-session lane claim migrates. A legacy claim has no operation id,
 * so it takes the lane id, unless a running binding recorded the lane at the
 * claim's own revision: the claim then becomes that lane, because every later
 * open checks a current binding's lane against the claim exactly. The binding
 * writer set the claim to exactly its lane, so a well-formed pair differs only
 * in the ids the legacy record lacked; any other difference, or a second bound lane (lane CAS
 * allows one binding per revision), means an inconsistent file.
 */
export type LegacyLaneClaim =
  | { readonly _tag: "claim"; readonly lane: WorkLaneClaimed }
  | { readonly _tag: "ambiguous"; readonly bound: ReadonlyArray<WorkLaneClaimed>; readonly lane: WorkLaneClaimed }
  | { readonly _tag: "mismatch"; readonly bound: WorkLaneClaimed; readonly lane: WorkLaneClaimed }

/**
 * Resolves `legacy` (already given `operationId = laneId`) against the lanes
 * of the running bindings its handoffs reference.
 */
export const resolveLegacyLaneClaim = (
  legacy: WorkLaneClaimed,
  bindingLanes: ReadonlyArray<WorkLaneClaimed>
): LegacyLaneClaim => {
  const bound = bindingLanes
    .filter(({ laneId, revision }) => laneId === legacy.laneId && revision === legacy.revision)
    .reduce<ReadonlyArray<WorkLaneClaimed>>(
      (distinct, lane) => distinct.some((seen) => Equal.equals(seen, lane)) ? distinct : [...distinct, lane],
      []
    )
  const [only, ...rest] = bound
  if (only === undefined) return { _tag: "claim", lane: legacy }
  if (rest.length > 0) return { _tag: "ambiguous", bound, lane: legacy }
  // The legacy record had neither id, so only the fields it did record must agree.
  // Decode, not spread, so Equal compares two WorkLaneClaimed values.
  const expected = Schema.decodeUnknownSync(WorkLaneClaimed)({
    ...legacy,
    goalId: only.goalId,
    operationId: only.operationId
  })
  return Equal.equals(only, expected) ? { _tag: "claim", lane: only } : { _tag: "mismatch", bound: only, lane: legacy }
}

/** One `work_lane_operations` row, as both drivers read it. */
// SQLite keeps whatever type a row was written with, so every column may be
// text or a number; a row of the wrong shape is a collision, not a decode error.
const LedgerValue = Schema.Union([Schema.String, Schema.Number])
export const LaneOperationLedgerRow = Schema.Struct({
  operationId: Schema.String,
  laneId: LedgerValue,
  goalId: LedgerValue,
  phase: LedgerValue,
  revision: LedgerValue,
  record: LedgerValue
})
export type LaneOperationRow = typeof LaneOperationLedgerRow.Type

/** The ledger's row count and encoded bytes, counted the way its totals trigger counts them. */
export const LaneOperationTotalsRow = Schema.Struct({ count: Schema.Number, bytes: Schema.Number })

/**
 * How the migrated claims enter the operation ledger: insert the absent ones,
 * or fail because a row already holds one of their operation ids with a
 * different claim (an exact replay would then conflict), or because the new
 * rows would take the ledger past its bounds.
 */
export type LegacyLaneOperations =
  | { readonly _tag: "record"; readonly inserts: ReadonlyArray<WorkLaneClaimed> }
  | { readonly _tag: "collision"; readonly lane: WorkLaneClaimed; readonly existing: LaneOperationRow }
  | { readonly _tag: "capacity"; readonly count: number; readonly bytes: number }

const sameOperation = (lane: WorkLaneClaimed, row: LaneOperationRow): boolean => {
  if (
    row.laneId !== lane.laneId || row.goalId !== lane.goalId || row.phase !== lane.phase ||
    row.revision !== lane.revision
  ) return false
  if (!Predicate.isString(row.record)) return false
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(WorkLaneClaimed))(row.record)
  return decoded._tag === "Some" && Equal.equals(decoded.value, lane)
}

const utf8 = new TextEncoder()

/**
 * Plans the ledger rows for `claims` against the rows already holding their
 * operation ids and the ledger's current totals.
 */
export const planLegacyLaneOperations = (
  claims: ReadonlyArray<WorkLaneClaimed>,
  existing: ReadonlyMap<string, LaneOperationRow>,
  totals: { readonly count: number; readonly bytes: number },
  limits: { readonly records: number; readonly bytes: number }
): LegacyLaneOperations => {
  const inserts: Array<WorkLaneClaimed> = []
  for (const lane of claims) {
    const row = existing.get(lane.operationId)
    if (row === undefined) inserts.push(lane)
    else if (!sameOperation(lane, row)) return { _tag: "collision", existing: row, lane }
  }
  const count = totals.count + inserts.length
  const bytes = inserts.reduce(
    (sum, lane) => sum + utf8.encode(lane.operationId).byteLength + utf8.encode(JSON.stringify(lane)).byteLength,
    totals.bytes
  )
  return count > limits.records || bytes > limits.bytes
    ? { _tag: "capacity", bytes, count }
    : { _tag: "record", inserts }
}
