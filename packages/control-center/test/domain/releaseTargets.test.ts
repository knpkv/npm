import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { PluginConnectionId } from "../../src/domain/identifiers.js"
import { PipelineReleaseTarget, validateReleaseTargets } from "../../src/domain/releaseTargets.js"
import { DEFAULT_WORKSPACE_SETTINGS, WorkspaceSettingsV1 } from "../../src/domain/workspaceSettings.js"

const connectionId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000091")
const mapping = () =>
  Schema.decodeUnknownSync(PipelineReleaseTarget)({
    pluginConnectionId: connectionId,
    pipelineName: "fixture-pipeline",
    topologyDigest: `sha256:${"a".repeat(64)}`,
    environments: [{ key: "staging", name: "Staging", firstStage: "Build", lastStage: "Verify" }]
  })
const catalogue = {
  complete: true,
  pipelines: [{
    pluginConnectionId: connectionId,
    displayName: "Fixture pipeline",
    pipelineName: "fixture-pipeline",
    topologyDigest: `sha256:${"a".repeat(64)}`,
    state: "current",
    observedAt: null,
    stages: ["Build", "Verify", "Approve", "Deploy"].map((name) => ({ name, actions: [] }))
  }]
} satisfies Parameters<typeof validateReleaseTargets>[1]

describe("release target configuration", () => {
  it.effect("keeps legacy omission intact and rejects malformed ranges at the schema boundary", () =>
    Effect.gen(function*() {
      const legacy = yield* Schema.decodeUnknownEffect(WorkspaceSettingsV1)({
        ...DEFAULT_WORKSPACE_SETTINGS,
        pipeline: { retryMode: "manual-only", maximumAttempts: 1 }
      })
      assert.isUndefined(legacy.pipeline.releaseTargets)
      assert.isFalse(
        Schema.is(WorkspaceSettingsV1)({
          ...DEFAULT_WORKSPACE_SETTINGS,
          pipeline: {
            ...DEFAULT_WORKSPACE_SETTINGS.pipeline,
            releaseTargets: [{ ...mapping(), environments: [] }]
          }
        })
      )
    }))
  it.effect("retains explicit ranges in settings and defaults the manual gate to required", () =>
    Effect.gen(function*() {
      const target = mapping()
      assert.strictEqual(target.environments[0]?.requiresManualGate, true)
      const settings = yield* Schema.decodeUnknownEffect(WorkspaceSettingsV1)({
        ...DEFAULT_WORKSPACE_SETTINGS,
        pipeline: { ...DEFAULT_WORKSPACE_SETTINGS.pipeline, releaseTargets: [target] }
      })
      assert.deepStrictEqual(settings.pipeline.releaseTargets, [target])
      yield* validateReleaseTargets([target], catalogue)
    }))

  for (
    const [name, firstStage, lastStage, reason] of [
      ["unknown stage", "Absent", "Verify", "unknown-stage"],
      ["reversed range", "Verify", "Build", "reversed-range"]
    ] satisfies ReadonlyArray<readonly [string, string, string, string]>
  ) {
    it.effect(`rejects ${name} with an inline field location`, () =>
      Effect.gen(function*() {
        const target = mapping()
        const range = target.environments[0]
        assert.isDefined(range)
        if (range === undefined) return
        const failure = yield* Effect.flip(validateReleaseTargets([
          { ...target, environments: [{ ...range, firstStage, lastStage }] }
        ], catalogue))
        assert.strictEqual(failure.reason, reason)
        assert.strictEqual(failure.mappingIndex, 0)
        assert.strictEqual(failure.environmentIndex, 0)
      }))
  }

  it.effect("accepts disjoint adjacent ranges and rejects overlap and reversed environment order", () =>
    Effect.gen(function*() {
      const target = mapping()
      const staging = target.environments[0]
      assert.isDefined(staging)
      if (staging === undefined) return
      const production = {
        ...staging,
        key: "production",
        name: "Production",
        firstStage: "Approve",
        lastStage: "Deploy",
        requiresManualGate: false
      }
      yield* validateReleaseTargets([{ ...target, environments: [staging, production] }], catalogue)
      const overlap = yield* Effect.flip(
        validateReleaseTargets(
          [{ ...target, environments: [staging, { ...production, firstStage: "Verify" }] }],
          catalogue
        )
      )
      assert.strictEqual(overlap.reason, "overlapping-range")
      const reversed = yield* Effect.flip(
        validateReleaseTargets([{ ...target, environments: [production, staging] }], catalogue)
      )
      assert.strictEqual(reversed.reason, "out-of-order-range")
    }))

  it.effect("refuses unknown connections and stale or incomplete topology without enforcing gate policy", () =>
    Effect.gen(function*() {
      const target = mapping()
      assert.strictEqual(
        (yield* Effect.flip(validateReleaseTargets([target], { ...catalogue, pipelines: [] }))).reason,
        "unknown-pipeline"
      )
      assert.strictEqual(
        (yield* Effect.flip(validateReleaseTargets([target], { ...catalogue, complete: false }))).reason,
        "catalogue-incomplete"
      )
      assert.strictEqual(
        (yield* Effect.flip(
          validateReleaseTargets([{ ...target, topologyDigest: `sha256:${"b".repeat(64)}` }], catalogue)
        )).reason,
        "stale-topology"
      )
      // The Build..Verify fixture deliberately has no Approval action; both gate flags are valid settings.
      yield* validateReleaseTargets([target], catalogue)
      const decoded = yield* Schema.decodeUnknownEffect(PipelineReleaseTarget)({
        ...target,
        environments: target.environments.map((range) => ({ ...range, requiresManualGate: false }))
      })
      yield* validateReleaseTargets([decoded], catalogue)
    }))
})
