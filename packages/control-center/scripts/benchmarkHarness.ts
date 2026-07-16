import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import { PortfolioSnapshot } from "../src/api/portfolio.js"
import { UtcTimestamp } from "../src/domain/utcTimestamp.js"
import { DEFAULT_MAXIMUM_LIVE_STREAMS } from "../src/server/api/LiveStreamAdmission.js"
import { LIVE_EVENT_PAGE_SIZE, MAXIMUM_LIVE_EVENT_REPLAY_EVENTS } from "../src/server/application/liveEvents.js"
import { MAXIMUM_DOMAIN_EVENT_PAGE_SIZE } from "../src/server/persistence/repositories/domainEventModels.js"
import { DOMAIN_EVENT_WAKEUP_CAPACITY } from "../src/server/runtime/DomainEventWakeups.js"
import { BenchmarkInvariantError } from "./benchmarkErrors.js"
import {
  CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS,
  CONTROL_CENTER_BENCHMARK_FIXTURE_SEED,
  CONTROL_CENTER_BENCHMARK_FIXTURE_VERSION,
  type ControlCenterBenchmarkFixture,
  generateControlCenterBenchmarkFixture,
  makeBenchmarkPortfolioSnapshot
} from "./benchmarkFixture.js"

/** Version of the machine-readable benchmark result contract. */
export const CONTROL_CENTER_BENCHMARK_REPORT_VERSION = 1

/** Warmup executions excluded from every reported timing distribution. */
export const CONTROL_CENTER_BENCHMARK_WARMUP_RUNS = 1

/** Post-warmup executions included in every median and p95 distribution. */
export const CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS = 5

/** Explicit workload and queue limits asserted by the first benchmark harness. */
export const CONTROL_CENTER_BENCHMARK_CAPS = Object.freeze({
  browserContexts: 1,
  diffInventoryPageSize: 500,
  ingestionPageSize: 500,
  liveEventPageSize: LIVE_EVENT_PAGE_SIZE,
  liveEventReplayEvents: MAXIMUM_LIVE_EVENT_REPLAY_EVENTS,
  liveStreamsPerProcess: DEFAULT_MAXIMUM_LIVE_STREAMS,
  portfolioReleases: 200,
  sseBurstEvents: 500,
  wakeupQueue: DOMAIN_EVENT_WAKEUP_CAPACITY
})

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const BenchmarkOperationName = Schema.Literals([
  "fixture.generated-materialization",
  "portfolio.contract-serialization",
  "sse.contract-serialization"
])

const percentile = (samples: ReadonlyArray<number>, ratio: number): number => {
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  return sorted[index] ?? 0
}

const PostWarmupSamples = Schema.Array(NonNegativeFinite).check(
  Schema.makeFilter((samples) => samples.length === CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS, {
    expected: `exactly ${CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS} post-warmup samples`
  })
)

/** One exact post-warmup timing distribution whose aggregates are schema-verified. */
export const ControlCenterBenchmarkTimingSummary = Schema.Struct({
  medianMilliseconds: NonNegativeFinite,
  p95Milliseconds: NonNegativeFinite,
  samplesMilliseconds: PostWarmupSamples
})
  .check(
    Schema.makeFilter(
      ({ medianMilliseconds, samplesMilliseconds }) => medianMilliseconds === percentile(samplesMilliseconds, 0.5),
      { expected: "median derived from the exact post-warmup samples" }
    ),
    Schema.makeFilter(
      ({ p95Milliseconds, samplesMilliseconds }) => p95Milliseconds === percentile(samplesMilliseconds, 0.95),
      { expected: "p95 derived from the exact post-warmup samples" }
    )
  )
  .annotate({ identifier: "ControlCenterBenchmarkTimingSummary" })

/** Decoded timing summary shared by contract and real-runtime reports. */
export type ControlCenterBenchmarkTimingSummary = typeof ControlCenterBenchmarkTimingSummary.Type

/** Derive median and p95 from exactly five post-warmup samples without a timing threshold. */
export const summarizeBenchmarkTimingSamples = (
  samplesMilliseconds: ReadonlyArray<number>
): ControlCenterBenchmarkTimingSummary =>
  Schema.decodeUnknownSync(ControlCenterBenchmarkTimingSummary)({
    medianMilliseconds: percentile(samplesMilliseconds, 0.5),
    p95Milliseconds: percentile(samplesMilliseconds, 0.95),
    samplesMilliseconds
  })

/** Supported-machine facts captured without claiming an unverified storage class. */
export const ControlCenterBenchmarkMachine = Schema.Struct({
  architecture: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)),
  logicalCpuCount: PositiveInteger,
  nodeVersion: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)),
  platform: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)),
  storageClass: Schema.Literal("unverified"),
  totalMemoryBytes: PositiveInteger
}).annotate({ identifier: "ControlCenterBenchmarkMachine" })

/** Decoded machine metadata carried by every benchmark report. */
export type ControlCenterBenchmarkMachine = typeof ControlCenterBenchmarkMachine.Type

const BenchmarkOperationOutcome = Schema.Struct({
  batchCount: PositiveInteger,
  maximumBatchSize: PositiveInteger,
  processedCount: PositiveInteger,
  serializedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

/** Hard-bound processing facts produced alongside timing samples. */
export type BenchmarkOperationOutcome = typeof BenchmarkOperationOutcome.Type

const BenchmarkMeasurement = Schema.Struct({
  batchCap: PositiveInteger,
  batchCount: PositiveInteger,
  maximumBatchSize: PositiveInteger,
  medianMilliseconds: NonNegativeFinite,
  name: BenchmarkOperationName,
  p95Milliseconds: NonNegativeFinite,
  processedCount: PositiveInteger,
  samplesMilliseconds: PostWarmupSamples,
  serializedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  timingIsAcceptanceAssertion: Schema.Literal(false),
  warmupRuns: Schema.Literal(CONTROL_CENTER_BENCHMARK_WARMUP_RUNS)
})

/** One honest timing distribution plus hard correctness and bounds evidence. */
export type BenchmarkMeasurement = typeof BenchmarkMeasurement.Type

export const ControlCenterBenchmarkFixtureCounts = Schema.Struct({
  edges: Schema.Literal(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.edges),
  entities: Schema.Literal(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.entities),
  files: Schema.Literal(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.files),
  releases: Schema.Literal(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases),
  timelineEvents: Schema.Literal(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.timelineEvents)
})

export const ControlCenterBenchmarkCaps = Schema.Struct({
  browserContexts: Schema.Literal(CONTROL_CENTER_BENCHMARK_CAPS.browserContexts),
  diffInventoryPageSize: Schema.Literal(CONTROL_CENTER_BENCHMARK_CAPS.diffInventoryPageSize),
  ingestionPageSize: Schema.Literal(CONTROL_CENTER_BENCHMARK_CAPS.ingestionPageSize),
  liveEventPageSize: Schema.Literal(CONTROL_CENTER_BENCHMARK_CAPS.liveEventPageSize),
  liveEventReplayEvents: Schema.Literal(CONTROL_CENTER_BENCHMARK_CAPS.liveEventReplayEvents),
  liveStreamsPerProcess: Schema.Literal(CONTROL_CENTER_BENCHMARK_CAPS.liveStreamsPerProcess),
  portfolioReleases: Schema.Literal(CONTROL_CENTER_BENCHMARK_CAPS.portfolioReleases),
  sseBurstEvents: Schema.Literal(CONTROL_CENTER_BENCHMARK_CAPS.sseBurstEvents),
  wakeupQueue: Schema.Literal(CONTROL_CENTER_BENCHMARK_CAPS.wakeupQueue)
})

/** Machine-readable result schema for benchmark history and later milestone extensions. */
export const ControlCenterBenchmarkReport = Schema.Struct({
  caps: ControlCenterBenchmarkCaps,
  fixture: Schema.Struct({
    counts: ControlCenterBenchmarkFixtureCounts,
    seed: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)),
    version: Schema.Literal(CONTROL_CENTER_BENCHMARK_FIXTURE_VERSION)
  }),
  generatedAt: UtcTimestamp,
  machine: ControlCenterBenchmarkMachine,
  measurements: Schema.Array(BenchmarkMeasurement).check(
    Schema.makeFilter((measurements) => measurements.length === 3, {
      expected: "exactly the generated fixture, portfolio-contract, and SSE-contract measurements"
    }),
    Schema.makeFilter((measurements) => new Set(measurements.map(({ name }) => name)).size === measurements.length, {
      expected: "unique benchmark operation names"
    })
  ),
  sampleRuns: Schema.Literal(CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS),
  version: Schema.Literal(CONTROL_CENTER_BENCHMARK_REPORT_VERSION),
  warmupRuns: Schema.Literal(CONTROL_CENTER_BENCHMARK_WARMUP_RUNS)
}).annotate({ identifier: "ControlCenterBenchmarkReport" })

/** Decoded result emitted by the benchmark command. */
export type ControlCenterBenchmarkReport = typeof ControlCenterBenchmarkReport.Type

interface BoundedBatchSummary {
  readonly batchCount: number
  readonly maximumBatchSize: number
  readonly processedCount: number
}

interface BenchmarkOperation {
  readonly batchCap: number
  readonly name: typeof BenchmarkOperationName.Type
  readonly run: () => BenchmarkOperationOutcome
}

interface MeasuredOperation {
  readonly durationMilliseconds: number
  readonly outcome: BenchmarkOperationOutcome
}

/** Inputs needed to run the source harness without hiding environment facts. */
export interface RunControlCenterBenchmarkInput {
  readonly machine: ControlCenterBenchmarkMachine
  readonly seed?: string
}

const boundedBatchSummary = (lengths: ReadonlyArray<number>, cap: number): BoundedBatchSummary => {
  if (cap <= 0 || lengths.some((length) => length < 0 || length > cap)) {
    throw new BenchmarkInvariantError({ reason: `A benchmark batch exceeded its ${cap}-record cap.` })
  }
  return {
    batchCount: lengths.length,
    maximumBatchSize: Math.max(...lengths),
    processedCount: lengths.reduce((total, length) => total + length, 0)
  }
}

const pageLengths = (total: number, pageSize: number): ReadonlyArray<number> => {
  const fullPages = Math.floor(total / pageSize)
  const remainder = total % pageSize
  return [...Array.from({ length: fullPages }, () => pageSize), ...(remainder === 0 ? [] : [remainder])]
}

/** Materialize the generated fixture through explicitly bounded in-memory pages. */
export const prepareGeneratedFixtureMaterialization = (
  fixture: ControlCenterBenchmarkFixture
): BenchmarkOperationOutcome => {
  const cap = CONTROL_CENTER_BENCHMARK_CAPS.ingestionPageSize
  const lengths = [
    ...pageLengths(fixture.releases.length, cap),
    ...pageLengths(fixture.entities.length, cap),
    ...pageLengths(fixture.edges.length, cap),
    ...pageLengths(fixture.files.length, cap),
    ...pageLengths(fixture.timelineEvents.length, cap)
  ]
  const summary = boundedBatchSummary(lengths, cap)
  const identities = new Set([
    ...fixture.releases.map(({ id }) => id),
    ...fixture.entities.map(({ id }) => id),
    ...fixture.edges.map(({ id }) => id),
    ...fixture.files.map(({ path }) => path),
    ...fixture.timelineEvents.map(({ cursor }) => `event:${cursor}`)
  ])
  if (identities.size !== summary.processedCount) {
    throw new BenchmarkInvariantError({ reason: "The generated ingestion fixture contains duplicate identities." })
  }
  return {
    ...summary,
    serializedBytes: JSON.stringify(fixture).length
  }
}

/** Serialize the 100-release projection through the portfolio contract without claiming runtime I/O. */
export const preparePortfolioContractSerialization = (
  fixture: ControlCenterBenchmarkFixture
): BenchmarkOperationOutcome => {
  const snapshot = makeBenchmarkPortfolioSnapshot(fixture)
  if (snapshot.releases.length > CONTROL_CENTER_BENCHMARK_CAPS.portfolioReleases) {
    throw new BenchmarkInvariantError({ reason: "The benchmark portfolio exceeded its release response cap." })
  }
  const encoded = Schema.encodeSync(PortfolioSnapshot)(snapshot)
  return {
    batchCount: 1,
    maximumBatchSize: snapshot.releases.length,
    processedCount: snapshot.releases.length,
    serializedBytes: JSON.stringify(encoded).length
  }
}

/** Serialize 500 generated events in the SSE page shape without claiming a network replay. */
export const prepareSseContractSerialization = (fixture: ControlCenterBenchmarkFixture): BenchmarkOperationOutcome => {
  if (MAXIMUM_DOMAIN_EVENT_PAGE_SIZE !== CONTROL_CENTER_BENCHMARK_CAPS.liveEventPageSize) {
    throw new BenchmarkInvariantError({ reason: "Repository and SSE page caps have diverged." })
  }
  if (CONTROL_CENTER_BENCHMARK_CAPS.sseBurstEvents > CONTROL_CENTER_BENCHMARK_CAPS.liveEventReplayEvents) {
    throw new BenchmarkInvariantError({ reason: "The reference SSE burst exceeds the reset-before-replay budget." })
  }
  const burst = fixture.timelineEvents.slice(-CONTROL_CENTER_BENCHMARK_CAPS.sseBurstEvents)
  const lengths = pageLengths(burst.length, CONTROL_CENTER_BENCHMARK_CAPS.liveEventPageSize)
  const summary = boundedBatchSummary(lengths, CONTROL_CENTER_BENCHMARK_CAPS.liveEventPageSize)
  const serializedBytes = burst.reduce(
    (total, event) =>
      total + `id: ${event.cursor}\nevent: portfolio.invalidated\ndata: ${JSON.stringify(event)}\n\n`.length,
    0
  )
  return { ...summary, serializedBytes }
}

/** Summarize five post-warmup samples without enforcing machine-sensitive timing budgets. */
export const summarizeBenchmarkSamples = (
  operation: Pick<BenchmarkOperation, "batchCap" | "name">,
  outcome: BenchmarkOperationOutcome,
  samplesMilliseconds: ReadonlyArray<number>
): BenchmarkMeasurement =>
  Schema.decodeUnknownSync(BenchmarkMeasurement)({
    ...summarizeBenchmarkTimingSamples(samplesMilliseconds),
    batchCap: operation.batchCap,
    batchCount: outcome.batchCount,
    maximumBatchSize: outcome.maximumBatchSize,
    name: operation.name,
    processedCount: outcome.processedCount,
    serializedBytes: outcome.serializedBytes,
    timingIsAcceptanceAssertion: false,
    warmupRuns: CONTROL_CENTER_BENCHMARK_WARMUP_RUNS
  })

const measureOperation = Effect.fn("ControlCenterBenchmark.measureOperation")(function*(
  operation: BenchmarkOperation
): Effect.fn.Return<MeasuredOperation, BenchmarkInvariantError> {
  const startedAt = yield* Clock.currentTimeNanos
  const outcome = yield* Effect.try({
    try: operation.run,
    catch: (cause) =>
      Predicate.isTagged(cause, "BenchmarkInvariantError") &&
        Predicate.hasProperty(cause, "reason") &&
        Predicate.isString(cause.reason)
        ? new BenchmarkInvariantError({ reason: cause.reason })
        : new BenchmarkInvariantError({ reason: `Benchmark operation ${operation.name} failed.` })
  })
  const completedAt = yield* Clock.currentTimeNanos
  return {
    durationMilliseconds: Number(completedAt - startedAt) / 1_000_000,
    outcome
  }
})

const runOperation = Effect.fn("ControlCenterBenchmark.runOperation")(function*(
  operation: BenchmarkOperation
): Effect.fn.Return<BenchmarkMeasurement, BenchmarkInvariantError> {
  for (let index = 0; index < CONTROL_CENTER_BENCHMARK_WARMUP_RUNS; index += 1) {
    yield* measureOperation(operation)
  }
  const measured = yield* Effect.forEach(
    Array.from({ length: CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS }),
    () => measureOperation(operation),
    { concurrency: 1 }
  )
  const outcome = measured[0]?.outcome
  if (outcome === undefined) {
    return yield* new BenchmarkInvariantError({ reason: `Benchmark operation ${operation.name} had no samples.` })
  }
  return summarizeBenchmarkSamples(
    operation,
    outcome,
    measured.map(({ durationMilliseconds }) => durationMilliseconds)
  )
})

/** Run generated contract-shape measurements; runtime I/O evidence is owned by the bounded Playwright command. */
export const runControlCenterBenchmark = Effect.fn("runControlCenterBenchmark")(function*(
  input: RunControlCenterBenchmarkInput
): Effect.fn.Return<ControlCenterBenchmarkReport, BenchmarkInvariantError> {
  const fixture = yield* Effect.try({
    try: () => generateControlCenterBenchmarkFixture(input.seed ?? CONTROL_CENTER_BENCHMARK_FIXTURE_SEED),
    catch: (cause) =>
      Predicate.isTagged(cause, "BenchmarkInvariantError") &&
        Predicate.hasProperty(cause, "reason") &&
        Predicate.isString(cause.reason)
        ? new BenchmarkInvariantError({ reason: cause.reason })
        : new BenchmarkInvariantError({ reason: "The benchmark fixture could not be generated." })
  })
  const operations: ReadonlyArray<BenchmarkOperation> = [
    {
      batchCap: CONTROL_CENTER_BENCHMARK_CAPS.ingestionPageSize,
      name: "fixture.generated-materialization",
      run: () => prepareGeneratedFixtureMaterialization(fixture)
    },
    {
      batchCap: CONTROL_CENTER_BENCHMARK_CAPS.portfolioReleases,
      name: "portfolio.contract-serialization",
      run: () => preparePortfolioContractSerialization(fixture)
    },
    {
      batchCap: CONTROL_CENTER_BENCHMARK_CAPS.liveEventPageSize,
      name: "sse.contract-serialization",
      run: () => prepareSseContractSerialization(fixture)
    }
  ]
  const measurements = yield* Effect.forEach(operations, runOperation, { concurrency: 1 })
  const generatedAt = yield* DateTime.now
  return yield* Schema.decodeUnknownEffect(ControlCenterBenchmarkReport)({
    caps: CONTROL_CENTER_BENCHMARK_CAPS,
    fixture: {
      counts: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS,
      seed: fixture.seed,
      version: fixture.version
    },
    generatedAt: DateTime.formatIso(generatedAt),
    machine: input.machine,
    measurements,
    sampleRuns: CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS,
    version: CONTROL_CENTER_BENCHMARK_REPORT_VERSION,
    warmupRuns: CONTROL_CENTER_BENCHMARK_WARMUP_RUNS
  }).pipe(
    Effect.mapError(() => new BenchmarkInvariantError({ reason: "The benchmark report failed its result schema." }))
  )
})
