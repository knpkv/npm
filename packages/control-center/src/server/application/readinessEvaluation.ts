/** Durable readiness evaluation outside provider synchronization transactions. @module */
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import type { ReleaseDeliveryGraphInspection } from "../../api/deliveryGraph.js"
import { DomainEventId, type ReleaseId, type WorkspaceId } from "../../domain/identifiers.js"
import {
  assessEnvironmentReadiness,
  type EnvironmentReadinessAssessment,
  EnvironmentReadinessCandidateMaterial,
  EnvironmentReadinessEvaluationInput,
  READINESS_DERIVATION_VERSION_V1,
  ReleaseReadinessCandidateMaterial,
  ReleaseReadinessRollupInput,
  rollUpReleaseReadiness
} from "../../domain/readiness/index.js"
import { Persistence } from "../persistence/Persistence.js"
import { DomainEventDedupeKey } from "../persistence/repositories/domainEventModels.js"
import { PluginStreamKey } from "../persistence/repositories/pluginRuntimeModels.js"
import {
  type ReadinessCommitLease,
  type ReadinessInvalidationRecord,
  ReadinessLeaseOwner
} from "../persistence/repositories/readinessRepository.js"
import { firstPartySyncStreamKey } from "../plugins/firstPartySynchronization.js"
import {
  digestEnvironmentReadinessCandidate,
  digestReadinessRule,
  digestReleaseReadinessCandidate
} from "../readinessDigests.js"
import { DomainEventWakeups } from "../runtime/DomainEventWakeups.js"
import { stableUuid } from "./internal/stableUuid.js"
import { assembleReadinessFacts, deliveryReadinessRule, ReadinessEvaluationFailure } from "./readinessFacts.js"
import { hydrateReleaseRunbookContent } from "./releaseRunbookHydration.js"
import { readReleaseTargetCatalog, releaseEnvironmentId } from "./releaseTargetConfiguration.js"

const leaseOf = (work: ReadinessInvalidationRecord | null): ReadinessCommitLease | null =>
  work?.lease === null || work === null ? null : {
    invalidationRevision: work.invalidationRevision,
    leaseOwner: work.lease.owner,
    leaseToken: work.lease.token
  }

/** Combine ordinary release facts and scoped repairs without hiding bounded evidence. */
const mergeInspection = (
  release: ReleaseDeliveryGraphInspection,
  environment: ReleaseDeliveryGraphInspection
): ReleaseDeliveryGraphInspection => {
  let truncated = release.truncated || environment.truncated
  const combine = <Entry>(entries: ReadonlyArray<Entry>, key: (entry: Entry) => string): ReadonlyArray<Entry> => {
    const unique = [...new Map(entries.map((entry) => [key(entry), entry])).values()]
    truncated ||= unique.length > 500
    return unique.slice(0, 500)
  }
  const nodes = combine([...release.nodes, ...environment.nodes], ({ nodeId }) => nodeId)
  const entityProjections = combine(
    [...release.entityProjections, ...environment.entityProjections],
    ({ projection }) => projection.entityId
  )
  const relationships = combine(
    [...release.relationships, ...environment.relationships],
    ({ relationshipId }) => relationshipId
  )
  const evidenceItems = combine(
    [...release.evidenceItems, ...environment.evidenceItems],
    ({ evidenceId }) => evidenceId
  )
  const evidenceClaims = combine(
    [...release.evidenceClaims, ...environment.evidenceClaims],
    ({ evidenceClaimId }) => evidenceClaimId
  )
  return { ...environment, truncated, nodes, entityProjections, relationships, evidenceItems, evidenceClaims }
}

const makeReadinessEvaluation = Effect.gen(function*() {
  const persistence = yield* Persistence
  const cryptoService = yield* Crypto.Crypto
  const wakeups = yield* DomainEventWakeups
  const leaseOwner = ReadinessLeaseOwner.make(yield* cryptoService.randomUUIDv7)
  const evaluateRelease = Effect.fn("ReadinessEvaluation.evaluateRelease")(
    function*(work: ReadinessInvalidationRecord) {
      const { releaseId, workspaceId } = work
      const now = yield* DateTime.now
      const failure = (operation: ReadinessEvaluationFailure["operation"]) =>
        new ReadinessEvaluationFailure({
          workspaceId,
          releaseId,
          operation,
          diagnosticCode: operation === "snapshot"
            ? "readiness-snapshot-invalid"
            : operation === "evidence"
            ? "readiness-evidence-invalid"
            : operation === "derive"
            ? "readiness-derivation-invalid"
            : "readiness-publication-failed"
        })
      const resolveFailure = Effect.fn("ReadinessEvaluation.resolveFailure")(function*() {
        const last = (yield* persistence.events.readLatestReadinessOutcomes(workspaceId, [releaseId]))[0]
        if (last?.payload.reason !== "readiness-failed") return false
        const eventId = DomainEventId.make(
          yield* stableUuid(
            cryptoService,
            `readiness-recovered:${workspaceId}:${last.eventId}`,
            () => failure("publish")
          )
        )
        yield* persistence.events.append(workspaceId, {
          dedupeKey: DomainEventDedupeKey.make(eventId),
          eventId,
          schemaVersion: 1,
          eventType: "portfolio-invalidated",
          occurredAt: now,
          causationId: last.eventId,
          correlationId: null,
          metadata: { releaseId },
          payload: { reason: "readiness-changed" }
        })
        return true
      })
      const newAssessmentId = () => cryptoService.randomUUIDv7.pipe(Effect.mapError(() => failure("derive")))
      const claim = (pending: ReadinessInvalidationRecord) =>
        persistence.readiness.claimInvalidation({
          ...pending,
          expectedInvalidationRevision: pending.invalidationRevision,
          leaseOwner,
          leaseExpiresAt: DateTime.add(now, { minutes: 5 })
        })
      return yield* persistence.transact(Effect.gen(function*() {
        let pending = yield* persistence.readiness.listPending({ workspaceId, releaseId, dueAt: now, limit: 100 })
        let releasePending = pending.find(({ _tag }) => _tag === "release")
        if (releasePending === undefined) {
          releasePending = yield* persistence.readiness.enqueueInvalidation({
            _tag: "release",
            workspaceId,
            releaseId,
            reason: "candidate-changed",
            enqueuedAt: now
          })
        }
        const release = yield* persistence.releases.get(workspaceId, releaseId)
        const settings = yield* persistence.workspaceSettings.get(workspaceId)
        const catalogue = yield* readReleaseTargetCatalog(persistence, workspaceId, settings.settings)
        const audits = yield* persistence.workspaceSettings.audits(workspaceId)
        const slice = yield* persistence.deliveryGraph.read(workspaceId, {
          _tag: "releaseSlice",
          releaseId,
          environmentId: null,
          limit: 500
        })
        if (slice._tag !== "releaseSlice") return yield* failure("snapshot")
        const sources = new Map(release.release.sourceRevisions.map((source) => [source.pluginConnectionId, source]))
        for (const { projection } of slice.value.entityProjections) {
          const entity = yield* persistence.entities.get(workspaceId, projection.entityId)
          sources.set(entity.sourceRevision.pluginConnectionId, entity.sourceRevision)
        }
        const syncing = yield* Effect.forEach(
          [...sources.values()],
          (source) =>
            persistence.pluginRuntime.getSyncAttemptState(
              workspaceId,
              source.pluginConnectionId,
              PluginStreamKey.make(firstPartySyncStreamKey(source.providerId))
            ).pipe(
              Effect.map(({ latestAttempt }) => latestAttempt?.outcome === null)
            )
        )
        // An unfinished provider snapshot leaves the old assessment pending, without claiming or changing facts.
        if (syncing.some(Boolean)) return null
        let releaseClaim = yield* claim(releasePending)
        if (releaseClaim === null) return null
        if (release.release.targetEnvironmentIds.length === 0) {
          const lease = leaseOf(releaseClaim)
          if (lease !== null) {
            yield* persistence.readiness.acknowledgeInvalidation({ _tag: "release", workspaceId, releaseId, ...lease })
          }
          for (
            const obsolete of pending.filter(({ _tag }) => _tag === "environment")
          ) {
            const leased = yield* claim(obsolete)
            const obsoleteLease = leaseOf(leased)
            if (obsoleteLease !== null) {
              yield* persistence.readiness.acknowledgeInvalidation({ ...obsolete, ...obsoleteLease })
            }
          }
          return yield* resolveFailure()
        }
        const mappings = settings.settings.pipeline.releaseTargets ?? []
        const keyed = yield* Effect.forEach(
          mappings.flatMap(({ environments }) => environments),
          (range) =>
            releaseEnvironmentId(workspaceId, range.key).pipe(
              Effect.map((environmentId) => ({ ...range, environmentId }))
            )
        )
        const ruleDigest = yield* digestReadinessRule(deliveryReadinessRule)
        yield* persistence.readiness.registerRule({
          workspaceId,
          material: deliveryReadinessRule,
          digest: ruleDigest,
          registeredAt: now
        })
        for (
          const obsolete of pending.filter((entry) =>
            entry._tag === "environment" && !release.release.targetEnvironmentIds.includes(entry.environmentId)
          )
        ) {
          const obsoleteLease = leaseOf(yield* claim(obsolete))
          if (obsoleteLease !== null) {
            yield* persistence.readiness.acknowledgeInvalidation({ ...obsolete, ...obsoleteLease })
          }
        }
        const environments: Array<EnvironmentReadinessAssessment> = []
        let changed = false
        for (const environmentId of [...release.release.targetEnvironmentIds].sort()) {
          const target = { _tag: "environment", workspaceId, releaseId, environmentId } satisfies {
            readonly _tag: "environment"
            readonly workspaceId: WorkspaceId
            readonly releaseId: ReleaseId
            readonly environmentId: typeof environmentId
          }
          const range = keyed.find((entry) => entry.environmentId === environmentId)
          const current = yield* persistence.readiness.readCurrent(target)
          if (current._tag !== "environment") {
            return yield* failure("snapshot")
          }
          const environmentPending = pending.find((entry) =>
            entry._tag === "environment" && entry.environmentId === environmentId
          )
          const environmentClaim = environmentPending === undefined ? null : yield* claim(environmentPending)
          if (environmentPending !== undefined && environmentClaim === null) return yield* failure("publish")
          const invalidation = leaseOf(environmentClaim)
          const environmentSlice = yield* persistence.deliveryGraph.read(workspaceId, {
            _tag: "releaseSlice",
            releaseId,
            environmentId,
            limit: 500
          })
          if (environmentSlice._tag !== "releaseSlice") return yield* failure("snapshot")
          const inspection = yield* hydrateReleaseRunbookContent(
            persistence,
            workspaceId,
            mergeInspection(slice.value, environmentSlice.value)
          )
          const facts = yield* assembleReadinessFacts({
            persistence,
            workspaceId,
            releaseId,
            inspection,
            settings,
            audits,
            catalogue,
            mappings,
            environmentKey: range?.key ?? "",
            evaluatedAt: now,
            previousObservations: current.record?.assessment.facts.flatMap(({ observation }) =>
              observation === null ? [] : [observation]
            ) ?? []
          })
          const material = yield* Schema.decodeUnknownEffect(Schema.toType(EnvironmentReadinessCandidateMaterial))({
            workspaceId,
            releaseRevision: release.revision,
            artifactRevision: facts.artifactRevision,
            scope: { _tag: "environment", releaseId, environmentId },
            complete: facts.complete,
            definitions: deliveryReadinessRule.definitions,
            observations: facts.observations
          })
          const digest = yield* digestEnvironmentReadinessCandidate(material)
          if (
            current.record !== null && current.record.assessment.candidate.digest === digest &&
            current.record.assessment.rule.digest === ruleDigest &&
            current.record.assessment.derivationVersion === READINESS_DERIVATION_VERSION_V1
          ) {
            if (
              invalidation !== null &&
              !(yield* persistence.readiness.acknowledgeInvalidation({ ...target, ...invalidation }))
            ) return yield* failure("publish")
            environments.push(current.record.assessment)
            continue
          }
          const input = yield* Schema.decodeUnknownEffect(Schema.toType(EnvironmentReadinessEvaluationInput))({
            assessmentId: yield* newAssessmentId(),
            previousAssessmentId: current.record?.assessment.assessmentId ?? null,
            candidate: {
              workspaceId,
              releaseRevision: material.releaseRevision,
              artifactRevision: material.artifactRevision,
              scope: material.scope,
              digest
            },
            rule: { ruleId: deliveryReadinessRule.ruleId, version: deliveryReadinessRule.version, digest: ruleDigest },
            derivationVersion: READINESS_DERIVATION_VERSION_V1,
            evaluatedAt: now,
            complete: material.complete,
            definitions: material.definitions,
            observations: material.observations
          })
          const committed = yield* persistence.readiness.commitEnvironment({
            expectedHeadRevision: current.record?.headRevision ?? null,
            invalidation,
            assessment: assessEnvironmentReadiness(input)
          })
          environments.push(committed.assessment)
          changed = true
        }
        // Environment publication advances the release invalidation. Reclaim its new revision inside this snapshot.
        if (changed) {
          pending = yield* persistence.readiness.listPending({ workspaceId, releaseId, dueAt: now, limit: 100 })
          const nextRelease = pending.find(({ _tag }) => _tag === "release")
          if (nextRelease === undefined) return yield* failure("publish")
          releaseClaim = yield* claim(nextRelease)
        }
        const releaseLease = leaseOf(releaseClaim)
        if (releaseLease === null) return yield* failure("publish")
        const target = { _tag: "release", workspaceId, releaseId } satisfies {
          readonly _tag: "release"
          readonly workspaceId: WorkspaceId
          readonly releaseId: ReleaseId
        }
        const current = yield* persistence.readiness.readCurrent(target)
        if (current._tag !== "release") return yield* failure("snapshot")
        const material = yield* Schema.decodeUnknownEffect(Schema.toType(ReleaseReadinessCandidateMaterial))({
          workspaceId,
          releaseRevision: release.revision,
          artifactRevision: environments[0]?.candidate.artifactRevision ?? "unresolved",
          scope: target,
          environments: environments.map((assessment) => ({
            assessmentId: assessment.assessmentId,
            environmentId: assessment.candidate.scope.environmentId,
            candidateDigest: assessment.candidate.digest
          }))
        })
        const digest = yield* digestReleaseReadinessCandidate(material)
        if (
          current.record?.assessment.candidate.digest === digest && current.record.assessment.rule.digest === ruleDigest
        ) {
          if (
            !(yield* persistence.readiness.acknowledgeInvalidation({ ...target, ...releaseLease }))
          ) return yield* failure("publish")
          const recovered = yield* resolveFailure()
          return changed || recovered
        }
        const input = yield* Schema.decodeUnknownEffect(Schema.toType(ReleaseReadinessRollupInput))({
          assessmentId: yield* newAssessmentId(),
          previousAssessmentId: current.record?.assessment.assessmentId ?? null,
          candidate: {
            workspaceId,
            releaseRevision: material.releaseRevision,
            artifactRevision: material.artifactRevision,
            scope: material.scope,
            digest
          },
          evaluatedAt: now,
          environments
        })
        yield* persistence.readiness.commitRelease({
          expectedHeadRevision: current.record?.headRevision ?? null,
          invalidation: releaseLease,
          assessment: rollUpReleaseReadiness(input)
        })
        const eventId = DomainEventId.make(
          yield* stableUuid(
            cryptoService,
            `readiness-changed:${workspaceId}:${input.assessmentId}`,
            () => failure("publish")
          )
        )
        yield* persistence.events.append(workspaceId, {
          dedupeKey: DomainEventDedupeKey.make(eventId),
          eventId,
          schemaVersion: 1,
          eventType: "portfolio-invalidated",
          occurredAt: now,
          causationId: null,
          correlationId: null,
          metadata: { releaseId },
          payload: { reason: "readiness-changed" }
        })
        return true
      })).pipe(Effect.mapError((error) =>
        error._tag === "ReadinessEvaluationFailure"
          ? error
          : failure(error._tag === "ReadinessDigestError" ? "derive" : "publish")
      ))
    }
  )

  const runOnce = Effect.fn("ReadinessEvaluation.runOnce")(function*(workspaceId: WorkspaceId) {
    const now = yield* DateTime.now
    yield* persistence.readiness.enqueueDue({ workspaceId, dueAt: now, limit: 100 })
    const work = (yield* persistence.readiness.listPending({ workspaceId, dueAt: now, limit: 1 }))[0]
    if (work === undefined) return { _tag: "idle" }
    const outcome = yield* evaluateRelease(work).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.result
    )
    if (Result.isSuccess(outcome)) {
      if (outcome.success === null) return { _tag: "idle" }
      yield* wakeups.notify(work.workspaceId)
      return { _tag: "evaluated", releaseId: work.releaseId }
    }
    const retryAt = DateTime.add(now, { seconds: 30 })
    const failure = outcome.failure
    const eventId = DomainEventId.make(
      yield* stableUuid(
        cryptoService,
        `readiness-failed:${workspaceId}:${work.releaseId}:${work._tag}:${
          work._tag === "environment" ? work.environmentId : ""
        }:${DateTime.toEpochMillis(work.enqueuedAt)}:${work.invalidationRevision}:${failure.diagnosticCode}`,
        () => failure
      )
    )
    yield* persistence.transact(Effect.gen(function*() {
      const claimed = yield* persistence.readiness.claimInvalidation({
        ...work,
        expectedInvalidationRevision: work.invalidationRevision,
        leaseOwner,
        leaseExpiresAt: DateTime.add(now, { minutes: 5 })
      })
      const lease = leaseOf(claimed)
      if (lease === null) return
      const last = (yield* persistence.events.readLatestReadinessOutcomes(workspaceId, [work.releaseId]))[0]
      if (last?.eventId !== eventId) {
        yield* persistence.events.append(workspaceId, {
          dedupeKey: DomainEventDedupeKey.make(eventId),
          eventId,
          schemaVersion: 1,
          eventType: "portfolio-invalidated",
          occurredAt: now,
          causationId: null,
          correlationId: null,
          metadata: { releaseId: work.releaseId },
          payload: {
            reason: "readiness-failed",
            readinessFailure: {
              operation: failure.operation,
              diagnosticCode: failure.diagnosticCode,
              invalidationRevision: work.invalidationRevision,
              retryAt
            }
          }
        })
      }
      const pending = yield* persistence.readiness.listPending({
        workspaceId,
        releaseId: work.releaseId,
        dueAt: now,
        limit: 100
      })
      for (const entry of pending) {
        const other = yield* persistence.readiness.claimInvalidation({
          ...entry,
          expectedInvalidationRevision: entry.invalidationRevision,
          leaseOwner,
          leaseExpiresAt: DateTime.add(now, { minutes: 5 })
        })
        const otherLease = leaseOf(other)
        if (otherLease !== null) {
          yield* persistence.readiness.deferInvalidation({ target: { ...entry, ...otherLease }, availableAt: retryAt })
        }
      }
      yield* persistence.readiness.deferInvalidation({ target: { ...work, ...lease }, availableAt: retryAt })
    }))
    yield* wakeups.notify(work.workspaceId)
    yield* Effect.logError("Readiness evaluation failed", failure)
    return { _tag: "failed", releaseId: work.releaseId }
  })
  return { runOnce }
})

/** One supervised consumer of readiness work, shared by sync, settings, repair and expiry triggers. */
export class ReadinessEvaluation
  extends Context.Service<ReadinessEvaluation, Effect.Success<typeof makeReadinessEvaluation>>()(
    "@knpkv/control-center/ReadinessEvaluation"
  )
{
  static readonly layer = Layer.effect(ReadinessEvaluation, makeReadinessEvaluation)
}
