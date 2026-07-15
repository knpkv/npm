import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"

import {
  assessEnvironmentReadiness,
  EnvironmentReadinessAssessment,
  EnvironmentReadinessEvaluationInput
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
    state === "missing" || state === "not-started"
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

describe("environment readiness evaluation", () => {
  it("derives the six canonical states from normalized facts", () => {
    assert.strictEqual(assess({ check: "failed" }).verdict, "blocked")
    assert.strictEqual(assess().verdict, "ready")
    assert.strictEqual(assess({ deployment: "deploying" }).verdict, "deploying")
    assert.strictEqual(assess({ build: "running" }).verdict, "building")
    assert.strictEqual(assess({ deployment: "succeeded" }).verdict, "shipped")
    assert.strictEqual(assess({ relationship: "missing" }).verdict, "held")
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
    assert.include(assessment.gaps.map(({ code }) => code), "source-stale")
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

  it("retains exact evidence dependencies and the earliest reevaluation boundary", () => {
    const assessment = assess()
    const encoded = Schema.encodeSync(EnvironmentReadinessAssessment)(assessment)

    assert.deepEqual(assessment.evidenceIds.map(String), Object.values(evidenceIds).slice(0, 5).sort())
    assert.strictEqual(encoded.nextEvaluationAt, "2026-07-15T10:30:00.000Z")
    assert.doesNotThrow(() => Schema.decodeUnknownSync(EnvironmentReadinessAssessment)(encoded))
  })

  it("is deterministic across definition and observation ordering", () => {
    const input = decodeInput()
    const encodedInput = Schema.encodeSync(EnvironmentReadinessEvaluationInput)(input)
    const permuted = Schema.decodeUnknownSync(EnvironmentReadinessEvaluationInput)({
      ...encodedInput,
      definitions: encodedInput.definitions.slice().reverse(),
      observations: encodedInput.observations.slice().reverse()
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
})
