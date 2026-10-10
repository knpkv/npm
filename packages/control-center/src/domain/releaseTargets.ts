import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { EnvironmentId, PluginConnectionId } from "./identifiers.js"
import { UtcTimestamp } from "./utcTimestamp.js"

const text = (maximum: number) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximum)
  )

/** Stable workspace environment key; renaming its display text preserves identity. */
export const ReleaseEnvironmentKey = text(100).check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u))

/** Digest of the ordered stage/action topology reviewed by the operator. */
export const PipelineTopologyDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u))

/** Inclusive stage range assigned to one named environment. */
export const ReleaseEnvironmentRange = Schema.Struct({
  key: ReleaseEnvironmentKey,
  name: text(100),
  firstStage: text(200),
  lastStage: text(200),
  requiresManualGate: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true)))
})
export type ReleaseEnvironmentRange = typeof ReleaseEnvironmentRange.Type

/** Authenticated client-visible pipeline association; no provider ARN or credential is retained. */
export const PipelineReleaseTarget = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  pipelineName: text(200),
  topologyDigest: PipelineTopologyDigest,
  environments: Schema.Array(ReleaseEnvironmentRange).check(Schema.isNonEmpty(), Schema.isMaxLength(50))
})
export type PipelineReleaseTarget = typeof PipelineReleaseTarget.Type

/** Bounded workspace target policy. Legacy omission explicitly means unconfigured. */
export const PipelineReleaseTargets = Schema.Array(PipelineReleaseTarget).check(Schema.isMaxLength(50))

/** Safe stage/action classification used to configure ranges, never raw provider resource locators. */
export const ReleaseTargetPipelineStage = Schema.Struct({
  name: text(200),
  actions: Schema.Array(Schema.Struct({
    name: text(200),
    category: text(100),
    provider: text(100)
  })).check(Schema.isMaxLength(100))
})

/** Persisted followed pipeline topology, scoped to its normalized authenticated connection identity. */
export const ReleaseTargetPipeline = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  displayName: text(200),
  pipelineName: text(200),
  topologyDigest: PipelineTopologyDigest,
  state: Schema.Literals(["current", "stale", "unavailable"]),
  observedAt: Schema.NullOr(UtcTimestamp),
  stages: Schema.Array(ReleaseTargetPipelineStage).check(Schema.isMaxLength(100))
})
export type ReleaseTargetPipeline = typeof ReleaseTargetPipeline.Type

/** Bounded safe catalogue. Incomplete inventories cannot authorize new mappings. */
export const ReleaseTargetCatalog = Schema.Struct({
  complete: Schema.Boolean,
  pipelines: Schema.Array(ReleaseTargetPipeline).check(Schema.isMaxLength(100))
})
export type ReleaseTargetCatalog = typeof ReleaseTargetCatalog.Type

/** Field-addressed configuration failure suitable for an authenticated inline error. */
export class ReleaseTargetConfigurationError extends Schema.TaggedError<ReleaseTargetConfigurationError>()(
  "ReleaseTargetConfigurationError",
  {
    reason: Schema.Literals([
      "unknown-pipeline",
      "unknown-stage",
      "duplicate-pipeline",
      "duplicate-environment",
      "environment-name-conflict",
      "reversed-range",
      "overlapping-range",
      "out-of-order-range",
      "stale-topology",
      "pipeline-unavailable",
      "catalogue-incomplete",
      "too-many-environments"
    ]),
    mappingIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    environmentIndex: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    field: Schema.Literals(["pipelineName", "key", "name", "firstStage", "lastStage"])
  }
) {}

const sameMapping = Schema.toEquivalence(PipelineReleaseTarget)

/** Validate changed mappings against current topology; preserve unchanged policy even when its provider is stale. */
export const validateReleaseTargets = Effect.fn("ReleaseTargets.validate")(function*(
  mappings: ReadonlyArray<PipelineReleaseTarget>,
  catalogue: ReleaseTargetCatalog,
  previousMappings: ReadonlyArray<PipelineReleaseTarget> = []
): Effect.fn.Return<void, ReleaseTargetConfigurationError> {
  const pipelines = new Set<string>()
  const names = new Map<string, string>()
  for (const [mappingIndex, mapping] of mappings.entries()) {
    const fail = (
      reason: ReleaseTargetConfigurationError["reason"],
      field: ReleaseTargetConfigurationError["field"] = "pipelineName",
      environmentIndex: number | null = null
    ) => new ReleaseTargetConfigurationError({ reason, field, mappingIndex, environmentIndex })
    const identity = `${mapping.pluginConnectionId}\u0000${mapping.pipelineName}`
    if (pipelines.has(identity)) return yield* fail("duplicate-pipeline")
    pipelines.add(identity)
    const previous = previousMappings.find((entry) =>
      entry.pluginConnectionId === mapping.pluginConnectionId && entry.pipelineName === mapping.pipelineName
    )
    const unchanged = previous !== undefined && sameMapping(previous, mapping)
    const pipeline = catalogue.pipelines.find((entry) =>
      entry.pluginConnectionId === mapping.pluginConnectionId && entry.pipelineName === mapping.pipelineName
    )
    if (!unchanged) {
      if (!catalogue.complete) return yield* fail("catalogue-incomplete")
      if (pipeline === undefined) return yield* fail("unknown-pipeline")
      if (pipeline.state === "unavailable") return yield* fail("pipeline-unavailable")
      if (pipeline.state !== "current" || pipeline.topologyDigest !== mapping.topologyDigest) {
        return yield* fail("stale-topology")
      }
    }
    const stages = pipeline?.stages.map(({ name }) => name) ?? []
    if (!unchanged && new Set(stages).size !== stages.length) return yield* fail("stale-topology")
    const environments = new Set<string>()
    let previousStart = -1
    let previousEnd = -1
    for (const [environmentIndex, range] of mapping.environments.entries()) {
      if (environments.has(range.key)) return yield* fail("duplicate-environment", "key", environmentIndex)
      environments.add(range.key)
      if (names.has(range.key) && names.get(range.key) !== range.name) {
        return yield* fail("environment-name-conflict", "name", environmentIndex)
      }
      names.set(range.key, range.name)
      if (names.size > 50) return yield* fail("too-many-environments", "key", environmentIndex)
      if (unchanged) continue
      const start = stages.indexOf(range.firstStage)
      const end = stages.indexOf(range.lastStage)
      if (start === -1) return yield* fail("unknown-stage", "firstStage", environmentIndex)
      if (end === -1) return yield* fail("unknown-stage", "lastStage", environmentIndex)
      if (start > end) return yield* fail("reversed-range", "lastStage", environmentIndex)
      if (start < previousStart) return yield* fail("out-of-order-range", "firstStage", environmentIndex)
      if (start <= previousEnd) return yield* fail("overlapping-range", "firstStage", environmentIndex)
      previousStart = start
      previousEnd = end
    }
  }
})

/** Server-owned configuration state, separate from an evaluated readiness assessment. */
export const ReleaseTargetConfiguration = Schema.Struct({
  state: Schema.Literals(["unconfigured", "configured", "stale", "unavailable"]),
  targets: Schema.Array(Schema.Struct({ environmentId: EnvironmentId, key: ReleaseEnvironmentKey, name: text(100) }))
    .check(Schema.isMaxLength(50)),
  verdict: Schema.NullOr(Schema.Literal("held")),
  reason: Schema.NullOr(Schema.Literals(["no-target-environment", "stale-topology", "pipeline-unavailable"]))
})
export type ReleaseTargetConfiguration = typeof ReleaseTargetConfiguration.Type
