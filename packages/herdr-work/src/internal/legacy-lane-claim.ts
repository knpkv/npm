import { Equal, Schema } from "effect"
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
