import type { PluginActionReconciliationRequestV1 } from "../../../../domain/plugins/actions.js"
import type { GovernedActionRecord } from "../../../persistence/repositories/governed-action/contract.js"

/** Resolve the provider key retained by lineage, or null for immutable idempotency recovery. */
export const governedActionReconciliationKey = (
  record: GovernedActionRecord
): PluginActionReconciliationRequestV1["reconciliationKey"] => {
  switch (record.head.lineage._tag) {
    case "accepted":
      return record.head.lineage.receipt.reconciliationKey
    case "reconcilable":
      return record.head.lineage.reconciliationKey
    case "none":
    case "manual":
    case "terminal":
      return null
  }
}
