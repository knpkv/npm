/** Local inventory diagnostics carry only an operation, validated stable identity and failure category. */
import { Result, Schema } from "effect"
import type { ConnectRelationshipError, ConnectRelationshipStoreError, ConnectStoreBusyError } from "../errors.js"
import { ConnectAgent } from "../model.js"

export class ConnectInventoryFailure extends Schema.TaggedError<ConnectInventoryFailure>()("ConnectInventoryFailure", {
  step: Schema.Literals(["persist_relationships", "lookup_relationship", "decode_inventory", "validate_forest"]),
  agentId: Schema.NullOr(ConnectAgent.fields.id),
  reason: Schema.Literals([
    "malformed",
    "stale",
    "cyclic",
    "missing_parent",
    "cross_host",
    "ambiguous_ownership",
    "ConnectRelationshipStoreError",
    "ConnectStoreBusyError",
    "SchemaError",
    "MissingPersistedRelationship"
  ])
}) {}

/** Relationship errors name the failing identity first; validate it before retaining it in a diagnostic. */
export const inventoryRelationshipFailure = (
  step: "persist_relationships" | "validate_forest",
  cause: ConnectRelationshipError | ConnectRelationshipStoreError | ConnectStoreBusyError
): ConnectInventoryFailure => {
  if (cause._tag === "ConnectRelationshipStoreError" || cause._tag === "ConnectStoreBusyError") {
    return new ConnectInventoryFailure({ step, agentId: null, reason: cause._tag })
  }
  const identity = Schema.decodeUnknownResult(ConnectAgent.fields.id)(cause.detail.split(" ")[1])
  return new ConnectInventoryFailure({
    step,
    agentId: Result.isSuccess(identity) ? identity.success : null,
    reason: cause.reason
  })
}
