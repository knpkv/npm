import * as Schema from "effect/Schema"

import { PluginActionReconciliationKey } from "../../domain/plugins/actions.js"

/**
 * SQL-only encoding for reconciliation by the action's immutable idempotency identity.
 * Leading whitespace makes this value impossible to decode as a provider reconciliation key.
 */
export const PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR = " @knpkv/idempotency-reconciliation/v1"

/** Provider locator or the private idempotency encoding stored in command projection columns. */
export const PersistedGovernedActionReconciliationLocator = Schema.Union([
  PluginActionReconciliationKey,
  Schema.Literal(PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR)
])

/** Decoded SQL-only reconciliation locator. */
export type PersistedGovernedActionReconciliationLocator = typeof PersistedGovernedActionReconciliationLocator.Type

/** Encode the domain's explicit null convention without weakening legacy SQL checks. */
export const encodePersistedGovernedActionReconciliationLocator = (
  reconciliationKey: typeof PluginActionReconciliationKey.Type | null
): PersistedGovernedActionReconciliationLocator => reconciliationKey ?? PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR
