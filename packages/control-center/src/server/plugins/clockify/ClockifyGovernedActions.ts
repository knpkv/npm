/** Governed Clockify correction and Control Center approval actions. @internal */
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import {
  type AuthorizedPluginActionV1,
  PluginActionActorIdentityV1,
  type PluginActionCancellationRequestV1,
  type PluginActionDispatchResultV1,
  PluginActionPayloadDigest,
  PluginActionPreflightV1,
  PluginActionProposalV1,
  PluginActionReconciliationKey,
  type PluginActionReconciliationRequestV1,
  type PluginActionReconciliationResultV1,
  PluginProviderOperationId,
  type PluginTerminalProviderReceiptV1,
  type ProposePluginActionRequestV1
} from "../../../domain/plugins/index.js"
import { Revision } from "../../../domain/sourceRevision.js"
import { canonicalizeGovernedActionJson, digestGovernedActionPayload } from "../../governance/governedActionDigests.js"
import {
  PluginConfigurationFailure,
  PluginConflictFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginTimeoutFailure,
  PluginUnknownOutcomeFailure,
  PluginUnsupportedCapabilityFailure
} from "../failures.js"
import type { AuthorizedPluginExecutorV1 } from "../PluginExecutor.js"
import type { ClockifyReadPluginConfiguration } from "./ClockifyReadPlugin.js"
import type { ClockifyReadProvider } from "./ClockifyReadProvider.js"
import {
  ClockifyCustomField,
  ClockifyDescription,
  ClockifyDuration,
  ClockifyIdentifier,
  type ClockifyTimeEntrySnapshot,
  ClockifyWritableDescription,
  decodeClockifyTimeEntry,
  revisionOfClockifyTimeEntry
} from "./ClockifyTimeEntryNormalization.js"

const ENTITY_TYPE = "time-entry"
const CORRECT_ASSOCIATION = "correct-association"
const RECORD_APPROVAL = "record-approval"
const AUTHORIZATION_OBSERVATION = "authorization"
const CLOCKIFY_RATE_LIMIT_RETRY_MAX_DELAY_MILLIS = 5_000
const ReconciliationLocator = Schema.TemplateLiteralParser([
  "clockify-correction:v1:",
  PluginActionPayloadDigest
])

export const ClockifyJiraIssueKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/u),
  Schema.isMaxLength(100)
)
const ApprovalRationale = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_000)
)
const CanonicalTagIds = Schema.Array(ClockifyIdentifier).check(
  Schema.isUnique(),
  Schema.makeFilter((values) => values.length <= 100, { expected: "at most 100 Clockify tags" })
)
const EntryType = Schema.Literals(["REGULAR", "BREAK", "HOLIDAY", "TIME_OFF"])
const ClockifyActionTimestamp = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(40),
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u)
)
const CorrectAssociationRequest = Schema.Struct({ jiraIssueKey: ClockifyJiraIssueKey })
const RecordApprovalRequest = Schema.Struct({
  decision: Schema.Literals(["approved", "rejected"]),
  rationale: ApprovalRationale
})

export const ClockifyCorrectAssociationPayload = Schema.TaggedStruct(CORRECT_ASSOCIATION, {
  workspaceId: ClockifyIdentifier,
  userId: ClockifyIdentifier,
  entryId: ClockifyIdentifier,
  expectedRevision: Revision,
  desiredRevision: Revision,
  jiraIssueKey: ClockifyJiraIssueKey,
  originalDescription: ClockifyDescription,
  correctedDescription: ClockifyWritableDescription,
  customFields: Schema.Array(ClockifyCustomField).check(Schema.isMaxLength(50)),
  start: ClockifyActionTimestamp,
  end: Schema.NullOr(ClockifyActionTimestamp),
  duration: Schema.NullOr(ClockifyDuration),
  projectId: Schema.NullOr(ClockifyIdentifier),
  taskId: Schema.NullOr(ClockifyIdentifier),
  tagIds: CanonicalTagIds,
  billable: Schema.Boolean,
  entryType: EntryType
})
export type ClockifyCorrectAssociationPayload = typeof ClockifyCorrectAssociationPayload.Type

export const ClockifyRecordApprovalPayload = Schema.TaggedStruct(RECORD_APPROVAL, {
  workspaceId: ClockifyIdentifier,
  userId: ClockifyIdentifier,
  entryId: ClockifyIdentifier,
  expectedRevision: Revision,
  decision: Schema.Literals(["approved", "rejected"]),
  rationale: ApprovalRationale
})
export type ClockifyRecordApprovalPayload = typeof ClockifyRecordApprovalPayload.Type

const ClockifyActionPayload = Schema.Union([
  ClockifyCorrectAssociationPayload,
  ClockifyRecordApprovalPayload
]).pipe(Schema.toTaggedUnion("_tag"))
type ClockifyActionPayload = typeof ClockifyActionPayload.Type

const isCorrectionPayload = (payload: ClockifyActionPayload): boolean => payload._tag === CORRECT_ASSOCIATION

const CurrentUser = Schema.Struct({ id: ClockifyIdentifier })

const configurationFailure = (diagnosticCode: string) => new PluginConfigurationFailure({ diagnosticCode })
const conflict = (diagnosticCode: string) =>
  new PluginConflictFailure({ operation: "clockify-governed-action", diagnosticCode })
const malformed = (operation: string, diagnosticCode: string) =>
  new PluginMalformedResponseFailure({ operation, diagnosticCode })

const isClockifyIdentityDrift = (failure: PluginFailure): boolean =>
  failure._tag === "PluginMalformedResponseFailure" &&
  [
    "clockify-time-entry-identity-mismatch",
    "clockify-time-entry-user-mismatch",
    "clockify-time-entry-workspace-mismatch"
  ].includes(failure.diagnosticCode)

const isConfirmedClockifyRejection = (failure: PluginFailure): boolean => {
  switch (failure._tag) {
    case "PluginAuthenticationFailure":
    case "PluginAuthorizationFailure":
    case "PluginConflictFailure":
      return true
    case "PluginRateLimitFailure":
    case "PluginTimeoutFailure":
    case "PluginMalformedResponseFailure":
    case "PluginOutageFailure":
    case "PluginCancellationFailure":
    case "PluginUnsupportedCapabilityFailure":
    case "PluginConfigurationFailure":
    case "PluginUnknownOutcomeFailure":
      return false
  }
}

const withTimeout = <Value>(
  operation: string,
  duration: number,
  effect: Effect.Effect<Value, PluginFailure>
): Effect.Effect<Value, PluginFailure> =>
  Effect.timeoutOrElse(effect, {
    duration,
    orElse: () => Effect.fail(new PluginTimeoutFailure({ operation }))
  })

const output = <S extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  schema: S,
  value: unknown
): Effect.Effect<S["Type"], PluginMalformedResponseFailure> =>
  Schema.decodeUnknownEffect(Schema.toType(schema))(value).pipe(
    Effect.mapError(() => malformed(`clockify-action-${operation}`, "clockify-action-output-invalid"))
  )

/** Remove one supported leading Jira marker and prefix the canonical marker. @internal */
export const correctClockifyAssociationDescription = (
  description: string,
  jiraIssueKey: string
): string => {
  const note = description.replace(
    /^(?:\[[A-Z][A-Z0-9]*-[1-9][0-9]*\]|[A-Z][A-Z0-9]*-[1-9][0-9]*:)(?:\s+|$)/u,
    ""
  )
  return note.length === 0 ? `[${jiraIssueKey}]` : `[${jiraIssueKey}] ${note}`
}

const snapshotRevision = (
  snapshot: ClockifyTimeEntrySnapshot,
  cryptoService: Crypto.Crypto
): Effect.Effect<string, PluginFailure> =>
  revisionOfClockifyTimeEntry(snapshot).pipe(
    Effect.provideService(Crypto.Crypto, cryptoService),
    Effect.mapError(() => new PluginOutageFailure({ operation: "clockify-action-revision" }))
  )

const readSnapshot = Effect.fn("ClockifyGovernedActions.readSnapshot")(function*(
  input: GovernedActionsInput,
  entryId: string
): Effect.fn.Return<ClockifyTimeEntrySnapshot, PluginFailure> {
  const raw = yield* withTimeout(
    "clockify-action-get-time-entry",
    input.configuration.operationTimeoutMillis,
    input.provider.getTimeEntry(input.configuration.workspaceId, entryId, { hydrated: true })
  )
  if (Option.isNone(raw)) return yield* conflict("clockify-time-entry-missing")
  const snapshot = yield* decodeClockifyTimeEntry({
    allowedUserIds: new Set(input.userIds),
    entry: raw.value,
    expectedWorkspaceId: input.configuration.workspaceId
  })
  if (snapshot.id !== entryId) {
    return yield* malformed(
      "clockify-get-time-entry",
      "clockify-time-entry-identity-mismatch"
    )
  }
  return snapshot
})

const assertCompleted = (
  snapshot: ClockifyTimeEntrySnapshot
): Effect.Effect<void, PluginConflictFailure> =>
  snapshot.end === null
    ? Effect.fail(conflict("clockify-time-entry-running"))
    : Effect.void

const assertCorrectable = (
  snapshot: ClockifyTimeEntrySnapshot
): Effect.Effect<void, PluginConflictFailure> => {
  if (snapshot.isLocked) return Effect.fail(conflict("clockify-time-entry-locked"))
  if (snapshot.entryType === "HOLIDAY" || snapshot.entryType === "TIME_OFF") {
    return Effect.fail(conflict("clockify-time-entry-type-unsupported"))
  }
  return Effect.void
}

const samePreservedFields = (
  snapshot: ClockifyTimeEntrySnapshot,
  payload: ClockifyCorrectAssociationPayload
): boolean =>
  snapshot.customFieldsComplete &&
  snapshot.workspaceId === payload.workspaceId &&
  snapshot.userId === payload.userId &&
  snapshot.id === payload.entryId &&
  DateTime.formatIso(snapshot.start) === payload.start &&
  (snapshot.end === null ? null : DateTime.formatIso(snapshot.end)) === payload.end &&
  snapshot.duration === payload.duration &&
  snapshot.projectId === payload.projectId &&
  snapshot.taskId === payload.taskId &&
  snapshot.billable === payload.billable &&
  snapshot.entryType === payload.entryType &&
  canonicalizeGovernedActionJson(snapshot.customFields) ===
    canonicalizeGovernedActionJson(payload.customFields) &&
  snapshot.tagIds.length === payload.tagIds.length &&
  snapshot.tagIds.every((tagId, index) => tagId === payload.tagIds[index])

const operationId = (
  payload: ClockifyActionPayload,
  digest: string
): typeof PluginProviderOperationId.Type => PluginProviderOperationId.make(`clockify:${payload._tag}:${digest}`)

const reconciliationKey = (digest: string): typeof PluginActionReconciliationKey.Type =>
  PluginActionReconciliationKey.make(
    Schema.encodeSync(ReconciliationLocator)([
      "clockify-correction:v1:",
      PluginActionPayloadDigest.make(digest)
    ])
  )

const decodeReconciliationKey = (
  key: typeof PluginActionReconciliationKey.Type
): Effect.Effect<typeof PluginActionPayloadDigest.Type, PluginConfigurationFailure> =>
  Schema.decodeUnknownEffect(ReconciliationLocator)(key).pipe(
    Effect.map(([, digest]) => digest),
    Effect.mapError(() => configurationFailure("clockify-reconciliation-locator-invalid"))
  )

const succeededReceipt = (
  payload: ClockifyActionPayload,
  digest: string,
  observedAt: DateTime.Utc
): PluginTerminalProviderReceiptV1 => ({
  status: "succeeded",
  providerOperationId: operationId(payload, digest),
  ...(payload._tag === RECORD_APPROVAL
    ? { observationBasis: AUTHORIZATION_OBSERVATION }
    : {}),
  safeSummary: payload._tag === CORRECT_ASSOCIATION
    ? `Corrected Clockify entry ${payload.entryId} association to ${payload.jiraIssueKey}`
    : `Recorded Control Center ${payload.decision} decision for Clockify entry ${payload.entryId}`,
  observedAt
})

const succeeded = (
  payload: ClockifyActionPayload,
  digest: string,
  observedAt: DateTime.Utc
): PluginActionDispatchResultV1 => ({
  _tag: "confirmed",
  receipt: succeededReceipt(payload, digest, observedAt)
})

const failed = (
  payload: ClockifyActionPayload,
  digest: string,
  observedAt: DateTime.Utc,
  safeSummary: string
): PluginActionDispatchResultV1 => ({
  _tag: "confirmed",
  receipt: {
    status: "failed",
    providerOperationId: operationId(payload, digest),
    safeSummary,
    observedAt
  }
})

const decodeAuthorized = Effect.fn("ClockifyGovernedActions.decodeAuthorized")(function*(
  input: GovernedActionsInput,
  request: AuthorizedPluginActionV1
): Effect.fn.Return<ClockifyActionPayload, PluginFailure> {
  const proposal = request.proposal
  if (
    proposal.request.target.entityType !== ENTITY_TYPE ||
    (proposal.request.actionKind !== CORRECT_ASSOCIATION && proposal.request.actionKind !== RECORD_APPROVAL)
  ) {
    return yield* configurationFailure("clockify-action-envelope-invalid")
  }
  const payload = yield* Schema.decodeUnknownEffect(Schema.toType(ClockifyActionPayload))(
    proposal.request.payload
  ).pipe(Effect.mapError(() => configurationFailure("clockify-action-payload-invalid")))
  if (
    payload._tag !== proposal.request.actionKind ||
    payload.workspaceId !== input.configuration.workspaceId ||
    payload.entryId !== proposal.request.target.vendorImmutableId ||
    payload.expectedRevision !== proposal.request.expectedRevision ||
    !input.userIds.includes(payload.userId)
  ) {
    return yield* configurationFailure("clockify-action-payload-envelope-mismatch")
  }
  const actualDigest = yield* digestGovernedActionPayload(payload).pipe(
    Effect.provideService(Crypto.Crypto, input.cryptoService),
    Effect.mapError(() => new PluginOutageFailure({ operation: "clockify-action-digest" }))
  )
  if (actualDigest !== request.payloadDigest || actualDigest !== proposal.payloadDigest) {
    return yield* configurationFailure("clockify-action-payload-digest-mismatch")
  }
  return payload
})

interface GovernedActionsInput {
  readonly provider: ClockifyReadProvider
  readonly configuration: ClockifyReadPluginConfiguration
  readonly userIds: ReadonlyArray<string>
  readonly cryptoService: Crypto.Crypto
}

/** Build the governed Clockify proposal and sealed executor surfaces. @internal */
export const makeClockifyGovernedActions = (
  input: GovernedActionsInput
): {
  readonly actionActorIdentity: Effect.Effect<typeof PluginActionActorIdentityV1.Type, PluginFailure>
  readonly proposeAction: (
    request: ProposePluginActionRequestV1
  ) => Effect.Effect<typeof PluginActionProposalV1.Type, PluginFailure>
  readonly executor: AuthorizedPluginExecutorV1
} => {
  const actionActorIdentity = Effect.gen(function*() {
    const current = yield* withTimeout(
      "clockify-action-current-user",
      input.configuration.operationTimeoutMillis,
      input.provider.getCurrentUser
    ).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeUnknownEffect(CurrentUser)(raw).pipe(
          Effect.mapError(() => malformed("clockify-current-user", "clockify-current-user-shape-invalid"))
        )
      )
    )
    return yield* Schema.decodeUnknownEffect(PluginActionActorIdentityV1)({
      providerId: "clockify",
      providerAccountId: input.configuration.workspaceId,
      principal: current.id
    }).pipe(Effect.mapError(() => configurationFailure("clockify-action-actor-invalid")))
  })

  const proposeAction = Effect.fn("ClockifyGovernedActions.propose")(function*(
    request: ProposePluginActionRequestV1
  ): Effect.fn.Return<typeof PluginActionProposalV1.Type, PluginFailure> {
    if (
      request.target.entityType !== ENTITY_TYPE ||
      (request.actionKind !== CORRECT_ASSOCIATION && request.actionKind !== RECORD_APPROVAL)
    ) {
      return yield* new PluginUnsupportedCapabilityFailure({
        capabilityId: "action.propose",
        requestedVersion: 1,
        diagnosticCode: "clockify-action-kind-or-target-unsupported"
      })
    }
    const snapshot = yield* readSnapshot(input, request.target.vendorImmutableId)
    yield* assertCompleted(snapshot)
    const currentRevision = yield* snapshotRevision(snapshot, input.cryptoService)
    if (currentRevision !== request.expectedRevision) {
      return yield* conflict("clockify-time-entry-revision-changed")
    }

    const payload: ClockifyActionPayload = request.actionKind === CORRECT_ASSOCIATION
      ? yield* Effect.gen(function*() {
        yield* assertCorrectable(snapshot)
        if (!snapshot.customFieldsComplete) {
          return yield* conflict("clockify-time-entry-custom-fields-incomplete")
        }
        const requested = yield* Schema.decodeUnknownEffect(Schema.toType(CorrectAssociationRequest))(
          request.payload
        ).pipe(Effect.mapError(() => configurationFailure("clockify-correction-request-invalid")))
        const correctedDescription = correctClockifyAssociationDescription(
          snapshot.description,
          requested.jiraIssueKey
        )
        const boundedDescription = yield* Schema.decodeUnknownEffect(ClockifyWritableDescription)(
          correctedDescription
        ).pipe(Effect.mapError(() => configurationFailure("clockify-corrected-description-invalid")))
        if (boundedDescription === snapshot.description) {
          return yield* conflict("clockify-association-already-correct")
        }
        const desiredRevision = yield* snapshotRevision(
          { ...snapshot, description: boundedDescription },
          input.cryptoService
        )
        return ClockifyCorrectAssociationPayload.make({
          _tag: CORRECT_ASSOCIATION,
          workspaceId: snapshot.workspaceId,
          userId: snapshot.userId,
          entryId: snapshot.id,
          expectedRevision: Revision.make(currentRevision),
          desiredRevision: Revision.make(desiredRevision),
          jiraIssueKey: requested.jiraIssueKey,
          originalDescription: snapshot.description,
          correctedDescription: boundedDescription,
          customFields: snapshot.customFields,
          start: DateTime.formatIso(snapshot.start),
          end: snapshot.end === null ? null : DateTime.formatIso(snapshot.end),
          duration: snapshot.duration,
          projectId: snapshot.projectId,
          taskId: snapshot.taskId,
          tagIds: [...snapshot.tagIds],
          billable: snapshot.billable,
          entryType: snapshot.entryType
        })
      })
      : yield* Effect.gen(function*() {
        const requested = yield* Schema.decodeUnknownEffect(Schema.toType(RecordApprovalRequest))(
          request.payload
        ).pipe(Effect.mapError(() => configurationFailure("clockify-approval-request-invalid")))
        return ClockifyRecordApprovalPayload.make({
          _tag: RECORD_APPROVAL,
          workspaceId: snapshot.workspaceId,
          userId: snapshot.userId,
          entryId: snapshot.id,
          expectedRevision: Revision.make(currentRevision),
          decision: requested.decision,
          rationale: requested.rationale
        })
      })

    const payloadDigest = yield* digestGovernedActionPayload(payload).pipe(
      Effect.provideService(Crypto.Crypto, input.cryptoService),
      Effect.mapError(() => new PluginOutageFailure({ operation: "clockify-action-digest" }))
    )
    const proposedAt = yield* DateTime.now
    return yield* output("proposal", PluginActionProposalV1, {
      proposalKey: `clockify:${payload._tag}:${payloadDigest}`,
      capabilityVersion: 1,
      request: { ...request, payload },
      payloadDigest,
      summary: payload._tag === CORRECT_ASSOCIATION
        ? `Correct Clockify entry ${payload.entryId} association to ${payload.jiraIssueKey}`
        : `Record Control Center ${payload.decision} decision for Clockify entry ${payload.entryId}`,
      impact: {
        level: payload._tag === CORRECT_ASSOCIATION ? "medium" : "low",
        summary: payload._tag === CORRECT_ASSOCIATION
          ? "Changes only the leading Jira marker in the Clockify entry description"
          : "Records a revision-scoped Control Center decision without changing Clockify"
      },
      proposedAt
    })
  })

  const preflight = Effect.fn("ClockifyGovernedActions.preflight")(function*(
    request: AuthorizedPluginActionV1
  ) {
    const payload = yield* decodeAuthorized(input, request)
    if (isCorrectionPayload(payload)) {
      return yield* new PluginUnsupportedCapabilityFailure({
        capabilityId: "action.execute",
        requestedVersion: 1,
        diagnosticCode: "clockify-correction-provider-atomic-revision-unavailable"
      })
    }
    const checkedAt = yield* DateTime.now
    const snapshotResult = yield* readSnapshot(input, payload.entryId).pipe(Effect.result)
    if (snapshotResult._tag === "Failure") {
      if (
        snapshotResult.failure._tag === "PluginConflictFailure" ||
        isClockifyIdentityDrift(snapshotResult.failure)
      ) {
        return yield* output("preflight", PluginActionPreflightV1, {
          _tag: "blocked",
          reasons: ["Clockify entry is no longer available in this connection"],
          checkedAt
        })
      }
      return yield* snapshotResult.failure
    }
    const snapshot = snapshotResult.success
    const revision = yield* snapshotRevision(snapshot, input.cryptoService)
    const blocked = snapshot.end === null ||
      (payload._tag === CORRECT_ASSOCIATION &&
        (snapshot.isLocked ||
          snapshot.entryType === "HOLIDAY" ||
          snapshot.entryType === "TIME_OFF" ||
          !samePreservedFields(snapshot, payload))) ||
      revision !== payload.expectedRevision
    return yield* output(
      "preflight",
      PluginActionPreflightV1,
      blocked
        ? {
          _tag: "blocked",
          reasons: ["Clockify entry changed after authorization"],
          checkedAt
        }
        : {
          _tag: "ready",
          checkedRevision: Revision.make(revision),
          checkedAt
        }
    )
  })

  const executeAuthorizedAction = Effect.fn("ClockifyGovernedActions.execute")(function*(
    request: AuthorizedPluginActionV1
  ): Effect.fn.Return<PluginActionDispatchResultV1, PluginFailure> {
    const payload = yield* decodeAuthorized(input, request)
    if (isCorrectionPayload(payload)) {
      return yield* new PluginUnsupportedCapabilityFailure({
        capabilityId: "action.execute",
        requestedVersion: 1,
        diagnosticCode: "clockify-correction-provider-atomic-revision-unavailable"
      })
    }
    const currentResult = yield* Effect.gen(function*() {
      const snapshot = yield* readSnapshot(input, payload.entryId)
      const revision = yield* snapshotRevision(snapshot, input.cryptoService)
      return { snapshot, revision }
    }).pipe(Effect.result)
    if (currentResult._tag === "Failure") {
      return failed(
        payload,
        request.payloadDigest,
        yield* DateTime.now,
        `Clockify entry ${payload.entryId} could not be verified before the authorized action`
      )
    }
    const current = currentResult.success.snapshot
    const currentRevision = currentResult.success.revision
    if (payload._tag === RECORD_APPROVAL) {
      if (currentRevision !== payload.expectedRevision) {
        return failed(
          payload,
          request.payloadDigest,
          yield* DateTime.now,
          `Clockify entry ${payload.entryId} changed before the Control Center decision was recorded`
        )
      }
      return succeeded(payload, request.payloadDigest, request.authorizedAt)
    }
    if (
      samePreservedFields(current, payload) &&
      current.description === payload.correctedDescription &&
      currentRevision === payload.desiredRevision
    ) {
      return succeeded(payload, request.payloadDigest, yield* DateTime.now)
    }
    if (
      currentRevision !== payload.expectedRevision ||
      current.description !== payload.originalDescription ||
      current.isLocked ||
      current.end === null ||
      !samePreservedFields(current, payload)
    ) {
      return failed(
        payload,
        request.payloadDigest,
        yield* DateTime.now,
        `Clockify entry ${payload.entryId} changed before the authorized correction`
      )
    }

    const updateTimeEntry = () =>
      withTimeout(
        "clockify-update-time-entry",
        input.configuration.operationTimeoutMillis,
        input.provider.updateTimeEntry(
          payload.workspaceId,
          payload.entryId,
          {
            billable: payload.billable,
            customFields: payload.customFields,
            description: payload.correctedDescription,
            ...(payload.end === null ? {} : { end: payload.end }),
            ...(payload.projectId === null ? {} : { projectId: payload.projectId }),
            start: payload.start,
            tagIds: [...payload.tagIds],
            ...(payload.taskId === null ? {} : { taskId: payload.taskId }),
            ...(payload.entryType === "REGULAR" || payload.entryType === "BREAK"
              ? { type: payload.entryType }
              : {})
          }
        )
      )
    const firstUpdate = yield* updateTimeEntry().pipe(Effect.result)
    const update = yield* Effect.gen(function*() {
      if (
        firstUpdate._tag !== "Failure" ||
        firstUpdate.failure._tag !== "PluginRateLimitFailure"
      ) {
        return firstUpdate
      }
      const rateLimitFailure = firstUpdate.failure
      const now = yield* DateTime.now
      const delayMillis = Math.max(
        0,
        DateTime.toEpochMillis(rateLimitFailure.retryAt) - DateTime.toEpochMillis(now)
      )
      if (delayMillis > CLOCKIFY_RATE_LIMIT_RETRY_MAX_DELAY_MILLIS) return firstUpdate
      yield* Effect.sleep(Duration.millis(delayMillis))
      return yield* updateTimeEntry().pipe(Effect.result)
    })
    const observedAt = yield* DateTime.now
    if (update._tag === "Failure") {
      if (update.failure._tag === "PluginRateLimitFailure") {
        return failed(
          payload,
          request.payloadDigest,
          observedAt,
          `Clockify rate limited the authorized correction for entry ${payload.entryId} before applying it`
        )
      }
      if (isConfirmedClockifyRejection(update.failure)) {
        return failed(
          payload,
          request.payloadDigest,
          observedAt,
          `Clockify rejected the authorized correction for entry ${payload.entryId}`
        )
      }
      if (
        update.failure._tag === "PluginTimeoutFailure" ||
        update.failure._tag === "PluginOutageFailure" ||
        update.failure._tag === "PluginMalformedResponseFailure"
      ) {
        return yield* new PluginUnknownOutcomeFailure({
          operation: "clockify-update-time-entry",
          reconciliationKey: reconciliationKey(request.payloadDigest)
        })
      }
      return yield* update.failure
    }
    const updated = yield* decodeClockifyTimeEntry({
      allowedUserIds: new Set(input.userIds),
      entry: update.success,
      expectedWorkspaceId: input.configuration.workspaceId
    }).pipe(
      Effect.catchTag("PluginMalformedResponseFailure", () =>
        Effect.fail(
          new PluginUnknownOutcomeFailure({
            operation: "clockify-update-time-entry",
            reconciliationKey: reconciliationKey(request.payloadDigest)
          })
        ))
    )
    const updatedRevision = yield* snapshotRevision(updated, input.cryptoService)
    if (
      !samePreservedFields(updated, payload) ||
      updated.description !== payload.correctedDescription ||
      updatedRevision !== payload.desiredRevision
    ) {
      return yield* new PluginUnknownOutcomeFailure({
        operation: "clockify-update-time-entry",
        reconciliationKey: reconciliationKey(request.payloadDigest)
      })
    }
    return succeeded(payload, request.payloadDigest, observedAt)
  })

  const reconcile = Effect.fn("ClockifyGovernedActions.reconcile")(function*(
    request: PluginActionReconciliationRequestV1
  ): Effect.fn.Return<PluginActionReconciliationResultV1, PluginFailure> {
    if (request.authorizedAction === undefined) {
      return yield* configurationFailure("clockify-reconciliation-authorized-action-missing")
    }
    const payload = yield* decodeAuthorized(input, request.authorizedAction)
    if (isCorrectionPayload(payload)) {
      return yield* new PluginUnsupportedCapabilityFailure({
        capabilityId: "action.reconcile",
        requestedVersion: 1,
        diagnosticCode: "clockify-correction-provider-atomic-revision-unavailable"
      })
    }
    if (
      request.idempotencyKey !== request.authorizedAction.idempotencyKey ||
      request.payloadDigest !== request.authorizedAction.payloadDigest
    ) {
      return yield* configurationFailure("clockify-reconciliation-envelope-mismatch")
    }
    if (payload._tag === RECORD_APPROVAL) {
      return {
        _tag: "succeeded",
        receipt: succeededReceipt(
          payload,
          request.payloadDigest,
          request.authorizedAction.authorizedAt
        )
      }
    }
    const locatorDigest = request.reconciliationKey === null
      ? request.authorizedAction.payloadDigest
      : yield* decodeReconciliationKey(request.reconciliationKey)
    if (locatorDigest !== request.payloadDigest) {
      return yield* configurationFailure("clockify-reconciliation-locator-mismatch")
    }
    const raw = yield* withTimeout(
      "clockify-reconcile-get-time-entry",
      input.configuration.operationTimeoutMillis,
      input.provider.getTimeEntry(payload.workspaceId, payload.entryId, { hydrated: true })
    )
    const checkedAt = yield* DateTime.now
    if (Option.isNone(raw)) return { _tag: "pending", checkedAt }
    const snapshotResult = yield* decodeClockifyTimeEntry({
      allowedUserIds: new Set(input.userIds),
      entry: raw.value,
      expectedWorkspaceId: input.configuration.workspaceId
    }).pipe(Effect.result)
    if (snapshotResult._tag === "Failure") {
      if (!isClockifyIdentityDrift(snapshotResult.failure)) {
        return yield* snapshotResult.failure
      }
      return {
        _tag: "failed",
        receipt: {
          status: "failed",
          providerOperationId: operationId(payload, request.payloadDigest),
          safeSummary: `Clockify entry ${payload.entryId} changed independently of the authorized correction`,
          observedAt: checkedAt
        }
      }
    }
    const snapshot = snapshotResult.success
    if (snapshot.id !== payload.entryId || !samePreservedFields(snapshot, payload)) {
      return {
        _tag: "failed",
        receipt: {
          status: "failed",
          providerOperationId: operationId(payload, request.payloadDigest),
          safeSummary: `Clockify entry ${payload.entryId} changed independently of the authorized correction`,
          observedAt: checkedAt
        }
      }
    }
    const revision = yield* snapshotRevision(snapshot, input.cryptoService)
    if (snapshot.description === payload.correctedDescription && revision === payload.desiredRevision) {
      return { _tag: "succeeded", receipt: succeededReceipt(payload, request.payloadDigest, checkedAt) }
    }
    if (snapshot.description === payload.originalDescription && revision === payload.expectedRevision) {
      return { _tag: "pending", checkedAt }
    }
    return {
      _tag: "failed",
      receipt: {
        status: "failed",
        providerOperationId: operationId(payload, request.payloadDigest),
        safeSummary: `Clockify entry ${payload.entryId} no longer matches the authorized correction`,
        observedAt: checkedAt
      }
    }
  })

  return {
    actionActorIdentity,
    proposeAction,
    executor: {
      preflight,
      executeAuthorizedAction,
      requestCancellation: (_request: PluginActionCancellationRequestV1) =>
        Effect.fail(
          new PluginUnsupportedCapabilityFailure({
            capabilityId: "action.cancel",
            requestedVersion: 1,
            diagnosticCode: "clockify-action-cancellation-unavailable"
          })
        ),
      reconcile
    }
  }
}
