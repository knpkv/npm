import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { PortfolioSnapshot } from "../src/api/portfolio.js"
import { ReleaseId } from "../src/domain/identifiers.js"
import { deriveReleaseRelay } from "../src/domain/releaseRelay.js"
import { BenchmarkInvariantError } from "./benchmarkErrors.js"

/** Version of the deterministic fixture contract extended by later milestones. */
export const CONTROL_CENTER_BENCHMARK_FIXTURE_VERSION = 1

/** Required cardinalities for the reference Control Center benchmark fixture. */
export const CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS = Object.freeze({
  edges: 10_000,
  entities: 2_000,
  files: 500,
  releases: 100,
  timelineEvents: 20_000
})

/** Stable seed used by the supported reference benchmark. */
export const CONTROL_CENTER_BENCHMARK_FIXTURE_SEED = "control-center-large-v1"

const MAXIMUM_SEED_LENGTH = 100
const FIXED_TIMESTAMP = "2026-07-14T10:00:00.000Z"
const WORKSPACE_ID = "01890f6f-6d6a-7cc0-98d2-000000009001"
const PLUGIN_CONNECTION_ID = "01890f6f-6d6a-7cc0-98d2-000000009002"
const ENVIRONMENT_ID = "01890f6f-6d6a-7cc0-98d2-000000009003"
const BenchmarkSeed = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAXIMUM_SEED_LENGTH)
)

const decodeBenchmarkSeed = (seed: string): string => {
  const decoded = Schema.decodeUnknownResult(BenchmarkSeed)(seed)
  if (Result.isFailure(decoded)) {
    throw new BenchmarkInvariantError({
      reason: `Benchmark seed must be trimmed, non-empty, and at most ${MAXIMUM_SEED_LENGTH} characters.`
    })
  }
  return decoded.success
}

const boundedArray = <Value, Encoded, Requirements, EncodedRequirements>(
  schema: Schema.Codec<Value, Encoded, Requirements, EncodedRequirements>,
  expectedLength: number,
  label: string
) =>
  Schema.Array(schema).check(
    Schema.makeFilter((values) => values.length === expectedLength, {
      expected: `exactly ${expectedLength} ${label}`
    })
  )

const BenchmarkRelease = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
  ordinal: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 99 })),
  serviceName: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  version: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100))
})

/** One deterministic release seed record used to construct real portfolio summaries. */
export type BenchmarkRelease = typeof BenchmarkRelease.Type

const BenchmarkEntity = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
  kind: Schema.Literals(["deployment", "issue", "page", "pipeline", "pull-request"]),
  ordinal: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_999 })),
  releaseId: BenchmarkRelease.fields.id
})

/** One provider-neutral entity in the large deterministic fixture. */
export type BenchmarkEntity = typeof BenchmarkEntity.Type

const BenchmarkEdge = Schema.Struct({
  fromEntityId: BenchmarkEntity.fields.id,
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
  kind: Schema.Literals(["evidence", "relationship"]),
  ordinal: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9_999 })),
  toEntityId: BenchmarkEntity.fields.id
})

/** One relationship or evidence claim joining two fixture entities. */
export type BenchmarkEdge = typeof BenchmarkEdge.Type

const BenchmarkFile = Schema.Struct({
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ordinal: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 499 })),
  path: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  status: Schema.Literals(["added", "deleted", "modified", "renamed"])
})

/** One file in the complete 500-file pull-request inventory. */
export type BenchmarkFile = typeof BenchmarkFile.Type

const BenchmarkTimelineEvent = Schema.Struct({
  cursor: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20_000 })),
  kind: Schema.Literals(["entity-updated", "release-updated", "relationship-updated"]),
  releaseId: BenchmarkRelease.fields.id
})

/** One durable-order timeline fact in the reference journal. */
export type BenchmarkTimelineEvent = typeof BenchmarkTimelineEvent.Type

/** Schema for the deterministic fixture shared by every performance milestone. */
export const ControlCenterBenchmarkFixture = Schema.Struct({
  edges: boundedArray(BenchmarkEdge, CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.edges, "edges"),
  entities: boundedArray(BenchmarkEntity, CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.entities, "entities"),
  files: boundedArray(BenchmarkFile, CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.files, "files"),
  releases: boundedArray(BenchmarkRelease, CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases, "releases"),
  seed: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(MAXIMUM_SEED_LENGTH)),
  timelineEvents: boundedArray(
    BenchmarkTimelineEvent,
    CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.timelineEvents,
    "timeline events"
  ),
  version: Schema.Literal(CONTROL_CENTER_BENCHMARK_FIXTURE_VERSION)
}).annotate({ identifier: "ControlCenterBenchmarkFixture" })

/** Decoded deterministic reference fixture. */
export type ControlCenterBenchmarkFixture = typeof ControlCenterBenchmarkFixture.Type

const seedHash = (seed: string): number => {
  const validSeed = decodeBenchmarkSeed(seed)
  let hash = 0x81_1c_9d_c5
  for (const character of validSeed) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0
  }
  return hash
}

const paddedHex = (value: number, length: number): string =>
  (value >>> 0).toString(16).padStart(length, "0").slice(-length)

const fixtureId = (seed: string, namespace: string, ordinal: number): string =>
  `benchmark-${namespace}-${paddedHex(seedHash(seed), 8)}-${String(ordinal).padStart(6, "0")}`

const releaseUuid = (seed: string, ordinal: number): string => {
  const hash = paddedHex(seedHash(seed), 8)
  return `01890f6f-${hash.slice(0, 4)}-7${hash.slice(4, 7)}-8${paddedHex(ordinal, 3)}-${
    paddedHex(ordinal + 1, 8).padStart(12, "0")
  }`
}

const entityKind = (ordinal: number): BenchmarkEntity["kind"] => {
  switch (ordinal % 5) {
    case 0:
      return "issue"
    case 1:
      return "pull-request"
    case 2:
      return "page"
    case 3:
      return "pipeline"
    default:
      return "deployment"
  }
}

const fileStatus = (ordinal: number): BenchmarkFile["status"] => {
  switch (ordinal % 4) {
    case 0:
      return "added"
    case 1:
      return "modified"
    case 2:
      return "deleted"
    default:
      return "renamed"
  }
}

const timelineKind = (ordinal: number): BenchmarkTimelineEvent["kind"] => {
  switch (ordinal % 3) {
    case 0:
      return "release-updated"
    case 1:
      return "entity-updated"
    default:
      return "relationship-updated"
  }
}

/** Generate the stable 100-release input without time or randomness dependencies. */
export const generateBenchmarkReleases = (
  seed: string = CONTROL_CENTER_BENCHMARK_FIXTURE_SEED
): ReadonlyArray<BenchmarkRelease> =>
  Schema.decodeUnknownSync(ControlCenterBenchmarkFixture.fields.releases)(
    Array.from({ length: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases }, (_, ordinal) => ({
      id: releaseUuid(seed, ordinal),
      ordinal,
      serviceName: `service-${String(ordinal + 1).padStart(3, "0")}`,
      version: `1.${Math.floor(ordinal / 10)}.${ordinal % 10}`
    }))
  )

/** Generate 2,000 entities distributed evenly across the reference releases. */
export const generateBenchmarkEntities = (
  seed: string = CONTROL_CENTER_BENCHMARK_FIXTURE_SEED
): ReadonlyArray<BenchmarkEntity> =>
  Schema.decodeUnknownSync(ControlCenterBenchmarkFixture.fields.entities)(
    Array.from({ length: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.entities }, (_, ordinal) => ({
      id: fixtureId(seed, "entity", ordinal),
      kind: entityKind(ordinal),
      ordinal,
      releaseId: releaseUuid(seed, ordinal % CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases)
    }))
  )

/** Generate 10,000 deterministic relationship and evidence edges. */
export const generateBenchmarkEdges = (
  seed: string = CONTROL_CENTER_BENCHMARK_FIXTURE_SEED
): ReadonlyArray<BenchmarkEdge> =>
  Schema.decodeUnknownSync(ControlCenterBenchmarkFixture.fields.edges)(
    Array.from({ length: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.edges }, (_, ordinal) => ({
      fromEntityId: fixtureId(seed, "entity", ordinal % CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.entities),
      id: fixtureId(seed, "edge", ordinal),
      kind: ordinal % 2 === 0 ? "relationship" : "evidence",
      ordinal,
      toEntityId: fixtureId(
        seed,
        "entity",
        (ordinal * 37 + 17) % CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.entities
      )
    }))
  )

/** Generate the complete deterministic 500-file pull-request inventory. */
export const generateBenchmarkFiles = (
  seed: string = CONTROL_CENTER_BENCHMARK_FIXTURE_SEED
): ReadonlyArray<BenchmarkFile> =>
  Schema.decodeUnknownSync(ControlCenterBenchmarkFixture.fields.files)(
    Array.from({ length: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.files }, (_, ordinal) => ({
      byteLength: 128 + ((ordinal * 97) % 65_536),
      ordinal,
      path: `src/${paddedHex(seedHash(seed), 8)}/feature-${String(Math.floor(ordinal / 10)).padStart(2, "0")}/file-${
        String(ordinal).padStart(3, "0")
      }.ts`,
      status: fileStatus(ordinal)
    }))
  )

/** Generate the ordered 20,000-event timeline journal. */
export const generateBenchmarkTimelineEvents = (
  seed: string = CONTROL_CENTER_BENCHMARK_FIXTURE_SEED
): ReadonlyArray<BenchmarkTimelineEvent> =>
  Schema.decodeUnknownSync(ControlCenterBenchmarkFixture.fields.timelineEvents)(
    Array.from({ length: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.timelineEvents }, (_, ordinal) => ({
      cursor: ordinal + 1,
      kind: timelineKind(ordinal),
      releaseId: releaseUuid(seed, ordinal % CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases)
    }))
  )

/** Build and validate the complete large fixture from one explicit seed. */
export const generateControlCenterBenchmarkFixture = (
  seed: string = CONTROL_CENTER_BENCHMARK_FIXTURE_SEED
): ControlCenterBenchmarkFixture => {
  const validSeed = decodeBenchmarkSeed(seed)
  return (
    Schema.decodeUnknownSync(ControlCenterBenchmarkFixture)({
      edges: generateBenchmarkEdges(validSeed),
      entities: generateBenchmarkEntities(validSeed),
      files: generateBenchmarkFiles(validSeed),
      releases: generateBenchmarkReleases(validSeed),
      seed: validSeed,
      timelineEvents: generateBenchmarkTimelineEvents(validSeed),
      version: CONTROL_CENTER_BENCHMARK_FIXTURE_VERSION
    })
  )
}

/** Project the release slice through the real authenticated portfolio response schema. */
export const makeBenchmarkPortfolioSnapshot = (
  fixture: ControlCenterBenchmarkFixture
): typeof PortfolioSnapshot.Type =>
  Schema.decodeUnknownSync(PortfolioSnapshot)({
    eventCursor: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.timelineEvents,
    generatedAt: FIXED_TIMESTAMP,
    plugins: [{
      displayName: "Benchmark source",
      health: { _tag: "healthy", checkedAt: FIXED_TIMESTAMP },
      isEnabled: true,
      pluginConnectionId: PLUGIN_CONNECTION_ID,
      providerId: "jira",
      updatedAt: FIXED_TIMESTAMP
    }],
    releases: fixture.releases.map((release) => {
      const releaseId = Schema.decodeSync(ReleaseId)(release.id)
      return {
        collaboratorCount: 0,
        collaborators: [],
        freshness: {
          _tag: "missing",
          pluginHealth: { _tag: "healthy", checkedAt: FIXED_TIMESTAMP },
          provenance: { _tag: "none", pluginConnectionId: PLUGIN_CONNECTION_ID },
          sourceObservedAt: null,
          staleAfterSeconds: 300,
          synchronizedAt: FIXED_TIMESTAMP
        },
        lifecycle: "candidate",
        readiness: null,
        relay: deriveReleaseRelay(releaseId),
        relationships: {
          issues: 0,
          pipelineExecutions: 0,
          pullRequests: 0,
          truncated: false
        },
        releaseId,
        serviceName: release.serviceName,
        sourceRevisionCount: 1,
        targetEnvironmentIds: [ENVIRONMENT_ID],
        updatedAt: FIXED_TIMESTAMP,
        version: release.version
      }
    }),
    workspaceId: WORKSPACE_ID
  })
