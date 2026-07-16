import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import {
  EnvironmentReadinessCandidateMaterial,
  normalizeEnvironmentReadinessCandidateMaterial,
  normalizeReadinessRuleMaterial,
  ReadinessRuleMaterial,
  ReleaseReadinessCandidateMaterial
} from "../../src/domain/readiness/index.js"
import {
  digestEnvironmentReadinessCandidate,
  digestReadinessRule,
  digestReleaseReadinessCandidate
} from "../../src/server/application/readinessDigests.js"

const workspaceId = "01890f6f-6d6a-7cc0-98d2-000000000301"
const releaseId = "01890f6f-6d6a-7cc0-98d2-000000000302"
const otherReleaseId = "01890f6f-6d6a-7cc0-98d2-000000000303"
const environmentId = "01890f6f-6d6a-7cc0-98d2-000000000304"
const otherEnvironmentId = "01890f6f-6d6a-7cc0-98d2-000000000305"
const pluginConnectionId = "01890f6f-6d6a-7cc0-98d2-000000000306"
const otherPluginConnectionId = "01890f6f-6d6a-7cc0-98d2-000000000307"
const assessmentId = "01890f6f-6d6a-7cc0-98d2-000000000308"
const otherAssessmentId = "01890f6f-6d6a-7cc0-98d2-000000000309"
const firstDigest = `sha256:${"a".repeat(64)}`
const secondDigest = `sha256:${"b".repeat(64)}`

const definitions = [
  { factId: "build.main", kind: "execution", requirement: "required" },
  { factId: "link.issue-pr", kind: "relationship", requirement: "required" },
  { factId: "check.integration", kind: "check", requirement: "required" },
  { factId: "deploy.target", kind: "deployment", requirement: "advisory" }
]

const evidence = (evidenceId: string, connectionId = pluginConnectionId) => ({
  evidenceId,
  source: { _tag: "plugin", pluginConnectionId: connectionId, health: "healthy" },
  freshness: "current",
  validity: "valid",
  reevaluateAt: "2026-07-15T10:30:00.000Z"
})

const observations = [
  {
    factId: "build.main",
    state: { _tag: "execution", status: "succeeded", progress: null },
    evidence: [
      evidence("01890f6f-6d6a-7cc0-98d2-000000000311"),
      evidence("01890f6f-6d6a-7cc0-98d2-000000000312")
    ]
  },
  {
    factId: "link.issue-pr",
    state: { _tag: "relationship", status: "verified" },
    evidence: [evidence("01890f6f-6d6a-7cc0-98d2-000000000315")]
  },
  {
    factId: "check.integration",
    state: { _tag: "check", status: "passed" },
    evidence: [evidence("01890f6f-6d6a-7cc0-98d2-000000000313")]
  },
  {
    factId: "deploy.target",
    state: { _tag: "deployment", status: "not-started", progress: null },
    evidence: [evidence("01890f6f-6d6a-7cc0-98d2-000000000314")]
  }
]

const environmentRaw = () => ({
  workspaceId,
  releaseRevision: 7,
  artifactRevision: "git:7f96c31",
  scope: { _tag: "environment", releaseId, environmentId },
  complete: true,
  definitions,
  observations
})

const releaseRaw = () => ({
  workspaceId,
  releaseRevision: 7,
  artifactRevision: "git:7f96c31",
  scope: { _tag: "release", releaseId },
  environments: [
    { assessmentId, environmentId, candidateDigest: firstDigest },
    { assessmentId: otherAssessmentId, environmentId: otherEnvironmentId, candidateDigest: secondDigest }
  ]
})

const ruleRaw = () => ({ ruleId: "delivery-v1", version: 1, definitions })

const decodeEnvironment = (input: unknown) => Schema.decodeUnknownSync(EnvironmentReadinessCandidateMaterial)(input)
const decodeRelease = (input: unknown) => Schema.decodeUnknownSync(ReleaseReadinessCandidateMaterial)(input)
const decodeRule = (input: unknown) => Schema.decodeUnknownSync(ReadinessRuleMaterial)(input)

describe("readiness canonical digests", () => {
  it.effect("matches the canonical digest vectors", () =>
    Effect.gen(function*() {
      const actual = [
        yield* digestEnvironmentReadinessCandidate(decodeEnvironment(environmentRaw())),
        yield* digestReleaseReadinessCandidate(decodeRelease(releaseRaw())),
        yield* digestReadinessRule(decodeRule(ruleRaw()))
      ]
      assert.deepEqual(actual, [
        "sha256:937d5b7355141610f3f15fda67797b77ec40b7c57be394f5ddd9fbb1ff90bfca",
        "sha256:3457c3cda1c632588f38717000b813965daa14534cdb886cce9c3b44fd74d8b2",
        "sha256:fe79bd5498d182b4c27a73322c3bb616e84326d9abb8a4808d7073f63fd79124"
      ])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("is invariant to fact, observation, evidence, and environment ordering", () =>
    Effect.gen(function*() {
      const environment = environmentRaw()
      const permutedEnvironment = {
        ...environment,
        definitions: [...environment.definitions].reverse(),
        observations: [...environment.observations].reverse().map((observation) => ({
          ...observation,
          evidence: [...observation.evidence].reverse()
        }))
      }
      const release = releaseRaw()
      const rule = ruleRaw()

      assert.strictEqual(
        yield* digestEnvironmentReadinessCandidate(decodeEnvironment(environment)),
        yield* digestEnvironmentReadinessCandidate(decodeEnvironment(permutedEnvironment))
      )
      assert.strictEqual(
        yield* digestReleaseReadinessCandidate(decodeRelease(release)),
        yield* digestReleaseReadinessCandidate(decodeRelease({
          ...release,
          environments: [...release.environments].reverse()
        }))
      )
      assert.strictEqual(
        yield* digestReadinessRule(decodeRule(rule)),
        yield* digestReadinessRule(decodeRule({ ...rule, definitions: [...rule.definitions].reverse() }))
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("changes for every environment identity, policy, observation, and evidence dimension", () =>
    Effect.gen(function*() {
      const original = environmentRaw()
      const originalDigest = yield* digestEnvironmentReadinessCandidate(decodeEnvironment(original))
      const changedEvidence = evidence("01890f6f-6d6a-7cc0-98d2-000000000311", otherPluginConnectionId)
      const variants: ReadonlyArray<unknown> = [
        { ...original, workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000321" },
        { ...original, releaseRevision: 8 },
        { ...original, artifactRevision: "git:8a07d42" },
        { ...original, scope: { ...original.scope, releaseId: otherReleaseId } },
        { ...original, scope: { ...original.scope, environmentId: otherEnvironmentId } },
        { ...original, complete: false },
        {
          ...original,
          definitions: original.definitions.map((definition) =>
            definition.factId === "check.integration"
              ? { ...definition, factId: "check.contract" }
              : definition
          ),
          observations: original.observations.map((observation) =>
            observation.factId === "check.integration"
              ? { ...observation, factId: "check.contract" }
              : observation
          )
        },
        {
          ...original,
          definitions: original.definitions.map((definition) =>
            definition.factId === "check.integration"
              ? { ...definition, kind: "approval" }
              : definition
          ),
          observations: original.observations.map((observation) =>
            observation.factId === "check.integration"
              ? { ...observation, state: { _tag: "approval", status: "approved" } }
              : observation
          )
        },
        {
          ...original,
          definitions: original.definitions.map((definition) =>
            definition.factId === "check.integration"
              ? { ...definition, requirement: "advisory" }
              : definition
          )
        },
        {
          ...original,
          observations: original.observations.map((observation) =>
            observation.factId === "check.integration"
              ? { ...observation, state: { _tag: "check", status: "running" } }
              : observation
          )
        },
        {
          ...original,
          observations: original.observations.map((observation) =>
            observation.factId === "deploy.target"
              ? { ...observation, state: { ...observation.state, progress: { _tag: "percent", value: 25 } } }
              : observation
          )
        },
        {
          ...original,
          observations: original.observations.map((observation) =>
            observation.factId === "build.main"
              ? { ...observation, state: { ...observation.state, progress: { _tag: "percent", value: 100 } } }
              : observation
          )
        },
        {
          ...original,
          observations: original.observations.map((observation) =>
            observation.factId === "build.main"
              ? {
                ...observation,
                evidence: observation.evidence.map((item) => ({
                  ...item,
                  source: { _tag: "local", origin: "human" }
                }))
              }
              : observation
          )
        },
        {
          ...original,
          observations: original.observations.map((observation) =>
            observation.factId === "build.main"
              ? { ...observation, evidence: [changedEvidence, ...observation.evidence.slice(1)] }
              : observation
          )
        },
        {
          ...original,
          observations: original.observations.map((observation) =>
            observation.factId === "build.main"
              ? {
                ...observation,
                evidence: [
                  {
                    ...observation.evidence[0],
                    evidenceId: "01890f6f-6d6a-7cc0-98d2-000000000316"
                  },
                  ...observation.evidence.slice(1)
                ]
              }
              : observation
          )
        },
        {
          ...original,
          observations: original.observations.map((observation) =>
            observation.factId === "build.main"
              ? {
                ...observation,
                evidence: observation.evidence.map((item) => ({
                  ...item,
                  source: { ...item.source, health: "degraded" }
                }))
              }
              : observation
          )
        },
        {
          ...original,
          observations: original.observations.map((observation) =>
            observation.factId === "build.main"
              ? {
                ...observation,
                evidence: observation.evidence.map((item) => ({
                  ...item,
                  source: { _tag: "local", origin: "agent" }
                }))
              }
              : observation
          )
        },
        {
          ...original,
          observations: original.observations.map((observation) =>
            observation.factId === "build.main"
              ? {
                ...observation,
                evidence: observation.evidence.map((item) => ({ ...item, freshness: "stale" }))
              }
              : observation
          )
        },
        {
          ...original,
          observations: original.observations.map((observation) =>
            observation.factId === "build.main"
              ? {
                ...observation,
                evidence: observation.evidence.map((item) => ({ ...item, validity: "expired" }))
              }
              : observation
          )
        },
        {
          ...original,
          observations: original.observations.map((observation) =>
            observation.factId === "build.main"
              ? {
                ...observation,
                evidence: observation.evidence.map((item) => ({
                  ...item,
                  reevaluateAt: "2026-07-15T10:31:00.000Z"
                }))
              }
              : observation
          )
        }
      ]

      const variantDigests = yield* Effect.forEach(
        variants,
        (variant) => digestEnvironmentReadinessCandidate(decodeEnvironment(variant))
      )
      assert.isTrue(variantDigests.every((digest) => digest !== originalDigest))
      assert.strictEqual(new Set(variantDigests).size, variantDigests.length)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("binds every release child and rule snapshot field", () =>
    Effect.gen(function*() {
      const release = releaseRaw()
      const rule = ruleRaw()
      const releaseDigest = yield* digestReleaseReadinessCandidate(decodeRelease(release))
      const ruleDigest = yield* digestReadinessRule(decodeRule(rule))
      const releaseVariants: ReadonlyArray<unknown> = [
        { ...release, workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000321" },
        { ...release, releaseRevision: 8 },
        { ...release, artifactRevision: "git:8a07d42" },
        { ...release, scope: { ...release.scope, releaseId: otherReleaseId } },
        {
          ...release,
          environments: release.environments.map((child, index) =>
            index === 0 ? { ...child, assessmentId: "01890f6f-6d6a-7cc0-98d2-000000000322" } : child
          )
        },
        {
          ...release,
          environments: release.environments.map((child, index) =>
            index === 0 ? { ...child, candidateDigest: `sha256:${"c".repeat(64)}` } : child
          )
        },
        {
          ...release,
          environments: release.environments.map((child, index) =>
            index === 0
              ? { ...child, environmentId: "01890f6f-6d6a-7cc0-98d2-000000000323" }
              : child
          )
        }
      ]
      const ruleVariants: ReadonlyArray<unknown> = [
        { ...rule, ruleId: "delivery-v2" },
        { ...rule, version: 2 },
        {
          ...rule,
          definitions: rule.definitions.map((definition) =>
            definition.factId === "check.integration"
              ? { ...definition, factId: "check.contract" }
              : definition
          )
        },
        {
          ...rule,
          definitions: rule.definitions.map((definition) =>
            definition.factId === "check.integration"
              ? { ...definition, kind: "approval" }
              : definition
          )
        },
        {
          ...rule,
          definitions: rule.definitions.map((definition) =>
            definition.factId === "check.integration"
              ? { ...definition, requirement: "advisory" }
              : definition
          )
        }
      ]

      const releaseDigests = yield* Effect.forEach(releaseVariants, (variant) =>
        digestReleaseReadinessCandidate(decodeRelease(variant)))
      const ruleDigests = yield* Effect.forEach(ruleVariants, (variant) =>
        digestReadinessRule(decodeRule(variant)))
      assert.isTrue(releaseDigests.every((digest) => digest !== releaseDigest))
      assert.isTrue(ruleDigests.every((digest) => digest !== ruleDigest))
    }).pipe(Effect.provide(NodeServices.layer)))

  it("serializes only digest-free normalized material", () => {
    const environment = decodeEnvironment(environmentRaw())
    const rule = decodeRule(ruleRaw())
    const environmentJson = Schema.encodeSync(
      Schema.fromJsonString(EnvironmentReadinessCandidateMaterial)
    )(normalizeEnvironmentReadinessCandidateMaterial(environment))
    const ruleJson = Schema.encodeSync(
      Schema.fromJsonString(ReadinessRuleMaterial)
    )(normalizeReadinessRuleMaterial(rule))

    assert.notInclude(environmentJson, "\"digest\"")
    assert.notInclude(ruleJson, "\"digest\"")
    assert.isBelow(environmentJson.indexOf("build.main"), environmentJson.indexOf("check.integration"))
  })

  it.effect("does not mutate caller-owned arrays while normalizing or hashing", () =>
    Effect.gen(function*() {
      const environment = decodeEnvironment({
        ...environmentRaw(),
        definitions: [...definitions].reverse(),
        observations: [...observations].reverse().map((observation) => ({
          ...observation,
          evidence: [...observation.evidence].reverse()
        }))
      })
      const release = decodeRelease({
        ...releaseRaw(),
        environments: [...releaseRaw().environments].reverse()
      })
      const definitionOrder = environment.definitions.map(({ factId }) => factId)
      const observationOrder = environment.observations.map(({ factId }) => factId)
      const evidenceOrder = environment.observations.map(({ evidence }) => evidence.map(({ evidenceId }) => evidenceId))
      const environmentOrder = release.environments.map(({ environmentId }) => environmentId)

      yield* digestEnvironmentReadinessCandidate(environment)
      yield* digestReleaseReadinessCandidate(release)

      assert.deepEqual(environment.definitions.map(({ factId }) => factId), definitionOrder)
      assert.deepEqual(environment.observations.map(({ factId }) => factId), observationOrder)
      assert.deepEqual(
        environment.observations.map(({ evidence }) => evidence.map(({ evidenceId }) => evidenceId)),
        evidenceOrder
      )
      assert.deepEqual(release.environments.map(({ environmentId }) => environmentId), environmentOrder)
    }).pipe(Effect.provide(NodeServices.layer)))

  it("rejects ambiguous duplicate identities and incomplete V1 policy material", () => {
    const release = releaseRaw()
    assert.throws(() =>
      decodeEnvironment({
        ...environmentRaw(),
        definitions: definitions.slice(1)
      })
    )
    assert.throws(() =>
      decodeRelease({
        ...release,
        environments: [release.environments[0], release.environments[0]]
      })
    )
    assert.throws(() =>
      decodeRule({
        ...ruleRaw(),
        definitions: [...definitions, definitions[0]]
      })
    )
  })
})
