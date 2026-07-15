import * as Schema from "effect/Schema"

import {
  PluginAcceptedProviderReceiptV1,
  PluginActionReconciliationKey,
  PluginProviderOperationId,
  PluginTerminalProviderReceiptV1
} from "../plugins/actions.js"
import {
  GovernedActionState,
  type GovernedActionState as GovernedActionStateType,
  type GovernedActionTransitionCommand,
  reduceGovernedActionState
} from "./stateMachine.js"

/** Provider identity retained by the durable action head across async and ambiguous work. */
export const GovernedActionProviderLineage = Schema.TaggedUnion({
  none: {},
  accepted: { receipt: PluginAcceptedProviderReceiptV1 },
  reconcilable: {
    providerOperationId: Schema.NullOr(PluginProviderOperationId),
    reconciliationKey: PluginActionReconciliationKey
  },
  manual: {
    providerOperationId: Schema.NullOr(PluginProviderOperationId)
  },
  terminal: { receipt: PluginTerminalProviderReceiptV1 }
})

/** Decoded provider lineage retained by a governed-action lifecycle head. */
export type GovernedActionProviderLineage = typeof GovernedActionProviderLineage.Type

const stateMatchesLineage = (
  state: GovernedActionStateType,
  lineage: GovernedActionProviderLineage
): boolean => {
  switch (state) {
    case "proposed":
    case "authorized":
    case "denied":
    case "expired":
      return lineage._tag === "none"
    case "cancelled":
      return lineage._tag === "none" || (lineage._tag === "terminal" && lineage.receipt.status === "cancelled")
    case "started":
    case "cancel-requested":
      return lineage._tag === "none" || lineage._tag === "accepted"
    case "unknown":
    case "cancel-requested-unknown":
      return lineage._tag === "reconcilable" || lineage._tag === "manual"
    case "succeeded":
      return lineage._tag === "terminal" && lineage.receipt.status === "succeeded"
    case "failed":
      return lineage._tag === "terminal" && lineage.receipt.status === "failed"
  }
}

/** Durable lifecycle state plus the exact provider identity needed for safe recovery. */
export const GovernedActionLifecycleHeadV1 = Schema.Struct({
  state: GovernedActionState,
  lineage: GovernedActionProviderLineage
}).check(
  Schema.makeFilter(
    ({ lineage, state }) => stateMatchesLineage(state, lineage),
    { expected: "governed-action state and provider lineage to agree" }
  )
)

/** Decoded governed-action lifecycle head. */
export type GovernedActionLifecycleHeadV1 = typeof GovernedActionLifecycleHeadV1.Type

const providerOperationIdFromLineage = (
  lineage: GovernedActionProviderLineage
): PluginProviderOperationId | null => {
  switch (lineage._tag) {
    case "accepted":
      return lineage.receipt.providerOperationId
    case "reconcilable":
    case "manual":
      return lineage.providerOperationId
    case "none":
    case "terminal":
      return null
  }
}

const reconciliationKeyFromLineage = (
  lineage: GovernedActionProviderLineage
): PluginActionReconciliationKey | null => {
  switch (lineage._tag) {
    case "accepted":
      return lineage.receipt.reconciliationKey
    case "reconcilable":
      return lineage.reconciliationKey
    case "none":
    case "manual":
    case "terminal":
      return null
  }
}

const unknownLineage = (
  current: GovernedActionProviderLineage,
  command: Extract<GovernedActionTransitionCommand, { readonly _tag: "recordUnknown" }>
): GovernedActionProviderLineage => {
  const providerOperationId = providerOperationIdFromLineage(current)
  if (command.outcome._tag === "reconcilable") {
    return {
      _tag: "reconcilable",
      providerOperationId,
      reconciliationKey: command.outcome.reconciliationKey
    }
  }
  const retainedReconciliationKey = reconciliationKeyFromLineage(current)
  return retainedReconciliationKey === null
    ? { _tag: "manual", providerOperationId }
    : { _tag: "reconcilable", providerOperationId, reconciliationKey: retainedReconciliationKey }
}

const acceptedReceiptMatches = (
  lineage: GovernedActionProviderLineage,
  command: Extract<GovernedActionTransitionCommand, { readonly _tag: "recordAccepted" }>
): boolean =>
  lineage._tag === "none" ||
  (lineage._tag === "accepted" &&
    lineage.receipt.providerOperationId === command.receipt.providerOperationId &&
    lineage.receipt.reconciliationKey === command.receipt.reconciliationKey)

const terminalSourceMatches = (
  lineage: GovernedActionProviderLineage,
  command: Extract<
    GovernedActionTransitionCommand,
    { readonly _tag: "recordSucceeded" | "recordFailed" | "recordCancelled" }
  >
): boolean => {
  const providerOperationId = providerOperationIdFromLineage(lineage)
  const reconciliationKey = reconciliationKeyFromLineage(lineage)
  switch (command.source._tag) {
    case "direct":
      return lineage._tag === "none"
    case "providerOperation":
      return providerOperationId !== null &&
        command.source.providerOperationId === providerOperationId &&
        command.receipt.providerOperationId === providerOperationId
    case "reconciliation":
      return reconciliationKey !== null &&
        command.source.reconciliationKey === reconciliationKey &&
        (providerOperationId === null || command.receipt.providerOperationId === providerOperationId)
  }
}

const reconciliationPendingMatches = (
  lineage: GovernedActionProviderLineage,
  command: Extract<GovernedActionTransitionCommand, { readonly _tag: "reconciliationPending" }>
): boolean => reconciliationKeyFromLineage(lineage) === command.reconciliationKey

/**
 * Advance a durable lifecycle head while retaining and matching opaque provider identity.
 * A null result rejects illegal edges, fabricated locators, and unrelated receipts.
 */
export const advanceGovernedActionLifecycle = (
  current: GovernedActionLifecycleHeadV1 | null,
  command: GovernedActionTransitionCommand
): GovernedActionLifecycleHeadV1 | null => {
  const nextState = reduceGovernedActionState(current?.state ?? null, command)
  if (nextState === null) return null
  const currentLineage: GovernedActionProviderLineage = current?.lineage ?? { _tag: "none" }

  switch (command._tag) {
    case "recordAccepted":
      return acceptedReceiptMatches(currentLineage, command)
        ? { state: nextState, lineage: { _tag: "accepted", receipt: command.receipt } }
        : null
    case "recordUnknown":
      return { state: nextState, lineage: unknownLineage(currentLineage, command) }
    case "recordSucceeded":
    case "recordFailed":
    case "recordCancelled":
      return terminalSourceMatches(currentLineage, command)
        ? { state: nextState, lineage: { _tag: "terminal", receipt: command.receipt } }
        : null
    case "reconciliationPending":
      return reconciliationPendingMatches(currentLineage, command)
        ? { state: nextState, lineage: currentLineage }
        : null
    case "propose":
    case "authorize":
    case "deny":
    case "expire":
    case "cancel":
    case "start":
    case "requestCancellation":
      return { state: nextState, lineage: currentLineage }
  }
}
