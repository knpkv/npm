import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"

import { Revision } from "../sourceRevision.js"
import { UtcTimestamp } from "../utcTimestamp.js"
import { PluginPayloadJson } from "./bounds.js"
import { PluginEntityReferenceV1 } from "./events.js"

const boundedOpaque = (name: string, maximum: number) =>
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(maximum)).pipe(Schema.brand(name))

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const SafeSummary = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_000))

/** Lowercase SHA-256 digest of a canonical governed-action payload. */
export const PluginActionPayloadDigest = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
).pipe(Schema.brand("PluginActionPayloadDigest"))

/** Decoded canonical payload digest. */
export type PluginActionPayloadDigest = typeof PluginActionPayloadDigest.Type

/** Request for a provider-neutral action proposal; it cannot authorize execution. */
export const ProposePluginActionRequestV1 = Schema.Struct({
  actionKind: boundedOpaque("PluginActionKind", 100),
  target: PluginEntityReferenceV1,
  expectedRevision: Revision,
  payload: PluginPayloadJson,
  evidenceIds: Schema.Array(boundedOpaque("PluginActionEvidenceId", 512)).check(
    Schema.isUnique(),
    Schema.makeFilter((evidenceIds) => evidenceIds.length <= 100, {
      expected: "at most 100 action evidence identities"
    })
  )
})

/** Proposal returned to the host for later policy and human authorization. */
export const PluginActionProposalV1 = Schema.Struct({
  proposalKey: boundedOpaque("PluginActionProposalKey", 512),
  capabilityVersion: PositiveInteger,
  request: ProposePluginActionRequestV1,
  payloadDigest: PluginActionPayloadDigest,
  summary: SafeSummary,
  impact: Schema.Struct({
    level: Schema.Literals(["low", "medium", "high", "critical"]),
    summary: SafeSummary
  }),
  proposedAt: UtcTimestamp
})

/** Host-authorized request accepted only by the sealed internal executor. */
export const AuthorizedPluginActionV1 = Schema.Struct({
  proposal: PluginActionProposalV1,
  idempotencyKey: boundedOpaque("PluginActionIdempotencyKey", 512),
  payloadDigest: PluginActionPayloadDigest,
  authorizationId: boundedOpaque("PluginActionAuthorizationId", 512),
  authorizedAt: UtcTimestamp,
  expiresAt: UtcTimestamp
}).check(
  Schema.makeFilter(({ authorizedAt, expiresAt }) => DateTime.Order(authorizedAt, expiresAt) < 0, {
    expected: "plugin action authorization to expire after it is issued"
  }),
  Schema.makeFilter(({ payloadDigest, proposal }) => payloadDigest === proposal.payloadDigest, {
    expected: "authorized payload digest to match its canonical proposal digest"
  })
)

/** Provider receipt safe to persist and display without raw response data. */
export const PluginProviderReceiptV1 = Schema.Struct({
  providerOperationId: boundedOpaque("PluginProviderOperationId", 512),
  status: Schema.Literals(["accepted", "succeeded", "failed", "cancelled"]),
  safeSummary: SafeSummary,
  observedAt: UtcTimestamp
})

const ReadyPreflight = Schema.TaggedStruct("ready", {
  checkedRevision: Revision,
  checkedAt: UtcTimestamp
})
const BlockedPreflight = Schema.TaggedStruct("blocked", {
  reasons: Schema.Array(SafeSummary).check(
    Schema.isNonEmpty(),
    Schema.makeFilter((reasons) => reasons.length <= 50, {
      expected: "at most 50 preflight reasons"
    })
  ),
  checkedAt: UtcTimestamp
})

/** Result of the final provider preflight before dispatch. */
export const PluginActionPreflightV1 = Schema.Union([ReadyPreflight, BlockedPreflight]).pipe(
  Schema.toTaggedUnion("_tag")
)

const ConfirmedDispatch = Schema.TaggedStruct("confirmed", {
  receipt: PluginProviderReceiptV1
})
const UnknownDispatch = Schema.TaggedStruct("unknown", {
  reconciliationKey: boundedOpaque("PluginActionReconciliationKey", 512),
  safeSummary: SafeSummary,
  observedAt: UtcTimestamp
})

/** Truthful immediate outcome of one authorized provider dispatch. */
export const PluginActionDispatchResultV1 = Schema.Union([ConfirmedDispatch, UnknownDispatch]).pipe(
  Schema.toTaggedUnion("_tag")
)

/** Request to cancel an action after its durable lifecycle permits cancellation. */
export const PluginActionCancellationRequestV1 = Schema.Struct({
  idempotencyKey: boundedOpaque("PluginCancellationIdempotencyKey", 512),
  providerOperationId: Schema.NullOr(boundedOpaque("PluginCancellationProviderOperationId", 512)),
  reconciliationKey: Schema.NullOr(boundedOpaque("PluginCancellationReconciliationKey", 512))
}).check(
  Schema.makeFilter(
    ({ providerOperationId, reconciliationKey }) => (providerOperationId === null) !== (reconciliationKey === null),
    { expected: "exactly one provider operation or reconciliation key" }
  )
)

/** Truthful cancellation response; provider completion may win the race. */
export const PluginActionCancellationResultV1 = Schema.Union([
  Schema.TaggedStruct("cancelled", { receipt: PluginProviderReceiptV1 }).check(
    Schema.makeFilter(({ receipt }) => receipt.status === "cancelled", { expected: "a cancelled provider receipt" })
  ),
  Schema.TaggedStruct("completed", { receipt: PluginProviderReceiptV1 }).check(
    Schema.makeFilter(({ receipt }) => receipt.status === "succeeded" || receipt.status === "failed", {
      expected: "a terminal succeeded or failed provider receipt"
    })
  ),
  Schema.TaggedStruct("unknown", {
    reconciliationKey: boundedOpaque("PluginCancellationUnknownKey", 512),
    observedAt: UtcTimestamp
  })
]).pipe(Schema.toTaggedUnion("_tag"))

/** Request to reconcile an ambiguous provider mutation without replaying it. */
export const PluginActionReconciliationRequestV1 = Schema.Struct({
  reconciliationKey: boundedOpaque("PluginReconciliationRequestKey", 512),
  idempotencyKey: boundedOpaque("PluginReconciliationIdempotencyKey", 512),
  payloadDigest: PluginActionPayloadDigest
})

/** Reconciled provider state. Cancelled means the mutation provably did not occur. */
export const PluginActionReconciliationResultV1 = Schema.Union([
  Schema.TaggedStruct("pending", { checkedAt: UtcTimestamp }),
  Schema.TaggedStruct("succeeded", { receipt: PluginProviderReceiptV1 }).check(
    Schema.makeFilter(({ receipt }) => receipt.status === "succeeded", { expected: "a succeeded provider receipt" })
  ),
  Schema.TaggedStruct("failed", { receipt: PluginProviderReceiptV1 }).check(
    Schema.makeFilter(({ receipt }) => receipt.status === "failed", { expected: "a failed provider receipt" })
  ),
  Schema.TaggedStruct("cancelled", { receipt: PluginProviderReceiptV1 }).check(
    Schema.makeFilter(({ receipt }) => receipt.status === "cancelled", { expected: "a cancelled provider receipt" })
  )
]).pipe(Schema.toTaggedUnion("_tag"))

export type ProposePluginActionRequestV1 = typeof ProposePluginActionRequestV1.Type
export type PluginActionProposalV1 = typeof PluginActionProposalV1.Type
export type AuthorizedPluginActionV1 = typeof AuthorizedPluginActionV1.Type
export type PluginProviderReceiptV1 = typeof PluginProviderReceiptV1.Type
export type PluginActionPreflightV1 = typeof PluginActionPreflightV1.Type
export type PluginActionDispatchResultV1 = typeof PluginActionDispatchResultV1.Type
export type PluginActionCancellationRequestV1 = typeof PluginActionCancellationRequestV1.Type
export type PluginActionCancellationResultV1 = typeof PluginActionCancellationResultV1.Type
export type PluginActionReconciliationRequestV1 = typeof PluginActionReconciliationRequestV1.Type
export type PluginActionReconciliationResultV1 = typeof PluginActionReconciliationResultV1.Type
