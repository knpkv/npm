import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Result, Schema, Tracer } from "effect"
import type * as Crypto from "effect/Crypto"
import * as TestClock from "effect/testing/TestClock"

import { EvidenceId, ReadinessAssessmentId, WorkspaceId } from "../../src/domain/identifiers.js"
import {
  assessEnvironmentReadiness,
  type EnvironmentReadinessAssessment,
  EnvironmentReadinessCandidateMaterial,
  EnvironmentReadinessEvaluationInput,
  ReadinessFactObservation,
  ReadinessRuleMaterial,
  ReleaseReadinessCandidateMaterial,
  ReleaseReadinessRollupInput,
  rollUpReleaseReadiness
} from "../../src/domain/readiness/index.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { PersistedRecordError } from "../../src/server/persistence/errors.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { ReadinessInputError } from "../../src/server/persistence/repositories/readiness/contract.js"
import { groupReadinessMaterialization } from "../../src/server/persistence/repositories/readiness/materialization.js"
import { ReadinessRepository } from "../../src/server/persistence/repositories/readinessRepository.js"
import {
  digestEnvironmentReadinessCandidate,
  digestReadinessRule,
  digestReleaseReadinessCandidate
} from "../../src/server/readinessDigests.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const workspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-400000000001")
const releaseId = "01890f6f-6d6a-7cc0-98d2-400000000002"
const environmentId = "01890f6f-6d6a-7cc0-98d2-400000000003"
const otherEnvironmentId = "01890f6f-6d6a-7cc0-98d2-400000000011"
const evidenceId = "01890f6f-6d6a-7cc0-98d2-400000000004"
const firstAssessmentId = "01890f6f-6d6a-7cc0-98d2-400000000005"
const secondAssessmentId = "01890f6f-6d6a-7cc0-98d2-400000000006"
const staleReleaseAssessmentId = "01890f6f-6d6a-7cc0-98d2-400000000007"
const currentReleaseAssessmentId = "01890f6f-6d6a-7cc0-98d2-400000000008"
const thirdAssessmentId = "01890f6f-6d6a-7cc0-98d2-400000000009"
const pendingReleaseAssessmentId = "01890f6f-6d6a-7cc0-98d2-400000000010"
const firstAt = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
const secondAt = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:10:00.000Z")
const thirdAt = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:20:00.000Z")
const fourthAt = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:30:00.000Z")
const leaseExpiresAt = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:05:00.000Z")

const definitions = Schema.decodeSync(ReadinessRuleMaterial)({
  ruleId: "delivery-v1",
  version: 1,
  definitions: [
    { factId: "build.main", kind: "execution", requirement: "required" },
    { factId: "approval.release", kind: "approval", requirement: "required" },
    { factId: "deploy.target", kind: "deployment", requirement: "advisory" }
  ]
})

const observations = Schema.decodeSync(Schema.Array(ReadinessFactObservation))([
  {
    factId: "deploy.target",
    state: { _tag: "deployment", status: "not-started", progress: null },
    evidence: [
      {
        evidenceId,
        source: { _tag: "local", origin: "system" },
        freshness: "current",
        validity: "valid",
        reevaluateAt: "2026-07-15T11:00:00.000Z"
      }
    ]
  }
])

const readyObservations = Schema.decodeSync(Schema.Array(ReadinessFactObservation))([
  {
    factId: "approval.release",
    state: { _tag: "approval", status: "approved" },
    evidence: [{
      evidenceId,
      source: { _tag: "local", origin: "system" },
      freshness: "current",
      validity: "valid",
      reevaluateAt: null
    }]
  },
  {
    factId: "build.main",
    state: { _tag: "execution", status: "succeeded", progress: null },
    evidence: [{
      evidenceId,
      source: { _tag: "local", origin: "system" },
      freshness: "current",
      validity: "valid",
      reevaluateAt: null
    }]
  },
  {
    factId: "deploy.target",
    state: { _tag: "deployment", status: "not-started", progress: null },
    evidence: [{
      evidenceId,
      source: { _tag: "local", origin: "system" },
      freshness: "current",
      validity: "valid",
      reevaluateAt: "2026-07-15T11:00:00.000Z"
    }]
  }
])

const withReadiness = <Success, Failure>(
  use: Effect.Effect<
    Success,
    Failure,
    Crypto.Crypto | Database | QuarantineRepository | ReadinessRepository
  >
) =>
  Effect.gen(function*() {
    yield* TestClock.setTime(DateTime.toEpochMillis(firstAt))
    const config = yield* makePersistenceTestConfig("control-center-readiness-repository-")
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const readiness = ReadinessRepository.layer.pipe(Layer.provide(foundation))
    return yield* use.pipe(Effect.provide(Layer.merge(foundation, readiness)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const seedFoundations = Effect.gen(function*() {
  const { sql } = yield* Database
  const at = "2026-07-15T10:00:00.000Z"
  yield* sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES (${workspaceId}, 'Readiness', 1, ${at}, ${at})`
  yield* sql`INSERT INTO releases (
    workspace_id, release_id, current_revision, created_at, updated_at
  ) VALUES (${workspaceId}, ${releaseId}, 1, ${at}, ${at})`
  yield* sql`INSERT INTO release_revisions (
    workspace_id, release_id, revision, snapshot_json, snapshot_digest, created_at
  ) VALUES (${workspaceId}, ${releaseId}, 1, '{}', ${"0".repeat(64)}, ${at})`
  yield* sql`INSERT INTO release_targets (
    workspace_id, release_id, environment_id, created_at
  ) VALUES (${workspaceId}, ${releaseId}, ${environmentId}, ${at})`
  yield* sql`INSERT INTO evidence_items (
    workspace_id, evidence_id, schema_version, evidence_digest, origin_kind,
    plugin_connection_id, source_entity_id, source_entity_revision,
    person_id, agent_id, system_component, verifier_kind,
    verifier_person_id, verifier_agent_id, verifier_component,
    observed_at, recorded_at, valid_until, freshness_json, freshness_digest,
    retention_class, retain_until, legal_hold
  ) VALUES (
    ${workspaceId}, ${evidenceId}, 1, ${"a".repeat(64)}, 'system',
    NULL, NULL, NULL, NULL, NULL, 'readiness-test', 'system',
    NULL, NULL, 'readiness-test', ${at}, ${at}, NULL,
    '{"_tag":"unavailable"}', ${"b".repeat(64)}, 'evidence', NULL, 0
  )`
})

const makeAssessment = Effect.fn("ReadinessRepositoryTest.makeAssessment")(function*(input: {
  readonly assessmentId: string
  readonly previousAssessmentId: string | null
  readonly evaluatedAt: string
  readonly observations?: typeof observations
}) {
  const selectedObservations = input.observations ?? observations
  const material = yield* Schema.decodeUnknownEffect(Schema.toType(EnvironmentReadinessCandidateMaterial))({
    workspaceId,
    releaseRevision: 1,
    artifactRevision: "git:abc123",
    scope: { _tag: "environment", releaseId, environmentId },
    complete: true,
    definitions: definitions.definitions,
    observations: selectedObservations
  })
  const digest = yield* digestEnvironmentReadinessCandidate(material)
  const evaluation = yield* Schema.decodeUnknownEffect(Schema.toType(EnvironmentReadinessEvaluationInput))({
    assessmentId: input.assessmentId,
    previousAssessmentId: input.previousAssessmentId,
    candidate: {
      workspaceId,
      releaseRevision: 1,
      artifactRevision: "git:abc123",
      digest,
      scope: { _tag: "environment", releaseId, environmentId }
    },
    rule: {
      ruleId: definitions.ruleId,
      version: definitions.version,
      digest: yield* digestReadinessRule(definitions)
    },
    derivationVersion: 1,
    evaluatedAt: Schema.decodeSync(UtcTimestamp)(input.evaluatedAt),
    complete: true,
    definitions: definitions.definitions,
    observations: selectedObservations
  })
  return assessEnvironmentReadiness(evaluation)
})

const makeReleaseAssessment = Effect.fn("ReadinessRepositoryTest.makeReleaseAssessment")(function*(input: {
  readonly assessmentId: string
  readonly environment: EnvironmentReadinessAssessment
  readonly previousAssessmentId?: string | null
}) {
  const material = yield* Schema.decodeUnknownEffect(Schema.toType(ReleaseReadinessCandidateMaterial))({
    workspaceId,
    releaseRevision: 1,
    artifactRevision: "git:abc123",
    scope: { _tag: "release", releaseId },
    environments: [{
      assessmentId: input.environment.assessmentId,
      environmentId,
      candidateDigest: input.environment.candidate.digest
    }]
  })
  const candidateDigest = yield* digestReleaseReadinessCandidate(material)
  const rollup = yield* Schema.decodeUnknownEffect(Schema.toType(ReleaseReadinessRollupInput))({
    assessmentId: input.assessmentId,
    previousAssessmentId: input.previousAssessmentId ?? null,
    candidate: {
      workspaceId,
      releaseRevision: 1,
      artifactRevision: "git:abc123",
      digest: candidateDigest,
      scope: { _tag: "release", releaseId }
    },
    evaluatedAt: secondAt,
    environments: [input.environment]
  })
  return rollUpReleaseReadiness(rollup)
})

describe("readiness repository", () => {
  it("indexes each materialized dependency by assessment", () => {
    const evidence = Array.from({ length: 200 }, (_, index) => {
      const suffix = (index + 100).toString(16).padStart(12, "0")
      return {
        assessmentId: Schema.decodeSync(ReadinessAssessmentId)(`01890f6f-6d6a-7cc0-98d2-${suffix}`),
        evidenceId: Schema.decodeSync(EvidenceId)(`01890f6f-6d6a-7cc0-98d3-${suffix}`)
      }
    })
    const grouped = groupReadinessMaterialization({ evidence, sources: [], children: [] })
    assert.strictEqual(grouped.evidence.size, 200)
    for (const row of evidence) assert.deepStrictEqual(grouped.evidence.get(row.assessmentId), [row])
  })

  it.effect("registers one immutable rule across concurrent repository instances", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(firstAt))
      const config = yield* makePersistenceTestConfig("control-center-readiness-rule-race-")
      const makeLayer = () => {
        const database = databaseLayer(config)
        const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
        const readiness = ReadinessRepository.layer.pipe(Layer.provide(foundation))
        return Layer.merge(foundation, readiness)
      }
      const firstLayer = makeLayer()
      const secondLayer = makeLayer()
      yield* seedFoundations.pipe(Effect.provide(firstLayer))
      const digest = yield* digestReadinessRule(definitions)
      const register = Effect.gen(function*() {
        const readiness = yield* ReadinessRepository
        return yield* readiness.registerRule({
          workspaceId,
          material: definitions,
          digest,
          registeredAt: firstAt
        })
      })
      const results = yield* Effect.all(
        [register.pipe(Effect.provide(firstLayer)), register.pipe(Effect.provide(secondLayer))],
        { concurrency: "unbounded" }
      )
      assert.deepEqual(results.map(({ _tag }) => _tag).sort(), ["created", "existing"])
      const stored = yield* Effect.gen(function*() {
        const { sql } = yield* Database
        return yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM readiness_rule_snapshots
          WHERE workspace_id = ${workspaceId} AND rule_id = ${definitions.ruleId}
            AND rule_version = ${definitions.version}`
      }).pipe(Effect.provide(firstLayer))
      assert.strictEqual(stored[0]?.count, 1)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("records commit time from the repository clock and rejects future evaluations", () =>
    withReadiness(
      Effect.gen(function*() {
        const readiness = yield* ReadinessRepository
        const { sql } = yield* Database
        yield* seedFoundations
        const digest = yield* digestReadinessRule(definitions)
        yield* readiness.registerRule({ workspaceId, material: definitions, digest, registeredAt: firstAt })
        const future = yield* makeAssessment({
          assessmentId: secondAssessmentId,
          previousAssessmentId: null,
          evaluatedAt: "2100-01-01T00:00:00.000Z"
        })
        const rejected = yield* readiness.commitEnvironment({
          expectedHeadRevision: null,
          invalidation: null,
          assessment: future
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(rejected))
        if (Result.isFailure(rejected)) {
          assert.instanceOf(rejected.failure, ReadinessInputError)
          assert.strictEqual(rejected.failure.reason, "invalid-request")
        }
        const leaked = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM readiness_assessments WHERE assessment_id = ${secondAssessmentId}`
        assert.strictEqual(leaked[0]?.count, 0)

        const current = yield* makeAssessment({
          assessmentId: firstAssessmentId,
          previousAssessmentId: null,
          evaluatedAt: "2026-07-15T10:00:00.000Z"
        })
        const committed = yield* readiness.commitEnvironment({
          expectedHeadRevision: null,
          invalidation: null,
          assessment: current
        })
        assert.strictEqual(DateTime.toEpochMillis(committed.committedAt), DateTime.toEpochMillis(firstAt))
      })
    ))

  it.effect("recomputes canonical material and retains truthful current/history records", () =>
    withReadiness(
      Effect.gen(function*() {
        const readiness = yield* ReadinessRepository
        yield* seedFoundations
        const ruleDigest = yield* digestReadinessRule(definitions)
        const registered = yield* readiness.registerRule({
          workspaceId,
          material: definitions,
          digest: ruleDigest,
          registeredAt: firstAt
        })
        assert.strictEqual(registered._tag, "created")
        assert.strictEqual((yield* readiness.registerRule(registered.record))._tag, "existing")

        const first = yield* makeAssessment({
          assessmentId: firstAssessmentId,
          previousAssessmentId: null,
          evaluatedAt: "2026-07-15T10:00:00.000Z"
        })
        const tampered = yield* readiness
          .commitEnvironment({
            expectedHeadRevision: null,
            invalidation: null,
            assessment: {
              ...first,
              candidate: { ...first.candidate, digest: `sha256:${"f".repeat(64)}` }
            }
          })
          .pipe(Effect.result)
        assert.isTrue(Result.isFailure(tampered))
        if (Result.isFailure(tampered)) {
          assert.instanceOf(tampered.failure, ReadinessInputError)
          assert.strictEqual(tampered.failure.reason, "candidate-digest-mismatch")
        }

        yield* readiness.commitEnvironment({
          expectedHeadRevision: null,
          invalidation: null,
          assessment: first
        })
        const second = yield* makeAssessment({
          assessmentId: secondAssessmentId,
          previousAssessmentId: firstAssessmentId,
          evaluatedAt: "2026-07-15T10:10:00.000Z",
          observations: readyObservations
        })
        yield* TestClock.setTime(DateTime.toEpochMillis(secondAt))
        yield* readiness.commitEnvironment({
          expectedHeadRevision: 1,
          invalidation: null,
          assessment: second
        })

        const releaseClaim = yield* readiness.claimInvalidation({
          _tag: "release",
          workspaceId,
          releaseId,
          expectedInvalidationRevision: 2,
          leaseOwner: "release-worker",
          leaseExpiresAt: Schema.decodeSync(UtcTimestamp)("2026-07-15T10:20:00.000Z")
        })
        assert.strictEqual(releaseClaim?.invalidationRevision, 2)
        const releaseInvalidation = {
          invalidationRevision: 2,
          leaseOwner: "release-worker",
          leaseToken: releaseClaim?.lease?.token
        }

        const staleSummaryRelease = yield* makeReleaseAssessment({
          assessmentId: staleReleaseAssessmentId,
          environment: first
        })
        const exactRelease = yield* makeReleaseAssessment({
          assessmentId: currentReleaseAssessmentId,
          environment: second
        })
        const [staleSummary] = staleSummaryRelease.environments
        const fabricatedRelease = {
          ...staleSummaryRelease,
          candidate: exactRelease.candidate,
          environments: [{
            ...staleSummary,
            assessmentId: second.assessmentId,
            candidateDigest: second.candidate.digest
          }]
        }
        const staleReleaseCommit = yield* readiness.commitRelease({
          expectedHeadRevision: null,
          invalidation: releaseInvalidation,
          assessment: fabricatedRelease
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(staleReleaseCommit))
        if (Result.isFailure(staleReleaseCommit)) {
          assert.instanceOf(staleReleaseCommit.failure, ReadinessInputError)
          assert.strictEqual(staleReleaseCommit.failure.reason, "invalid-request")
        }
        const { sql } = yield* Database
        const leakedRelease = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM readiness_assessments WHERE assessment_id = ${staleReleaseAssessmentId}`
        assert.strictEqual(leakedRelease[0]?.count, 0)

        yield* readiness.commitRelease({
          expectedHeadRevision: null,
          invalidation: releaseInvalidation,
          assessment: exactRelease
        })

        const current = yield* readiness.readCurrent({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId
        })
        assert.strictEqual(current.record?.headRevision, 2)
        assert.strictEqual(current.record?.assessment.assessmentId, secondAssessmentId)
        assert.strictEqual(current.record?.authority, "authoritative")
        const currentRelease = yield* readiness.readCurrent({
          _tag: "release",
          workspaceId,
          releaseId
        })
        assert.strictEqual(currentRelease.record?.assessment.assessmentId, currentReleaseAssessmentId)
        assert.strictEqual(currentRelease.record?.authority, "authoritative")

        const history = yield* readiness.readHistory({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          beforeHeadRevision: null,
          limit: 10
        })
        assert.deepEqual(
          history.records.map(({ headRevision }) => headRevision),
          [2, 1]
        )
        assert.deepEqual(
          history.records.map(({ assessment }) => assessment.assessmentId),
          [secondAssessmentId, firstAssessmentId]
        )

        const affected = yield* readiness.enqueueAffected({
          _tag: "evidence",
          workspaceId,
          evidenceId,
          enqueuedAt: secondAt
        })
        assert.deepEqual(affected, { environments: 1, releases: 1 })
        const pendingEnvironment = yield* readiness.readCurrent({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId
        })
        const pendingRelease = yield* readiness.readCurrent({ _tag: "release", workspaceId, releaseId })
        assert.strictEqual(pendingEnvironment.record?.authority, "pending")
        assert.strictEqual(pendingRelease.record?.authority, "pending")
        const prematureRelease = yield* makeReleaseAssessment({
          assessmentId: pendingReleaseAssessmentId,
          environment: second,
          previousAssessmentId: currentReleaseAssessmentId
        })
        const prematureCommit = yield* readiness.commitRelease({
          expectedHeadRevision: 1,
          invalidation: null,
          assessment: prematureRelease
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(prematureCommit))
        if (Result.isFailure(prematureCommit)) {
          assert.instanceOf(prematureCommit.failure, ReadinessInputError)
          assert.strictEqual(prematureCommit.failure.reason, "stale-invalidation")
        }
        const unrelated = yield* readiness.enqueueAffected({
          _tag: "evidence",
          workspaceId,
          evidenceId: "01890f6f-6d6a-7cc0-98d2-400000000099",
          enqueuedAt: secondAt
        })
        assert.deepEqual(unrelated, { environments: 0, releases: 0 })

        const due = yield* readiness.enqueueDue({
          workspaceId,
          dueAt: Schema.decodeSync(UtcTimestamp)("2026-07-15T11:00:00.000Z"),
          limit: 10
        })
        assert.deepEqual(due, { enqueued: 1 })
      })
    ))

  it.effect("leases only the exact revision and treats expiry as exclusive", () =>
    withReadiness(
      Effect.gen(function*() {
        const readiness = yield* ReadinessRepository
        yield* seedFoundations
        const first = yield* readiness.enqueueInvalidation({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          reason: "candidate-changed",
          enqueuedAt: firstAt
        })
        assert.strictEqual(first.invalidationRevision, 1)
        const excessiveLease = yield* readiness.claimInvalidation({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          expectedInvalidationRevision: 1,
          leaseOwner: "worker-too-long",
          leaseExpiresAt: Schema.decodeSync(UtcTimestamp)("2100-01-01T00:00:00.000Z")
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(excessiveLease))
        if (Result.isFailure(excessiveLease)) {
          assert.instanceOf(excessiveLease.failure, ReadinessInputError)
          assert.strictEqual(excessiveLease.failure.reason, "invalid-request")
        }
        const firstClaim = yield* readiness.claimInvalidation({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          expectedInvalidationRevision: 1,
          leaseOwner: "worker-a",
          leaseExpiresAt
        })
        assert.strictEqual(firstClaim?.lease?.owner, "worker-a")
        const earlyTakeover = yield* readiness.claimInvalidation({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          expectedInvalidationRevision: 1,
          leaseOwner: "worker-too-early",
          leaseExpiresAt: secondAt
        })
        assert.isNull(earlyTakeover)
        yield* TestClock.setTime(DateTime.toEpochMillis(leaseExpiresAt))
        const takeover = yield* readiness.claimInvalidation({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          expectedInvalidationRevision: 1,
          leaseOwner: "worker-at-expiry",
          leaseExpiresAt: secondAt
        })
        assert.strictEqual(takeover?.lease?.owner, "worker-at-expiry")

        const second = yield* readiness.enqueueInvalidation({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          reason: "evidence-changed",
          enqueuedAt: secondAt
        })
        assert.strictEqual(second.invalidationRevision, 2)
        yield* TestClock.setTime(DateTime.toEpochMillis(secondAt))
        const staleClaim = yield* readiness.claimInvalidation({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          expectedInvalidationRevision: 1,
          leaseOwner: "worker-a",
          leaseExpiresAt: thirdAt
        })
        assert.isNull(staleClaim)

        const secondClaim = yield* readiness.claimInvalidation({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          expectedInvalidationRevision: 2,
          leaseOwner: "worker-b",
          leaseExpiresAt: Schema.decodeSync(UtcTimestamp)("2026-07-15T10:20:00.000Z")
        })
        assert.strictEqual(secondClaim?.invalidationRevision, 2)
      })
    ))

  it.effect("publishes only from the exact live invalidation lease", () =>
    withReadiness(
      Effect.gen(function*() {
        const readiness = yield* ReadinessRepository
        yield* seedFoundations
        const digest = yield* digestReadinessRule(definitions)
        yield* readiness.registerRule({
          workspaceId,
          material: definitions,
          digest,
          registeredAt: firstAt
        })
        const first = yield* makeAssessment({
          assessmentId: firstAssessmentId,
          previousAssessmentId: null,
          evaluatedAt: "2026-07-15T10:00:00.000Z"
        })
        yield* readiness.commitEnvironment({
          expectedHeadRevision: null,
          invalidation: null,
          assessment: first
        })
        yield* readiness.enqueueInvalidation({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          reason: "candidate-changed",
          enqueuedAt: firstAt
        })
        const staleClaim = yield* readiness.claimInvalidation({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          expectedInvalidationRevision: 1,
          leaseOwner: "stale-worker",
          leaseExpiresAt
        })
        const second = yield* makeAssessment({
          assessmentId: secondAssessmentId,
          previousAssessmentId: firstAssessmentId,
          evaluatedAt: "2026-07-15T10:05:00.000Z",
          observations: readyObservations
        })
        yield* TestClock.setTime(DateTime.toEpochMillis(leaseExpiresAt))
        const replacementClaim = yield* readiness.claimInvalidation({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          expectedInvalidationRevision: 1,
          leaseOwner: "stale-worker",
          leaseExpiresAt: thirdAt
        })
        assert.notStrictEqual(replacementClaim?.lease?.token, staleClaim?.lease?.token)
        const fenced = yield* readiness.commitEnvironment({
          expectedHeadRevision: 1,
          invalidation: {
            invalidationRevision: 1,
            leaseOwner: "stale-worker",
            leaseToken: staleClaim?.lease?.token
          },
          assessment: second
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(fenced))
        yield* TestClock.setTime(DateTime.toEpochMillis(thirdAt))
        const expired = yield* readiness.commitEnvironment({
          expectedHeadRevision: 1,
          invalidation: {
            invalidationRevision: 1,
            leaseOwner: "stale-worker",
            leaseToken: replacementClaim?.lease?.token
          },
          assessment: second
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(expired))
        if (Result.isFailure(expired)) {
          assert.instanceOf(expired.failure, ReadinessInputError)
          assert.strictEqual(expired.failure.reason, "stale-invalidation")
        }
        yield* readiness.enqueueInvalidation({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          reason: "evidence-changed",
          enqueuedAt: thirdAt
        })
        const stillFirst = yield* readiness.readCurrent({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId
        })
        assert.strictEqual(stillFirst.record?.assessment.assessmentId, firstAssessmentId)
        assert.strictEqual(stillFirst.record?.authority, "pending")
        const historyBeforeRetry = yield* readiness.readHistory({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          beforeHeadRevision: null,
          limit: 10
        })
        assert.lengthOf(historyBeforeRetry.records, 1)

        const currentClaim = yield* readiness.claimInvalidation({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          expectedInvalidationRevision: 2,
          leaseOwner: "current-worker",
          leaseExpiresAt: fourthAt
        })
        yield* readiness.commitEnvironment({
          expectedHeadRevision: 1,
          invalidation: {
            invalidationRevision: 2,
            leaseOwner: "current-worker",
            leaseToken: currentClaim?.lease?.token
          },
          assessment: second
        })
        const current = yield* readiness.readCurrent({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId
        })
        assert.strictEqual(current.record?.assessment.assessmentId, secondAssessmentId)
        assert.strictEqual(current.record?.authority, "authoritative")
      })
    ))

  it.effect("returns an exclusive history cursor only when another revision exists", () =>
    withReadiness(
      Effect.gen(function*() {
        const readiness = yield* ReadinessRepository
        yield* seedFoundations
        const digest = yield* digestReadinessRule(definitions)
        yield* readiness.registerRule({
          workspaceId,
          material: definitions,
          digest,
          registeredAt: firstAt
        })
        const first = yield* makeAssessment({
          assessmentId: firstAssessmentId,
          previousAssessmentId: null,
          evaluatedAt: "2026-07-15T10:00:00.000Z"
        })
        const second = yield* makeAssessment({
          assessmentId: secondAssessmentId,
          previousAssessmentId: firstAssessmentId,
          evaluatedAt: "2026-07-15T10:10:00.000Z"
        })
        const third = yield* makeAssessment({
          assessmentId: thirdAssessmentId,
          previousAssessmentId: secondAssessmentId,
          evaluatedAt: "2026-07-15T10:20:00.000Z"
        })
        yield* readiness.commitEnvironment({
          expectedHeadRevision: null,
          invalidation: null,
          assessment: first
        })
        yield* TestClock.setTime(DateTime.toEpochMillis(secondAt))
        yield* readiness.commitEnvironment({
          expectedHeadRevision: 1,
          invalidation: null,
          assessment: second
        })
        yield* TestClock.setTime(DateTime.toEpochMillis(thirdAt))
        yield* readiness.commitEnvironment({
          expectedHeadRevision: 2,
          invalidation: null,
          assessment: third
        })
        let historyQueryCount = 0
        const queryTracer = Tracer.make({
          span: (options) => {
            if (options.name === "sql.execute") historyQueryCount += 1
            return new Tracer.NativeSpan(options)
          }
        })
        const completeHistory = yield* readiness.readHistory({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          beforeHeadRevision: null,
          limit: 3
        }).pipe(Effect.provideService(Tracer.Tracer, queryTracer))
        assert.lengthOf(completeHistory.records, 3)
        assert.strictEqual(historyQueryCount, 4)

        const firstPage = yield* readiness.readHistory({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          beforeHeadRevision: null,
          limit: 2
        })
        assert.deepEqual(firstPage.records.map(({ headRevision }) => headRevision), [3, 2])
        assert.strictEqual(firstPage.nextBeforeHeadRevision, 2)
        const finalPage = yield* readiness.readHistory({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId,
          beforeHeadRevision: firstPage.nextBeforeHeadRevision,
          limit: 2
        })
        assert.deepEqual(finalPage.records.map(({ headRevision }) => headRevision), [1])
        assert.isNull(finalPage.nextBeforeHeadRevision)
      })
    ))

  it.effect("quarantines materialization drift instead of trusting a published head", () =>
    withReadiness(
      Effect.gen(function*() {
        const readiness = yield* ReadinessRepository
        const quarantine = yield* QuarantineRepository
        const { sql } = yield* Database
        yield* seedFoundations
        const digest = yield* digestReadinessRule(definitions)
        yield* readiness.registerRule({
          workspaceId,
          material: definitions,
          digest,
          registeredAt: firstAt
        })
        const first = yield* makeAssessment({
          assessmentId: firstAssessmentId,
          previousAssessmentId: null,
          evaluatedAt: "2026-07-15T10:00:00.000Z"
        })
        yield* readiness.commitEnvironment({
          expectedHeadRevision: null,
          invalidation: null,
          assessment: first
        })
        const release = yield* makeReleaseAssessment({
          assessmentId: currentReleaseAssessmentId,
          environment: first
        })
        yield* TestClock.setTime(DateTime.toEpochMillis(secondAt))
        const releaseClaim = yield* readiness.claimInvalidation({
          _tag: "release",
          workspaceId,
          releaseId,
          expectedInvalidationRevision: 1,
          leaseOwner: "release-worker",
          leaseExpiresAt: thirdAt
        })
        yield* sql`DROP TRIGGER readiness_assessment_evidence_no_delete`
        yield* sql`DELETE FROM readiness_assessment_evidence
          WHERE workspace_id = ${workspaceId} AND assessment_id = ${firstAssessmentId}`

        const rejectedRelease = yield* readiness.commitRelease({
          expectedHeadRevision: null,
          invalidation: {
            invalidationRevision: 1,
            leaseOwner: "release-worker",
            leaseToken: releaseClaim?.lease?.token
          },
          assessment: release
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(rejectedRelease))
        if (Result.isFailure(rejectedRelease)) {
          assert.instanceOf(rejectedRelease.failure, PersistedRecordError)
          assert.strictEqual(
            rejectedRelease.failure.diagnosticCode,
            "readiness-assessment-materialization-mismatch"
          )
        }
        const leakedRelease = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM readiness_assessments WHERE assessment_id = ${currentReleaseAssessmentId}`
        assert.strictEqual(leakedRelease[0]?.count, 0)

        const corrupted = yield* readiness.readCurrent({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(corrupted))
        if (Result.isFailure(corrupted)) {
          assert.instanceOf(corrupted.failure, PersistedRecordError)
          assert.strictEqual(corrupted.failure.diagnosticCode, "readiness-assessment-materialization-mismatch")
        }
        const quarantined = yield* quarantine.list(workspaceId)
        assert.strictEqual(quarantined[0]?.diagnosticCode, "readiness-assessment-materialization-mismatch")
      })
    ))

  it.effect("quarantines schema-invalid materialized dependencies", () =>
    withReadiness(
      Effect.gen(function*() {
        const readiness = yield* ReadinessRepository
        const quarantine = yield* QuarantineRepository
        const { sql } = yield* Database
        yield* seedFoundations
        const digest = yield* digestReadinessRule(definitions)
        yield* readiness.registerRule({ workspaceId, material: definitions, digest, registeredAt: firstAt })
        const first = yield* makeAssessment({
          assessmentId: firstAssessmentId,
          previousAssessmentId: null,
          evaluatedAt: "2026-07-15T10:00:00.000Z"
        })
        yield* readiness.commitEnvironment({
          expectedHeadRevision: null,
          invalidation: null,
          assessment: first
        })
        yield* sql`DROP TRIGGER readiness_assessment_evidence_no_update`
        yield* sql`PRAGMA foreign_keys = OFF`
        yield* sql`UPDATE readiness_assessment_evidence SET evidence_id = 'malformed-evidence-id'
          WHERE workspace_id = ${workspaceId} AND assessment_id = ${firstAssessmentId}`
        yield* sql`PRAGMA foreign_keys = ON`

        const corrupted = yield* readiness.readCurrent({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(corrupted))
        if (Result.isFailure(corrupted)) {
          assert.instanceOf(corrupted.failure, PersistedRecordError)
          assert.strictEqual(corrupted.failure.diagnosticCode, "readiness-assessment-materialization-mismatch")
        }
        const quarantined = yield* quarantine.list(workspaceId)
        assert.strictEqual(quarantined[0]?.diagnosticCode, "readiness-assessment-materialization-mismatch")
      })
    ))

  it.effect("distinguishes a corrupt present head from an absent head", () =>
    withReadiness(
      Effect.gen(function*() {
        const readiness = yield* ReadinessRepository
        const quarantine = yield* QuarantineRepository
        const { sql } = yield* Database
        yield* seedFoundations
        const absent = yield* readiness.readCurrent({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId
        })
        assert.isNull(absent.record)

        const digest = yield* digestReadinessRule(definitions)
        yield* readiness.registerRule({
          workspaceId,
          material: definitions,
          digest,
          registeredAt: firstAt
        })
        const first = yield* makeAssessment({
          assessmentId: firstAssessmentId,
          previousAssessmentId: null,
          evaluatedAt: "2026-07-15T10:00:00.000Z"
        })
        yield* readiness.commitEnvironment({
          expectedHeadRevision: null,
          invalidation: null,
          assessment: first
        })
        yield* sql`DROP TRIGGER readiness_head_history_no_update`
        yield* sql`UPDATE readiness_head_history SET environment_key = ${otherEnvironmentId}
          WHERE workspace_id = ${workspaceId} AND assessment_id = ${firstAssessmentId}`
        const corrupted = yield* readiness.readCurrent({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(corrupted))
        if (Result.isFailure(corrupted)) {
          assert.instanceOf(corrupted.failure, PersistedRecordError)
          assert.strictEqual(corrupted.failure.diagnosticCode, "readiness-head-assessment-mismatch")
        }
        const wrongHistory = yield* readiness.readHistory({
          _tag: "environment",
          workspaceId,
          releaseId,
          environmentId: otherEnvironmentId,
          beforeHeadRevision: null,
          limit: 10
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(wrongHistory))
        if (Result.isFailure(wrongHistory)) {
          assert.instanceOf(wrongHistory.failure, PersistedRecordError)
          assert.strictEqual(wrongHistory.failure.diagnosticCode, "readiness-assessment-identity-mismatch")
        }
        const quarantined = yield* quarantine.list(workspaceId)
        assert.strictEqual(quarantined[0]?.diagnosticCode, "readiness-head-assessment-mismatch")
      })
    ))
})
