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
import { ProposePluginActionRequestV1 } from "../../domain/plugins/index.js"
import type { SessionSummary } from "../auth/models.js"
import { digestGovernedActionEvidenceSet, makeGovernedActionEnvelope } from "../governance/governedActionDigests.js"
import {
  GovernedActionPolicyBindingSource,
  GovernedActionProposalAuthority,
  GovernedActionSubmission
} from "../governance/GovernedActionSubmission.js"
import { Persistence } from "../persistence/Persistence.js"
import { GovernedActionCommitInput } from "../persistence/repositories/governedActionRepository.js"
import { PluginConnection } from "../plugins/PluginConnection.js"
import { PluginConnectionMap } from "../plugins/PluginConnectionMap.js"

/** Closed failure from the authenticated Clockify action product boundary. */
export class ClockifyActionSubmissionError extends Schema.TaggedErrorClass<ClockifyActionSubmissionError>()(
  "ClockifyActionSubmissionError",
  { reason: Schema.Literals(["conflict", "invalid-request", "unavailable"]) }
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

const mapFailure = Effect.catch((cause) =>
  Schema.is(ClockifyActionSubmissionError)(cause)
    ? Effect.fail(cause)
    : Effect.fail(failure("unavailable"))
)

const canAdvance = (state: string): boolean =>
  state === "authorized" ||
  state === "started" ||
  state === "unknown" ||
  state === "cancel-requested" ||
  state === "cancel-requested-unknown"

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
      DateTime.Order(checkedAt, input.session.absoluteExpiresAt) >= 0 ||
      (
        input.request._tag === "correct-association"
          ? input.session.permission !== "workspace-owner"
          : input.session.permission !== "workspace-owner" &&
            input.session.permission !== "workspace-approver"
      )
    ) return yield* failure("conflict")
    const session = input.session
    if (session.actor._tag !== "human") return yield* failure("conflict")
    const actor = session.actor

    const entity = yield* persistence.entities.get(input.workspaceId, input.entityId).pipe(mapFailure)
    const source = entity.sourceRevision
    if (
      source.providerId !== "clockify" ||
      source.revision !== input.request.expectedRevision
    ) return yield* failure("conflict")

    const prepared = yield* Effect.scoped(Effect.gen(function*() {
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
      const proposal = yield* connection.proposeAction(request).pipe(mapFailure)
      return {
        capability,
        connectionRecord,
        descriptor: connection.descriptor.descriptor,
        proposal,
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
          runtimeAuthorityToken: prepared.runtimeAuthorityToken
        },
        () => effect
      ).pipe(mapFailure)
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
      return GovernedActionCommitInput.make({
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
    })
    const advance = Effect.fn("ClockifyActionSubmissions.advance")(function*(actionId: GovernedActionId) {
      yield* submission.advance({ workspaceId: input.workspaceId, actionId }).pipe(mapFailure)
      const record = yield* persistence.governedActions.read({
        workspaceId: input.workspaceId,
        actionId
      }).pipe(mapFailure)
      return { actionId, state: record.head.state }
    })

    const idempotencyKey = GovernedActionIdempotencyKey.make(prepared.proposal.proposalKey)
    const existing = yield* persistence.governedActions.readByIdempotencyKey({
      workspaceId: input.workspaceId,
      pluginConnectionId: source.pluginConnectionId,
      idempotencyKey
    }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("RecordNotFoundError", () => Effect.succeed(Option.none())),
      mapFailure
    )
    if (Option.isSome(existing)) {
      const record = existing.value
      if (
        record.envelope.targetEntityId !== input.entityId ||
        !Equal.equals(record.envelope.proposal, prepared.proposal) ||
        record.envelope.origin._tag !== "human" ||
        record.envelope.origin.actor.personId !== actor.personId
      ) return yield* failure("conflict")
      if (record.head.state === "proposed") {
        yield* commitCurrent(
          persistence.governedActions.commit(
            yield* prepareAuthorization(record.envelope, record.headTransition.transitionId)
          )
        )
      } else if (!canAdvance(record.head.state)) {
        return { actionId: record.envelope.actionId, state: record.head.state }
      }
      return yield* advance(record.envelope.actionId)
    }

    const actionId = GovernedActionId.make(yield* cryptoService.randomUUIDv7)
    const proposalTransitionId = GovernedActionTransitionId.make(yield* cryptoService.randomUUIDv7)
    const evidence: GovernedActionEvidenceSet = []
    const evidenceSetDigest = yield* digestGovernedActionEvidenceSet(evidence).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService)
    )
    const policy = yield* policies.current.pipe(mapFailure)
    const material = GovernedActionEnvelopeMaterialV1.make({
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      workspaceId: input.workspaceId,
      pluginConnectionId: source.pluginConnectionId,
      pluginConnectionRevision: GovernedActionPluginConnectionRevision.make(
        prepared.connectionRecord.revision
      ),
      pluginConnectionAuthorityDigest: GovernedActionPluginConnectionAuthorityDigest.make(
        prepared.runtimeAuthorityToken
      ),
      pluginId: prepared.descriptor.pluginId,
      pluginContractVersion: prepared.descriptor.contractVersion,
      pluginAdapterVersion: prepared.descriptor.adapterVersion,
      providerId: "clockify",
      capability: {
        capabilityId: "action.execute",
        version: prepared.capability.version
      },
      targetEntityId: input.entityId,
      proposal: prepared.proposal,
      evidence,
      evidenceSetDigest,
      policy,
      origin: { _tag: "human", actor, sessionId: session.sessionId },
      proposalExpiresAt: DateTime.addDuration(prepared.proposal.proposedAt, Duration.minutes(10)),
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
      occurredAt: prepared.proposal.proposedAt,
      causationId: null,
      correlationId: null,
      companion: { _tag: "none" },
      auditEventId: DomainEventId.make(yield* cryptoService.randomUUIDv7)
    })
    const authorization = yield* prepareAuthorization(envelope, proposalTransitionId)
    yield* commitCurrent(Effect.gen(function*() {
      yield* persistence.governedActions.commit(proposal)
      yield* persistence.governedActions.commit(authorization)
    }))
    return yield* advance(actionId)
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
