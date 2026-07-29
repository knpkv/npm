/** Authenticated product boundary for governed Clockify corrections and approvals. @module */
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import type { SubmitClockifyActionRequest, SubmitClockifyActionResponse } from "../../api/deliveryGraph.js"
import {
  GovernedActionAuthorizationV1,
  GovernedActionCommandId,
  GovernedActionEnvelopeMaterialV1,
  type GovernedActionEnvelopeV1,
  type GovernedActionEvidenceSet,
  GovernedActionIdempotencyKey,
  GovernedActionPluginConnectionAuthorityDigest,
  GovernedActionPluginConnectionRevision,
  type GovernedActionTransitionCause
} from "../../domain/governedAction/index.js"
import {
  DomainEventId,
  type EntityId,
  GovernedActionAuthorizationId,
  GovernedActionId,
  GovernedActionTransitionId,
  type WorkspaceId
} from "../../domain/identifiers.js"
import { type PluginActionProposalV1, ProposePluginActionRequestV1 } from "../../domain/plugins/index.js"
import type { SessionSummary } from "../auth/models.js"
import {
  digestCanonicalGovernedActionJson,
  digestGovernedActionEvidenceSet,
  makeGovernedActionEnvelope
} from "../governance/governedActionDigests.js"
import {
  GovernedActionPolicyBindingSource,
  GovernedActionProposalAuthority,
  GovernedActionSubmission
} from "../governance/GovernedActionSubmission.js"
import { RecordNotFoundError } from "../persistence/errors.js"
import { Persistence } from "../persistence/Persistence.js"
import {
  GovernedActionCommitInput,
  type GovernedActionRecord
} from "../persistence/repositories/governedActionRepository.js"
import { PluginConflictFailure } from "../plugins/failures.js"
import { PluginConnection } from "../plugins/PluginConnection.js"
import { PluginConnectionMap } from "../plugins/PluginConnectionMap.js"

/** Closed failure from the authenticated Clockify action product boundary. */
export class ClockifyActionSubmissionError extends Schema.TaggedErrorClass<ClockifyActionSubmissionError>()(
  "ClockifyActionSubmissionError",
  { reason: Schema.Literals(["conflict", "forbidden", "invalid-request", "unavailable"]) }
) {}

interface SubmitClockifyActionInput {
  readonly entityId: EntityId
  readonly request: SubmitClockifyActionRequest
  readonly session: SessionSummary
  readonly workspaceId: WorkspaceId
}

/** Human-only application service; provider executors never escape this boundary. */
export class ClockifyActionSubmissions extends Context.Service<
  ClockifyActionSubmissions,
  {
    readonly submit: (
      input: SubmitClockifyActionInput
    ) => Effect.Effect<SubmitClockifyActionResponse, ClockifyActionSubmissionError>
  }
>()("@knpkv/control-center/server/application/ClockifyActionSubmissions") {}

const failure = (reason: ClockifyActionSubmissionError["reason"]) => new ClockifyActionSubmissionError({ reason })

/** Stable HTTP-facing classification for typed provider and persistence failures. */
export const classifyClockifyActionSubmissionFailure = (
  cause: unknown
): ClockifyActionSubmissionError["reason"] =>
  Schema.is(ClockifyActionSubmissionError)(cause)
    ? cause.reason
    : Schema.is(PluginConflictFailure)(cause) || Schema.is(RecordNotFoundError)(cause)
    ? "conflict"
    : "unavailable"

const mapFailure = Effect.catch((cause) =>
  Schema.is(ClockifyActionSubmissionError)(cause)
    ? Effect.fail(cause)
    : Effect.fail(failure(classifyClockifyActionSubmissionFailure(cause)))
)

const canAdvance = (state: string): boolean =>
  state === "authorized" ||
  state === "started" ||
  state === "unknown" ||
  state === "cancel-requested" ||
  state === "cancel-requested-unknown"

const clockifyActionSubmissionIdempotencyKey = Effect.fn(
  "ClockifyActionSubmissions.idempotencyKey"
)(function*(input: {
  readonly entityId: EntityId
  readonly request: SubmitClockifyActionRequest
  readonly workspaceId: WorkspaceId
}) {
  const request = input.request._tag === "correct-association"
    ? {
      _tag: input.request._tag,
      expectedRevision: input.request.expectedRevision,
      jiraIssueKey: input.request.jiraIssueKey
    }
    : {
      _tag: input.request._tag,
      expectedRevision: input.request.expectedRevision,
      decision: input.request.decision,
      rationale: input.request.rationale
    }
  const digest = yield* digestCanonicalGovernedActionJson({
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    entityId: input.entityId,
    request
  })
  return GovernedActionIdempotencyKey.make(`clockify-submission:v1:${digest}`)
})

/** Require an idempotent proposal retry to remain on its original runtime generation. */
export const clockifyActionRuntimeAuthorityMatches = (
  envelope: GovernedActionEnvelopeV1,
  connectionRevision: number,
  runtimeAuthorityToken: string
): boolean =>
  Number(envelope.pluginConnectionRevision) === Number(connectionRevision) &&
  envelope.pluginConnectionAuthorityDigest === runtimeAuthorityToken

/** Match stable provider proposal authority while ignoring the observation timestamp of a retry. */
export const clockifyActionProposalMatches = (
  persisted: PluginActionProposalV1,
  candidate: PluginActionProposalV1
): boolean => {
  const { proposedAt: _persistedProposedAt, ...persistedAuthority } = persisted
  const { proposedAt: _candidateProposedAt, ...candidateAuthority } = candidate
  return Equal.equals(persistedAuthority, candidateAuthority)
}

const makeService = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const connections = yield* PluginConnectionMap
  const persistence = yield* Persistence
  const proposalAuthority = yield* GovernedActionProposalAuthority
  const policies = yield* GovernedActionPolicyBindingSource
  const submission = yield* GovernedActionSubmission

  const submit = Effect.fn("ClockifyActionSubmissions.submit")(function*(input: SubmitClockifyActionInput) {
    const checkedAt = yield* DateTime.now
    if (
      input.session.actor._tag !== "human" ||
      input.session.workspaceId !== input.workspaceId ||
      input.session.revokedAt !== null ||
      DateTime.Order(checkedAt, input.session.idleExpiresAt) >= 0 ||
      DateTime.Order(checkedAt, input.session.absoluteExpiresAt) >= 0
    ) return yield* failure("conflict")
    if (
      input.request._tag === "correct-association"
        ? input.session.permission !== "workspace-owner"
        : input.session.permission !== "workspace-owner" &&
          input.session.permission !== "workspace-approver"
    ) return yield* failure("forbidden")
    const session = input.session
    if (session.actor._tag !== "human") return yield* failure("conflict")
    const actor = session.actor

    const entity = yield* persistence.entities.get(input.workspaceId, input.entityId).pipe(mapFailure)
    const source = entity.sourceRevision
    if (source.providerId !== "clockify") return yield* failure("conflict")

    const request = yield* Schema.decodeUnknownEffect(ProposePluginActionRequestV1)({
      actionKind: input.request._tag,
      target: {
        entityType: "time-entry",
        vendorImmutableId: source.vendorImmutableId
      },
      expectedRevision: input.request.expectedRevision,
      payload: input.request._tag === "correct-association"
        ? { jiraIssueKey: input.request.jiraIssueKey }
        : {
          decision: input.request.decision,
          rationale: input.request.rationale
        },
      evidenceIds: []
    }).pipe(Effect.mapError(() => failure("invalid-request")))
    const idempotencyKey = yield* clockifyActionSubmissionIdempotencyKey({
      entityId: input.entityId,
      request: input.request,
      workspaceId: input.workspaceId
    }).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      mapFailure
    )
    const runtime = yield* Effect.scoped(Effect.gen(function*() {
      if (connections.proposalContextEffect === undefined) return yield* failure("unavailable")
      const lease = yield* connections.proposalContextEffect({
        workspaceId: input.workspaceId,
        pluginConnectionId: source.pluginConnectionId
      }).pipe(mapFailure)
      const connection = Context.get(lease.context, PluginConnection)
      const connectionRecord = yield* persistence.pluginConnections.get(
        input.workspaceId,
        source.pluginConnectionId
      ).pipe(mapFailure)
      if (!connectionRecord.isEnabled || connectionRecord.providerId !== "clockify") {
        return yield* failure("conflict")
      }
      const capability = connection.descriptor.capabilities.find(
        ({ capabilityId }) => capabilityId === "action.execute"
      )
      if (capability === undefined) return yield* failure("conflict")
      return {
        capability,
        connectionRecord,
        descriptor: connection.descriptor.descriptor,
        runtimeAuthorityToken: lease.runtimeAuthorityToken
      }
    }))

    const cause = {
      _tag: "human",
      actor,
      sessionId: session.sessionId
    } satisfies GovernedActionTransitionCause
    const commitCurrent = <Success, Error, Requirements>(
      effect: Effect.Effect<Success, Error, Requirements>
    ) =>
      proposalAuthority.transactCurrent(
        {
          workspaceId: input.workspaceId,
          pluginConnectionId: source.pluginConnectionId,
          runtimeAuthorityToken: runtime.runtimeAuthorityToken
        },
        () => effect
      ).pipe(
        Effect.catchTag(
          "GovernedActionSubmissionUnavailable",
          () => Effect.fail(failure("conflict"))
        ),
        mapFailure
      )
    const prepareAuthorization = Effect.fn("ClockifyActionSubmissions.prepareAuthorization")(function*(
      envelope: GovernedActionEnvelopeV1,
      expectedHeadTransitionId: GovernedActionTransitionId
    ) {
      const authorizedAt = yield* DateTime.now
      const expiresAt = DateTime.min(
        DateTime.addDuration(authorizedAt, Duration.minutes(5)),
        DateTime.min(
          envelope.proposalExpiresAt,
          DateTime.min(session.idleExpiresAt, session.absoluteExpiresAt)
        )
      )
      if (DateTime.Order(authorizedAt, expiresAt) >= 0) return yield* failure("conflict")
      const authorizationId = GovernedActionAuthorizationId.make(yield* cryptoService.randomUUIDv7)
      const authorization = GovernedActionAuthorizationV1.make({
        schemaVersion: 1,
        authorizationId,
        actionId: envelope.actionId,
        workspaceId: input.workspaceId,
        pluginConnectionId: source.pluginConnectionId,
        pluginConnectionRevision: envelope.pluginConnectionRevision,
        pluginConnectionAuthorityDigest: envelope.pluginConnectionAuthorityDigest,
        actionEnvelopeDigest: envelope.envelopeDigest,
        idempotencyKey: envelope.idempotencyKey,
        payloadDigest: envelope.proposal.payloadDigest,
        evidenceSetDigest: envelope.evidenceSetDigest,
        policyDigest: envelope.policy.policyDigest,
        expectedRevision: envelope.proposal.request.expectedRevision,
        capabilityVersion: envelope.capability.version,
        actor,
        sessionId: session.sessionId,
        sessionPermission: session.permission,
        sessionExpiresAt: DateTime.min(session.idleExpiresAt, session.absoluteExpiresAt),
        requiredPermission: envelope.policy.requiredPermission,
        authorizedAt,
        expiresAt
      })
      const commit = GovernedActionCommitInput.make({
        envelope,
        expectedHeadTransitionId,
        transitionId: GovernedActionTransitionId.make(yield* cryptoService.randomUUIDv7),
        commandId: GovernedActionCommandId.make(`clockify:${envelope.actionId}:authorize`),
        command: { _tag: "authorize", authorizationId },
        cause,
        occurredAt: authorizedAt,
        causationId: null,
        correlationId: null,
        companion: { _tag: "authorization", authorization },
        auditEventId: DomainEventId.make(yield* cryptoService.randomUUIDv7)
      })
      return commit
    })
    const advance = Effect.fn("ClockifyActionSubmissions.advance")(function*(actionId: GovernedActionId) {
      yield* submission.advance({ workspaceId: input.workspaceId, actionId }).pipe(mapFailure)
      const record = yield* persistence.governedActions.read({
        workspaceId: input.workspaceId,
        actionId
      }).pipe(mapFailure)
      return { actionId, state: record.head.state }
    })
    const existingMatches = (record: GovernedActionRecord): boolean =>
      record.envelope.idempotencyKey === idempotencyKey &&
      record.envelope.targetEntityId === input.entityId &&
      record.envelope.proposal.request.actionKind === request.actionKind &&
      record.envelope.proposal.request.target.entityType === request.target.entityType &&
      record.envelope.proposal.request.target.vendorImmutableId === request.target.vendorImmutableId &&
      record.envelope.proposal.request.expectedRevision === request.expectedRevision &&
      clockifyActionRuntimeAuthorityMatches(
        record.envelope,
        runtime.connectionRecord.revision,
        runtime.runtimeAuthorityToken
      ) &&
      record.envelope.origin._tag === "human" &&
      record.envelope.origin.actor.personId === actor.personId
    const reuseExisting = Effect.fn("ClockifyActionSubmissions.reuseExisting")(function*(
      record: GovernedActionRecord
    ) {
      if (!existingMatches(record)) return yield* failure("conflict")
      if (record.head.state === "proposed") {
        yield* persistence.governedActions.commit(
          yield* prepareAuthorization(record.envelope, record.headTransition.transitionId)
        )
      } else if (!canAdvance(record.head.state)) {
        return {
          actionId: record.envelope.actionId,
          response: Option.some({
            actionId: record.envelope.actionId,
            state: record.head.state
          })
        }
      }
      return {
        actionId: record.envelope.actionId,
        response: Option.none<SubmitClockifyActionResponse>()
      }
    })
    const retry = yield* commitCurrent(
      persistence.governedActions.readByIdempotencyKey({
        workspaceId: input.workspaceId,
        pluginConnectionId: source.pluginConnectionId,
        idempotencyKey
      }).pipe(
        Effect.flatMap(reuseExisting),
        Effect.map(Option.some),
        Effect.catchTag("RecordNotFoundError", () => Effect.succeed(Option.none()))
      )
    )
    if (Option.isSome(retry)) {
      return Option.isSome(retry.value.response)
        ? retry.value.response.value
        : yield* advance(retry.value.actionId)
    }

    if (source.revision !== input.request.expectedRevision) return yield* failure("conflict")
    const providerProposal = yield* Effect.scoped(Effect.gen(function*() {
      if (connections.proposalContextEffect === undefined) return yield* failure("unavailable")
      const lease = yield* connections.proposalContextEffect({
        workspaceId: input.workspaceId,
        pluginConnectionId: source.pluginConnectionId
      }).pipe(mapFailure)
      if (lease.runtimeAuthorityToken !== runtime.runtimeAuthorityToken) {
        return yield* failure("conflict")
      }
      return yield* Context.get(lease.context, PluginConnection).proposeAction(request).pipe(mapFailure)
    }))
    const actionId = GovernedActionId.make(yield* cryptoService.randomUUIDv7)
    const proposalTransitionId = GovernedActionTransitionId.make(yield* cryptoService.randomUUIDv7)
    const evidence: GovernedActionEvidenceSet = []
    const evidenceSetDigest = yield* digestGovernedActionEvidenceSet(evidence).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService)
    )
    const policy = yield* policies.forPermission(
      input.request._tag === "correct-association"
        ? "workspace-owner"
        : "workspace-approver"
    ).pipe(mapFailure)
    const material = GovernedActionEnvelopeMaterialV1.make({
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      workspaceId: input.workspaceId,
      pluginConnectionId: source.pluginConnectionId,
      pluginConnectionRevision: GovernedActionPluginConnectionRevision.make(
        runtime.connectionRecord.revision
      ),
      pluginConnectionAuthorityDigest: GovernedActionPluginConnectionAuthorityDigest.make(
        runtime.runtimeAuthorityToken
      ),
      pluginId: runtime.descriptor.pluginId,
      pluginContractVersion: runtime.descriptor.contractVersion,
      pluginAdapterVersion: runtime.descriptor.adapterVersion,
      providerId: "clockify",
      capability: {
        capabilityId: "action.execute",
        version: runtime.capability.version
      },
      targetEntityId: input.entityId,
      proposal: providerProposal,
      evidence,
      evidenceSetDigest,
      policy,
      origin: { _tag: "human", actor, sessionId: session.sessionId },
      proposalExpiresAt: DateTime.addDuration(providerProposal.proposedAt, Duration.minutes(10)),
      causationId: null,
      correlationId: null
    })
    const envelope = (yield* makeGovernedActionEnvelope(material).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService)
    )).envelope
    const proposal = GovernedActionCommitInput.make({
      envelope,
      expectedHeadTransitionId: null,
      transitionId: proposalTransitionId,
      commandId: GovernedActionCommandId.make(`clockify:${actionId}:propose`),
      command: { _tag: "propose" },
      cause,
      occurredAt: providerProposal.proposedAt,
      causationId: null,
      correlationId: null,
      companion: { _tag: "none" },
      auditEventId: DomainEventId.make(yield* cryptoService.randomUUIDv7)
    })
    const committed = yield* commitCurrent(Effect.gen(function*() {
      const existing = yield* persistence.governedActions.readByIdempotencyKey({
        workspaceId: input.workspaceId,
        pluginConnectionId: source.pluginConnectionId,
        idempotencyKey
      }).pipe(
        Effect.map(Option.some),
        Effect.catchTag("RecordNotFoundError", () => Effect.succeed(Option.none()))
      )
      if (Option.isSome(existing)) {
        const record = existing.value
        if (!clockifyActionProposalMatches(record.envelope.proposal, providerProposal)) {
          return yield* failure("conflict")
        }
        return yield* reuseExisting(record)
      }

      yield* persistence.governedActions.commit(proposal)
      yield* persistence.governedActions.commit(
        yield* prepareAuthorization(envelope, proposalTransitionId)
      )
      return {
        actionId,
        response: Option.none<SubmitClockifyActionResponse>()
      }
    }))
    return Option.isSome(committed.response)
      ? committed.response.value
      : yield* advance(committed.actionId)
  })

  return ClockifyActionSubmissions.of({ submit: (input) => submit(input).pipe(mapFailure) })
})

/** Production governed Clockify action layer. */
export const clockifyActionSubmissionsLayer = Layer.effect(ClockifyActionSubmissions, makeService)

/** Fail-closed layer for deployments without governed execution. */
export const clockifyActionSubmissionsUnavailableLayer = Layer.succeed(
  ClockifyActionSubmissions,
  ClockifyActionSubmissions.of({ submit: () => Effect.fail(failure("unavailable")) })
)
