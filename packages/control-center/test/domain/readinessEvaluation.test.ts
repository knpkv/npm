import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"

import {
  assessEnvironmentReadiness,
  EnvironmentReadinessAssessment,
  EnvironmentReadinessEvaluationInput,
  READINESS_DERIVATION_VERSION_V1
} from "../../src/domain/readiness/index.js"

const workspaceId = "01890f6f-6d6a-7cc0-98d2-000000000201"
const releaseId = "01890f6f-6d6a-7cc0-98d2-000000000202"
const environmentId = "01890f6f-6d6a-7cc0-98d2-000000000203"
const assessmentId = "01890f6f-6d6a-7cc0-98d2-000000000204"
const pluginConnectionId = "01890f6f-6d6a-7cc0-98d2-000000000205"
const digest = `sha256:${"a".repeat(64)}`
const ruleDigest = `sha256:${"b".repeat(64)}`

const evidenceIds = {
  build: "01890f6f-6d6a-7cc0-98d2-000000000211",
  relationship: "01890f6f-6d6a-7cc0-98d2-000000000212",
  approval: "01890f6f-6d6a-7cc0-98d2-000000000213",
  check: "01890f6f-6d6a-7cc0-98d2-000000000214",
  documentation: "01890f6f-6d6a-7cc0-98d2-000000000215",
  deployment: "01890f6f-6d6a-7cc0-98d2-000000000216"
}

interface InputOptions {
  readonly complete?: boolean
  readonly build?: "missing" | "queued" | "running" | "succeeded" | "failed" | "stopped"
  readonly relationship?: "missing" | "inferred" | "proposed" | "verified" | "governed" | "rejected" | "superseded"
  readonly approval?: "missing" | "pending" | "approved" | "rejected" | "expired"
  readonly check?: "missing" | "queued" | "running" | "passed" | "failed" | "cancelled"
  readonly documentation?: "missing" | "draft" | "current" | "stale" | "superseded"
  readonly deployment?: "not-started" | "pending" | "deploying" | "succeeded" | "failed" | "rolled-back"
  readonly freshness?: "current" | "stale" | "missing" | "unavailable"
  readonly health?: "healthy" | "degraded" | "unavailable" | "disabled"
  readonly validity?: "valid" | "expired"
}

const rawInput = (options: InputOptions = {}) => {
  const build = options.build ?? "succeeded"
  const relationship = options.relationship ?? "verified"
  const approval = options.approval ?? "approved"
  const check = options.check ?? "passed"
  const documentation = options.documentation ?? "current"
  const deployment = options.deployment ?? "not-started"
  const evidence = (evidenceId: string, state: string) =>
    state === "missing"
      ? []
      : [{
        evidenceId,
        source: {
          _tag: "plugin",
          pluginConnectionId,
          health: options.health ?? "healthy"
        },
        freshness: options.freshness ?? "current",
        validity: options.validity ?? "valid",
        reevaluateAt: "2026-07-15T10:30:00.000Z"
      }]

  return {
    assessmentId,
    previousAssessmentId: null,
    candidate: {
      workspaceId,
      releaseRevision: 7,
      artifactRevision: "git:7f96c31",
      digest,
      scope: { _tag: "environment", releaseId, environmentId }
    },
    rule: { ruleId: "delivery-v1", version: 1, digest: ruleDigest },
    derivationVersion: 1,
    evaluatedAt: "2026-07-15T10:00:00.000Z",
    complete: options.complete ?? true,
    definitions: [
      { factId: "build.main", kind: "execution", requirement: "required" },
      { factId: "link.issue-pr", kind: "relationship", requirement: "required" },
      { factId: "approval.release", kind: "approval", requirement: "required" },
      { factId: "check.integration", kind: "check", requirement: "required" },
      { factId: "docs.release", kind: "documentation", requirement: "required" },
      { factId: "deploy.target", kind: "deployment", requirement: "advisory" }
    ],
    observations: [
      {
        factId: "build.main",
        state: { _tag: "execution", status: build, progress: null },
        evidence: evidence(evidenceIds.build, build)
      },
      {
        factId: "link.issue-pr",
        state: { _tag: "relationship", status: relationship },
        evidence: evidence(evidenceIds.relationship, relationship)
      },
      {
        factId: "approval.release",
        state: { _tag: "approval", status: approval },
        evidence: evidence(evidenceIds.approval, approval)
      },
      {
        factId: "check.integration",
        state: { _tag: "check", status: check },
        evidence: evidence(evidenceIds.check, check)
      },
      {
        factId: "docs.release",
        state: { _tag: "documentation", status: documentation },
        evidence: evidence(evidenceIds.documentation, documentation)
      },
      {
        factId: "deploy.target",
        state: { _tag: "deployment", status: deployment, progress: null },
        evidence: evidence(evidenceIds.deployment, deployment)
      }
    ]
  }
}

const decodeInput = (options: InputOptions = {}) =>
  Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)(rawInput(options))

const assess = (options: InputOptions = {}) => assessEnvironmentReadiness(decodeInput(options))

const boundedEvidence = (offset: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    evidenceId: `01890f6f-6d6a-7cc0-98d2-${(offset + index).toString(16).padStart(12, "0")}`,
    source: { _tag: "plugin", pluginConnectionId, health: "healthy" },
    freshness: "current",
    validity: "valid",
    reevaluateAt: null
  }))

const boundedRawInput = (extraEvidence: boolean) => ({
  ...rawInput(),
  definitions: [
    { factId: "build.a", kind: "execution", requirement: "required" },
    { factId: "build.b", kind: "execution", requirement: "required" },
    { factId: "build.c", kind: "execution", requirement: "required" },
    { factId: "check.bulk", kind: "check", requirement: "required" },
    { factId: "deploy.target", kind: "deployment", requirement: "advisory" }
  ],
  observations: [
    {
      factId: "build.a",
      state: { _tag: "execution", status: "succeeded", progress: null },
      evidence: boundedEvidence(1_000, 128)
    },
    {
      factId: "build.b",
      state: { _tag: "execution", status: "succeeded", progress: null },
      evidence: boundedEvidence(2_000, 128)
    },
    {
      factId: "build.c",
      state: { _tag: "execution", status: "succeeded", progress: null },
      evidence: boundedEvidence(3_000, 128)
    },
    {
      factId: "check.bulk",
      state: { _tag: "check", status: "passed" },
      evidence: boundedEvidence(4_000, 127)
    },
    {
      factId: "deploy.target",
      state: { _tag: "deployment", status: "not-started", progress: null },
      evidence: boundedEvidence(5_000, extraEvidence ? 2 : 1)
    }
  ]
})

describe("environment readiness evaluation", () => {
  it("derives the six canonical states from normalized facts", () => {
    const blocked = assess({ check: "failed" })
    const ready = assess()
    const deploying = assess({ deployment: "deploying" })
    const building = assess({ build: "running" })
    const shipped = assess({ deployment: "succeeded" })
    const held = assess({ relationship: "missing" })

    assert.strictEqual(blocked.verdict, "blocked")
    assert.strictEqual(blocked.stages.verify.state, "failed")
    assert.strictEqual(ready.verdict, "ready")
    assert.deepEqual(
      [ready.stages.build.state, ready.stages.verify.state, ready.stages.production.state],
      ["succeeded", "passed", "not-started"]
    )
    assert.strictEqual(deploying.verdict, "deploying")
    assert.strictEqual(deploying.stages.production.state, "deploying")
    assert.strictEqual(building.verdict, "building")
    assert.strictEqual(building.stages.build.state, "running")
    assert.strictEqual(shipped.verdict, "shipped")
    assert.strictEqual(shipped.stages.production.state, "succeeded")
    assert.strictEqual(held.verdict, "held")
    assert.strictEqual(held.stages.verify.state, "held")
  })

  it("requires an explicit evidence-bound deployment observation", () => {
    const raw = rawInput()
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
        ...raw,
        observations: raw.observations.filter(({ factId }) => factId !== "deploy.target")
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
        ...raw,
        observations: raw.observations.map((observation) =>
          observation.factId === "deploy.target"
            ? { ...observation, evidence: [] }
            : observation
        )
      })
    )
    assert.strictEqual(assess().verdict, "ready")
  })

  it("applies failure, active-work, gap, and completion precedence", () => {
    assert.strictEqual(assess({ check: "failed", deployment: "deploying" }).verdict, "blocked")
    assert.strictEqual(assess({ build: "running", deployment: "deploying" }).verdict, "deploying")
    assert.strictEqual(assess({ build: "running", relationship: "missing" }).verdict, "building")
    assert.strictEqual(assess({ relationship: "missing", deployment: "succeeded" }).verdict, "held")
  })

  it("never invents readiness from stale, unavailable, expired, or incomplete input", () => {
    const nonCurrentCases: ReadonlyArray<InputOptions> = [
      { freshness: "stale" },
      { freshness: "unavailable" },
      { validity: "expired" },
      { complete: false }
    ]
    for (const options of nonCurrentCases) {
      const assessment = assess(options)
      assert.strictEqual(assessment.verdict, "held")
      assert.isAbove(assessment.gaps.length, 0)
    }
  })

  it("keeps explicit failures blocking even when their evidence is stale", () => {
    const assessment = assess({ check: "failed", freshness: "stale" })

    assert.strictEqual(assessment.verdict, "blocked")
    assert.include(assessment.blockers.map(({ code }) => code), "check-failed")
    assert.include(assessment.warnings.map(({ code }) => code), "source-stale")
  })

  it("holds stale active work but permits degraded current evidence with warnings", () => {
    const staleBuild = assess({ build: "running", freshness: "stale" })
    assert.strictEqual(staleBuild.verdict, "held")
    assert.strictEqual(staleBuild.stages.build.state, "held")

    const degraded = assess({ health: "degraded" })
    assert.strictEqual(degraded.verdict, "ready")
    assert.include(degraded.warnings.map(({ code }) => code), "plugin-degraded")
  })

  it("holds non-current deployment activity and reports advisory source warnings", () => {
    const assessment = assess({ deployment: "deploying", freshness: "stale" })

    assert.strictEqual(assessment.verdict, "held")
    assert.strictEqual(assessment.stages.production.state, "held")
    assert.include(assessment.warnings.map(({ code }) => code), "source-stale")
  })

  it("holds pending approval while check and execution activity are building", () => {
    const pendingApproval = assess({ approval: "pending" })

    assert.strictEqual(pendingApproval.verdict, "held")
    assert.strictEqual(pendingApproval.stages.verify.state, "pending")
    assert.include(pendingApproval.warnings.map(({ code }) => code), "approval-pending")
    assert.strictEqual(assess({ check: "running" }).verdict, "building")
    assert.strictEqual(assess({ build: "queued" }).verdict, "building")
    assert.strictEqual(assess({ approval: "rejected" }).verdict, "blocked")
    assert.strictEqual(assess({ approval: "expired" }).verdict, "held")
  })

  it("keeps advisory activity contextual rather than verdict-driving", () => {
    const raw = rawInput()
    const advisory = {
      factId: "check.advisory",
      state: { _tag: "check", status: "running" },
      evidence: [{
        evidenceId: "01890f6f-6d6a-7cc0-98d2-000000000217",
        source: { _tag: "plugin", pluginConnectionId, health: "healthy" },
        freshness: "current",
        validity: "valid",
        reevaluateAt: null
      }]
    }
    const withRequirement = (requirement: "required" | "advisory") =>
      Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
        ...raw,
        definitions: [
          ...raw.definitions,
          { factId: "check.advisory", kind: "check", requirement }
        ],
        observations: [...raw.observations, advisory]
      })

    const contextual = assessEnvironmentReadiness(withRequirement("advisory"))
    assert.strictEqual(contextual.verdict, "ready")
    assert.include(contextual.warnings.map(({ code }) => code), "check-pending")
    assert.strictEqual(assessEnvironmentReadiness(withRequirement("required")).verdict, "building")
  })

  it("uses running over queued precedence across multiple required executions", () => {
    const raw = rawInput({ build: "queued" })
    const queued = raw.observations.map((observation) =>
      observation.factId === "build.main"
        ? { ...observation, factId: "build.a" }
        : observation
    )
    const definitions = raw.definitions.map((definition) =>
      definition.factId === "build.main"
        ? { ...definition, factId: "build.a" }
        : definition
    )
    const running = {
      factId: "build.z",
      state: { _tag: "execution", status: "running", progress: null },
      evidence: [{
        evidenceId: "01890f6f-6d6a-7cc0-98d2-000000000218",
        source: { _tag: "plugin", pluginConnectionId, health: "healthy" },
        freshness: "current",
        validity: "valid",
        reevaluateAt: null
      }]
    }
    const input = Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
      ...raw,
      definitions: [
        ...definitions,
        { factId: "build.z", kind: "execution", requirement: "required" }
      ],
      observations: [...queued, running]
    })

    const assessment = assessEnvironmentReadiness(input)
    assert.strictEqual(assessment.verdict, "building")
    assert.strictEqual(assessment.stages.build.state, "running")
  })

  it("retains exact evidence dependencies and the earliest reevaluation boundary", () => {
    const assessment = assess()
    const encoded = Schema.encodeSync(EnvironmentReadinessAssessment)(assessment)

    assert.deepEqual(assessment.evidenceIds.map(String), Object.values(evidenceIds).sort())
    assert.strictEqual(encoded.nextEvaluationAt, "2026-07-15T10:30:00.000Z")
    assert.doesNotThrow(() => Schema.decodeUnknownSync(EnvironmentReadinessAssessment)(encoded))
  })

  it("is deterministic across definition and observation ordering", () => {
    const raw = rawInput()
    const input = Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
      ...raw,
      observations: raw.observations.map((observation) =>
        observation.factId === "build.main"
          ? {
            ...observation,
            evidence: [...observation.evidence, {
              evidenceId: "01890f6f-6d6a-7cc0-98d2-000000000219",
              source: { _tag: "plugin", pluginConnectionId, health: "healthy" },
              freshness: "current",
              validity: "valid",
              reevaluateAt: null
            }]
          }
          : observation
      )
    })
    const encodedInput = Schema.encodeSync(EnvironmentReadinessEvaluationInput)(input)
    const permuted = Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
      ...encodedInput,
      definitions: encodedInput.definitions.slice().reverse(),
      observations: encodedInput.observations.slice().reverse().map((observation) => ({
        ...observation,
        evidence: observation.evidence.slice().reverse()
      }))
    })

    assert.deepEqual(
      Schema.encodeSync(EnvironmentReadinessAssessment)(assessEnvironmentReadiness(input)),
      Schema.encodeSync(EnvironmentReadinessAssessment)(assessEnvironmentReadiness(permuted))
    )
  })

  it("rejects duplicate, mismatched, and unevidenced observations at the boundary", () => {
    const raw = rawInput()
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
        ...raw,
        definitions: [...raw.definitions, raw.definitions[0]]
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
        ...raw,
        observations: raw.observations.map((observation) =>
          observation.factId === "build.main"
            ? { ...observation, state: { _tag: "approval", status: "approved" } }
            : observation
        )
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
        ...raw,
        observations: raw.observations.map((observation) =>
          observation.factId === "build.main"
            ? { ...observation, evidence: [] }
            : observation
        )
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
        ...raw,
        definitions: raw.definitions.map((definition) =>
          definition.kind === "deployment"
            ? { ...definition, requirement: "required" }
            : definition
        )
      })
    )
  })

  it("binds the V1 evaluator to its version and a distinct predecessor", () => {
    const raw = rawInput()
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
        ...raw,
        previousAssessmentId: raw.assessmentId
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
        ...raw,
        derivationVersion: 2
      })
    )

    const input = Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
      ...raw,
      previousAssessmentId: "01890f6f-6d6a-7cc0-98d2-000000000220",
      derivationVersion: READINESS_DERIVATION_VERSION_V1
    })
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessAssessment)(
        Schema.encodeSync(EnvironmentReadinessAssessment)(assessEnvironmentReadiness(input))
      )
    )
  })

  it("rejects contradictory assessment records at the trusted boundary", () => {
    const blocked = Schema.encodeSync(EnvironmentReadinessAssessment)(assess({ check: "failed" }))
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessAssessment)({
        ...blocked,
        verdict: "ready"
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessAssessment)({
        ...blocked,
        blockers: [],
        verdict: "held"
      })
    )

    const ready = Schema.encodeSync(EnvironmentReadinessAssessment)(assess())
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessAssessment)({
        ...ready,
        derivationVersion: 2
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessAssessment)({
        ...ready,
        requiredFactIds: ready.requiredFactIds.slice(1)
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessAssessment)({
        ...ready,
        stages: {
          ...ready.stages,
          build: { ...ready.stages.build, state: "held" }
        },
        verdict: "held"
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessAssessment)({
        ...ready,
        sourceFreshness: ready.sourceFreshness.map((source) => ({
          ...source,
          health: "disabled"
        }))
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessAssessment)({
        ...ready,
        inputComplete: false
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessAssessment)({
        ...ready,
        nextEvaluationAt: null
      })
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessAssessment)({
        ...ready,
        inputComplete: true,
        facts: [],
        requiredFactIds: [],
        verifiedFactIds: [],
        nextEvaluationAt: null,
        stages: {
          build: { state: "succeeded", factIds: [], evidenceIds: [], progress: null },
          verify: { state: "passed", factIds: [], evidenceIds: [], progress: null },
          production: { state: "not-started", factIds: [], evidenceIds: [], progress: null }
        },
        blockers: [],
        warnings: [],
        gaps: [],
        sourceFreshness: [],
        evidenceIds: [],
        verdict: "ready"
      })
    )

    const held = Schema.encodeSync(EnvironmentReadinessAssessment)(assess({ relationship: "missing" }))
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessAssessment)({
        ...held,
        verifiedFactIds: [...held.verifiedFactIds, "link.issue-pr"]
      })
    )
  })

  it("aligns the maximum input evidence set with every assessment output bound", () => {
    const maximum = Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)(boundedRawInput(false))
    const assessment = assessEnvironmentReadiness(maximum)

    assert.lengthOf(assessment.evidenceIds, 512)
    assert.lengthOf(assessment.sourceFreshness.flatMap(({ evidenceIds }) => evidenceIds), 512)
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessAssessment)(
        Schema.encodeSync(EnvironmentReadinessAssessment)(assessment)
      )
    )
    assert.throws(() =>
      Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)(
        boundedRawInput(true)
      )
    )
  })
})
