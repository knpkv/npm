import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"

import {
  assessEnvironmentReadiness,
  EnvironmentReadinessAssessment,
  EnvironmentReadinessEvaluationInput,
  ReleaseReadinessAssessment,
  ReleaseReadinessRollupInput,
  rollUpReleaseReadiness
} from "../../src/domain/readiness/index.js"

const workspaceId = "01890f6f-6d6a-7cc0-98d2-000000000301"
const releaseId = "01890f6f-6d6a-7cc0-98d2-000000000302"
const pluginConnectionId = "01890f6f-6d6a-7cc0-98d2-000000000303"
const firstEnvironmentId = "01890f6f-6d6a-7cc0-98d2-000000000304"
const secondEnvironmentId = "01890f6f-6d6a-7cc0-98d2-000000000305"
const environmentIds = [firstEnvironmentId, secondEnvironmentId]
const firstAssessmentId = "01890f6f-6d6a-7cc0-98d2-000000000306"
const secondAssessmentId = "01890f6f-6d6a-7cc0-98d2-000000000307"
const releaseAssessmentId = "01890f6f-6d6a-7cc0-98d2-000000000308"
const previousReleaseAssessmentId = "01890f6f-6d6a-7cc0-98d2-000000000309"
const ruleDigest = `sha256:${"c".repeat(64)}`

type BuildState = "succeeded" | "running" | "failed"
type DeploymentState = "not-started" | "deploying" | "succeeded"

const environmentAssessment = (
  index: 0 | 1,
  build: BuildState = "succeeded",
  deployment: DeploymentState = "not-started"
) => {
  const environmentId = index === 0 ? firstEnvironmentId : secondEnvironmentId
  const assessmentId = index === 0 ? firstAssessmentId : secondAssessmentId
  const evidenceId = index === 0
    ? "01890f6f-6d6a-7cc0-98d2-000000000311"
    : "01890f6f-6d6a-7cc0-98d2-000000000312"
  const evidence = (_state: string) => [{
    evidenceId,
    source: { _tag: "plugin", pluginConnectionId, health: "healthy" },
    freshness: "current",
    validity: "valid",
    reevaluateAt: index === 0 ? "2026-07-15T10:15:00.000Z" : "2026-07-15T10:30:00.000Z"
  }]
  const raw = {
    assessmentId,
    previousAssessmentId: null,
    candidate: {
      workspaceId,
      releaseRevision: 4,
      artifactRevision: "git:release-4",
      digest: `sha256:${index === 0 ? "d".repeat(64) : "e".repeat(64)}`,
      scope: { _tag: "environment", releaseId, environmentId }
    },
    rule: { ruleId: "delivery-v1", version: 1, digest: ruleDigest },
    derivationVersion: 1,
    evaluatedAt: "2026-07-15T10:00:00.000Z",
    complete: true,
    definitions: [
      { factId: "build.main", kind: "execution", requirement: "required" },
      { factId: "check.main", kind: "check", requirement: "required" },
      { factId: "deploy.target", kind: "deployment", requirement: "advisory" }
    ],
    observations: [
      {
        factId: "build.main",
        state: { _tag: "execution", status: build, progress: null },
        evidence: evidence(build)
      },
      {
        factId: "check.main",
        state: { _tag: "check", status: "passed" },
        evidence: evidence("passed")
      },
      {
        factId: "deploy.target",
        state: { _tag: "deployment", status: deployment, progress: null },
        evidence: evidence(deployment)
      }
    ]
  }
  return assessEnvironmentReadiness(Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)(raw))
}

const denseEvidence = (index: 0 | 1, offset: number, count: number) =>
  Array.from({ length: count }, (_, item) => ({
    evidenceId: `01890f6f-6d6a-7cc0-98d2-${((index + 1) * 10_000 + offset + item).toString(16).padStart(12, "0")}`,
    source: { _tag: "plugin", pluginConnectionId, health: "healthy" },
    freshness: "current",
    validity: "valid",
    reevaluateAt: null
  }))

const denseEnvironmentAssessment = (index: 0 | 1, checkEvidence: 127 | 128) => {
  const environmentId = index === 0 ? firstEnvironmentId : secondEnvironmentId
  const assessmentId = index === 0 ? firstAssessmentId : secondAssessmentId
  return assessEnvironmentReadiness(
    Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
      assessmentId,
      previousAssessmentId: null,
      candidate: {
        workspaceId,
        releaseRevision: 4,
        artifactRevision: "git:release-4",
        digest: `sha256:${index === 0 ? "d".repeat(64) : "e".repeat(64)}`,
        scope: { _tag: "environment", releaseId, environmentId }
      },
      rule: { ruleId: "delivery-v1", version: 1, digest: ruleDigest },
      derivationVersion: 1,
      evaluatedAt: "2026-07-15T10:00:00.000Z",
      complete: true,
      definitions: [
        { factId: "build.main", kind: "execution", requirement: "required" },
        { factId: "check.main", kind: "check", requirement: "required" },
        { factId: "deploy.target", kind: "deployment", requirement: "advisory" }
      ],
      observations: [
        {
          factId: "build.main",
          state: { _tag: "execution", status: "succeeded", progress: null },
          evidence: denseEvidence(index, 0, 128)
        },
        {
          factId: "check.main",
          state: { _tag: "check", status: "passed" },
          evidence: denseEvidence(index, 1_000, checkEvidence)
        },
        {
          factId: "deploy.target",
          state: { _tag: "deployment", status: "not-started", progress: null },
          evidence: denseEvidence(index, 2_000, 1)
        }
      ]
    })
  )
}

const rawRollup = (
  first: EnvironmentReadinessAssessment,
  second: EnvironmentReadinessAssessment
) => ({
  assessmentId: releaseAssessmentId,
  previousAssessmentId: null,
  candidate: {
    workspaceId,
    releaseRevision: 4,
    artifactRevision: "git:release-4",
    digest: `sha256:${"f".repeat(64)}`,
    scope: { _tag: "release", releaseId }
  },
  evaluatedAt: "2026-07-15T10:01:00.000Z",
  environments: [
    Schema.encodeSync(EnvironmentReadinessAssessment)(first),
    Schema.encodeSync(EnvironmentReadinessAssessment)(second)
  ]
})

const rollup = (
  first: EnvironmentReadinessAssessment,
  second: EnvironmentReadinessAssessment
) => rollUpReleaseReadiness(Schema.decodeUnknownSync(ReleaseReadinessRollupInput)(rawRollup(first, second)))

describe("release readiness roll-up", () => {
  it("uses deterministic cross-environment precedence", () => {
    assert.strictEqual(
      rollup(
        environmentAssessment(0, "failed"),
        environmentAssessment(1, "succeeded", "deploying")
      ).verdict,
      "blocked"
    )
    assert.strictEqual(
      rollup(
        environmentAssessment(0, "running"),
        environmentAssessment(1, "succeeded", "deploying")
      ).verdict,
      "deploying"
    )
    assert.strictEqual(
      rollup(
        environmentAssessment(0, "succeeded", "succeeded"),
        environmentAssessment(1)
      ).verdict,
      "ready"
    )
    assert.strictEqual(
      rollup(
        environmentAssessment(0, "succeeded", "succeeded"),
        environmentAssessment(1, "succeeded", "succeeded")
      ).verdict,
      "shipped"
    )
  })

  it("retains compact per-environment identity, evidence, and earliest reevaluation", () => {
    const assessment = rollup(environmentAssessment(0), environmentAssessment(1))
    const encoded = Schema.encodeSync(ReleaseReadinessAssessment)(assessment)

    assert.deepEqual(assessment.environments.map(({ environmentId }) => String(environmentId)), [...environmentIds])
    assert.strictEqual(encoded.nextEvaluationAt, "2026-07-15T10:15:00.000Z")
    assert.lengthOf(assessment.evidenceIds, 2)
    assert.doesNotThrow(() => Schema.decodeUnknownSync(ReleaseReadinessAssessment)(encoded))
  })

  it("is deterministic across child ordering", () => {
    const first = environmentAssessment(0)
    const second = environmentAssessment(1)
    const forward = Schema.decodeUnknownSync(ReleaseReadinessRollupInput)(rawRollup(first, second))
    const reverseRaw = rawRollup(first, second)
    const reverse = Schema.decodeUnknownSync(ReleaseReadinessRollupInput)({
      ...reverseRaw,
      environments: reverseRaw.environments.slice().reverse()
    })

    assert.deepEqual(
      Schema.encodeSync(ReleaseReadinessAssessment)(rollUpReleaseReadiness(forward)),
      Schema.encodeSync(ReleaseReadinessAssessment)(rollUpReleaseReadiness(reverse))
    )
  })

  it("rejects duplicate environments and mixed release or rule provenance", () => {
    const first = environmentAssessment(0)
    const second = environmentAssessment(1)
    const raw = rawRollup(first, second)
    const encodedFirst = Schema.encodeSync(EnvironmentReadinessAssessment)(first)
    const encodedSecond = Schema.encodeSync(EnvironmentReadinessAssessment)(second)

    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessRollupInput)({
        ...raw,
        environments: [encodedFirst, encodedFirst]
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessRollupInput)({
        ...raw,
        environments: [
          encodedFirst,
          {
            ...encodedSecond,
            candidate: {
              ...encodedSecond.candidate,
              scope: { ...encodedSecond.candidate.scope, releaseId: environmentIds[0] }
            }
          }
        ]
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessRollupInput)({
        ...raw,
        environments: [encodedFirst, { ...encodedSecond, derivationVersion: 2 }]
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessRollupInput)({
        ...raw,
        environments: [
          encodedFirst,
          { ...encodedSecond, rule: { ...encodedSecond.rule, ruleId: "other-rule" } }
        ]
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessRollupInput)({
        ...raw,
        candidate: { ...raw.candidate, releaseRevision: 5 }
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessRollupInput)({
        ...raw,
        evaluatedAt: "2026-07-15T09:59:59.999Z"
      })
    )
  })

  it("requires a distinct roll-up predecessor and produces a valid linked assessment", () => {
    const first = environmentAssessment(0)
    const second = environmentAssessment(1)
    const raw = rawRollup(first, second)
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessRollupInput)({
        ...raw,
        previousAssessmentId: raw.assessmentId
      })
    )

    const input = Schema.decodeUnknownSync(ReleaseReadinessRollupInput)({
      ...raw,
      previousAssessmentId: previousReleaseAssessmentId
    })
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(ReleaseReadinessAssessment)(
        Schema.encodeSync(ReleaseReadinessAssessment)(rollUpReleaseReadiness(input))
      )
    )
  })

  it("rejects contradictory release assessments at the trusted boundary", () => {
    const ready = Schema.encodeSync(ReleaseReadinessAssessment)(
      rollup(environmentAssessment(0), environmentAssessment(1))
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessAssessment)({
        ...ready,
        verdict: "shipped"
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessAssessment)({
        ...ready,
        evidenceIds: ready.evidenceIds.slice(1)
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessAssessment)({
        ...ready,
        environments: ready.environments.slice().reverse()
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessAssessment)({
        ...ready,
        stages: {
          ...ready.stages,
          build: { ...ready.stages.build, state: "held" }
        },
        verdict: "held"
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessAssessment)({
        ...ready,
        sourceFreshness: ready.sourceFreshness.map((source) => ({
          ...source,
          health: "disabled"
        }))
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessAssessment)({
        ...ready,
        nextEvaluationAt: null
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessAssessment)({
        ...ready,
        warnings: [{
          code: "plugin-degraded",
          subject: { _tag: "source", pluginConnectionId },
          evidenceIds: ready.evidenceIds.slice(0, 1)
        }]
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessAssessment)({
        ...ready,
        gaps: [{
          code: "source-stale",
          subject: { _tag: "source", pluginConnectionId },
          evidenceIds: ready.evidenceIds.slice(0, 1)
        }]
      })
    )
    const injectedBlocker = {
      code: "check-failed",
      subject: { _tag: "fact", factId: "check.main" },
      evidenceIds: ready.environments[0].evidenceIds.slice(0, 1)
    }
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessAssessment)({
        ...ready,
        environments: ready.environments.map((environment, index) =>
          index === 0 ? { ...environment, blockers: [injectedBlocker] } : environment
        ),
        blockers: [injectedBlocker]
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessAssessment)({
        ...ready,
        environments: ready.environments.map((environment, index) =>
          index === 0
            ? {
              ...environment,
              stages: {
                ...environment.stages,
                build: {
                  ...environment.stages.build,
                  factIds: [
                    ...environment.stages.build.factIds,
                    ...environment.stages.build.factIds
                  ]
                }
              }
            }
            : environment
        )
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessAssessment)({
        ...ready,
        environments: ready.environments.map((environment, index) =>
          index === 0
            ? {
              ...environment,
              sourceFreshness: environment.sourceFreshness.map((source) => ({
                ...source,
                evidenceIds: [...source.evidenceIds, ...source.evidenceIds]
              }))
            }
            : environment
        )
      })
    )

    const blocked = Schema.encodeSync(ReleaseReadinessAssessment)(
      rollup(environmentAssessment(0, "failed"), environmentAssessment(1))
    )
    assert.doesNotThrow(() => Schema.decodeUnknownSync(ReleaseReadinessAssessment)(blocked))
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessAssessment)({
        ...blocked,
        blockers: []
      })
    )
  })

  it("aligns release roll-up bounds with the maximum aggregate evidence output", () => {
    const first = denseEnvironmentAssessment(0, 127)
    const second = denseEnvironmentAssessment(1, 127)
    const maximum = Schema.decodeUnknownSync(ReleaseReadinessRollupInput)(rawRollup(first, second))
    const assessment = rollUpReleaseReadiness(maximum)

    assert.lengthOf(assessment.evidenceIds, 512)
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(ReleaseReadinessAssessment)(
        Schema.encodeSync(ReleaseReadinessAssessment)(assessment)
      )
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(ReleaseReadinessRollupInput)(
        rawRollup(first, denseEnvironmentAssessment(1, 128))
      )
    )
  })
})
