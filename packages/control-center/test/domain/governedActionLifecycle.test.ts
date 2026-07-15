import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"

import {
  advanceGovernedActionLifecycle,
  GovernedActionLifecycleHeadV1,
  GovernedActionTransitionCommand
} from "../../src/domain/governedAction/index.js"

const observedAt = "2026-07-15T10:00:00.000Z"
const operationA = "provider-operation-A"
const operationB = "provider-operation-B"
const reconciliationKeyA = "opaque+key-A=="
const reconciliationKeyB = "opaque+key-B=="
const decodeCommand = Schema.decodeUnknownSync(GovernedActionTransitionCommand)
const started = Schema.decodeUnknownSync(GovernedActionLifecycleHeadV1)({
  state: "started",
  lineage: { _tag: "none" }
})

const receipt = (providerOperationId: string, status: "succeeded" | "failed" | "cancelled") => ({
  providerOperationId,
  status,
  safeSummary: `Provider ${status}`,
  observedAt
})

describe("governed action provider lineage", () => {
  it("retains accepted identity through cancellation and resolves only with the matching locator", () => {
    const accepted = advanceGovernedActionLifecycle(
      started,
      decodeCommand({
        _tag: "recordAccepted",
        receipt: {
          providerOperationId: operationA,
          status: "accepted",
          safeSummary: "Provider accepted asynchronous work",
          observedAt,
          reconciliationKey: reconciliationKeyA
        }
      })
    )
    assert.isNotNull(accepted)
    if (accepted === null) return

    assert.isNull(advanceGovernedActionLifecycle(
      accepted,
      decodeCommand({
        _tag: "recordSucceeded",
        receipt: receipt(operationB, "succeeded"),
        source: { _tag: "direct" }
      })
    ))
    assert.isNull(advanceGovernedActionLifecycle(
      accepted,
      decodeCommand({
        _tag: "recordSucceeded",
        receipt: receipt(operationA, "succeeded"),
        source: { _tag: "reconciliation", reconciliationKey: reconciliationKeyB }
      })
    ))
    assert.isNull(advanceGovernedActionLifecycle(
      accepted,
      decodeCommand({
        _tag: "recordSucceeded",
        receipt: receipt(operationB, "succeeded"),
        source: { _tag: "reconciliation", reconciliationKey: reconciliationKeyA }
      })
    ))

    const cancellationRequested = advanceGovernedActionLifecycle(
      accepted,
      decodeCommand({
        _tag: "requestCancellation",
        safeSummary: "Stop provider work"
      })
    )
    assert.isNotNull(cancellationRequested)
    if (cancellationRequested === null) return

    const ambiguousCancellation = advanceGovernedActionLifecycle(
      cancellationRequested,
      decodeCommand({
        _tag: "recordUnknown",
        outcome: {
          _tag: "reconcilable",
          reconciliationKey: reconciliationKeyA,
          observedAt,
          safeSummary: "Cancellation outcome is unknown"
        }
      })
    )
    assert.isNotNull(ambiguousCancellation)
    if (ambiguousCancellation === null) return

    const cancelled = advanceGovernedActionLifecycle(
      ambiguousCancellation,
      decodeCommand({
        _tag: "recordCancelled",
        receipt: receipt(operationA, "cancelled"),
        source: { _tag: "reconciliation", reconciliationKey: reconciliationKeyA }
      })
    )
    assert.strictEqual(cancelled?.state, "cancelled")
    assert.strictEqual(cancelled?.lineage._tag, "terminal")
    if (cancelled?.lineage._tag !== "terminal") return
    assert.strictEqual(cancelled.lineage.receipt.providerOperationId, operationA)
    assert.strictEqual(cancelled.lineage.receipt.status, "cancelled")
  })

  it("never invents reconciliation authority for a manual unknown outcome", () => {
    const manualUnknown = advanceGovernedActionLifecycle(
      started,
      decodeCommand({
        _tag: "recordUnknown",
        outcome: {
          _tag: "manual",
          observedAt,
          safeSummary: "No provider locator was returned",
          reason: "missing-reconciliation-locator"
        }
      })
    )
    assert.isNotNull(manualUnknown)
    if (manualUnknown === null) return

    assert.isNull(advanceGovernedActionLifecycle(
      manualUnknown,
      decodeCommand({
        _tag: "reconciliationPending",
        checkedAt: observedAt,
        reconciliationKey: reconciliationKeyA
      })
    ))
    assert.isNull(advanceGovernedActionLifecycle(
      manualUnknown,
      decodeCommand({
        _tag: "recordSucceeded",
        receipt: receipt(operationA, "succeeded"),
        source: { _tag: "reconciliation", reconciliationKey: reconciliationKeyA }
      })
    ))
  })

  it("allows one direct terminal receipt before any accepted or unknown identity exists", () => {
    const succeeded = advanceGovernedActionLifecycle(
      started,
      decodeCommand({
        _tag: "recordSucceeded",
        receipt: receipt(operationA, "succeeded"),
        source: { _tag: "direct" }
      })
    )

    assert.isNotNull(succeeded)
    assert.strictEqual(succeeded?.state, "succeeded")
    assert.strictEqual(succeeded?.lineage._tag, "terminal")
  })

  it("recovers by immutable idempotency identity only when no provider locator exists", () => {
    const pendingByIdempotency = decodeCommand({
      _tag: "reconciliationPending",
      checkedAt: observedAt,
      reconciliationKey: null
    })
    const succeededByIdempotency = decodeCommand({
      _tag: "recordSucceeded",
      receipt: receipt(operationA, "succeeded"),
      source: { _tag: "reconciliation", reconciliationKey: null }
    })
    const pending = advanceGovernedActionLifecycle(started, pendingByIdempotency)

    assert.deepStrictEqual(pending, started)
    assert.strictEqual(
      advanceGovernedActionLifecycle(started, succeededByIdempotency)?.state,
      "succeeded"
    )

    const manual = advanceGovernedActionLifecycle(
      started,
      decodeCommand({
        _tag: "recordUnknown",
        outcome: {
          _tag: "manual",
          observedAt,
          safeSummary: "No provider locator was returned",
          reason: "missing-reconciliation-locator"
        }
      })
    )
    assert.isNotNull(manual)
    if (manual === null) return

    assert.deepStrictEqual(advanceGovernedActionLifecycle(manual, pendingByIdempotency), manual)
    assert.strictEqual(
      advanceGovernedActionLifecycle(manual, succeededByIdempotency)?.state,
      "succeeded"
    )

    const accepted = advanceGovernedActionLifecycle(
      started,
      decodeCommand({
        _tag: "recordAccepted",
        receipt: {
          providerOperationId: operationA,
          status: "accepted",
          safeSummary: "Provider accepted asynchronous work",
          observedAt,
          reconciliationKey: reconciliationKeyA
        }
      })
    )
    assert.isNotNull(accepted)
    if (accepted === null) return

    assert.isNull(advanceGovernedActionLifecycle(accepted, pendingByIdempotency))
    assert.isNull(advanceGovernedActionLifecycle(accepted, succeededByIdempotency))
  })

  it("keeps cancellation intent and retained provider identity during idempotency recovery", () => {
    const pendingByIdempotency = decodeCommand({
      _tag: "reconciliationPending",
      checkedAt: observedAt,
      reconciliationKey: null
    })
    const cancelledByIdempotency = decodeCommand({
      _tag: "recordCancelled",
      receipt: receipt(operationA, "cancelled"),
      source: { _tag: "reconciliation", reconciliationKey: null }
    })
    const cancellationRequested = advanceGovernedActionLifecycle(
      started,
      decodeCommand({ _tag: "requestCancellation", safeSummary: "Stop provider work" })
    )
    assert.isNotNull(cancellationRequested)
    if (cancellationRequested === null) return

    assert.deepStrictEqual(
      advanceGovernedActionLifecycle(cancellationRequested, pendingByIdempotency),
      cancellationRequested
    )
    assert.strictEqual(
      advanceGovernedActionLifecycle(cancellationRequested, cancelledByIdempotency)?.state,
      "cancelled"
    )

    const retainedOperation = Schema.decodeUnknownSync(GovernedActionLifecycleHeadV1)({
      state: "unknown",
      lineage: { _tag: "manual", providerOperationId: operationA }
    })
    const unrelatedReceipt = decodeCommand({
      _tag: "recordSucceeded",
      receipt: receipt(operationB, "succeeded"),
      source: { _tag: "reconciliation", reconciliationKey: null }
    })

    assert.isNull(advanceGovernedActionLifecycle(retainedOperation, unrelatedReceipt))
  })
})
