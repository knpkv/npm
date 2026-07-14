import * as Config from "effect/Config"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as String from "effect/String"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { arch, availableParallelism, platform, totalmem } from "node:os"

import { UtcTimestamp } from "../src/domain/utcTimestamp.js"
import { BenchmarkReportError } from "./benchmarkErrors.js"
import { CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS } from "./benchmarkFixture.js"
import {
  CONTROL_CENTER_BENCHMARK_CAPS,
  CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS,
  CONTROL_CENTER_BENCHMARK_WARMUP_RUNS,
  ControlCenterBenchmarkCaps,
  ControlCenterBenchmarkMachine,
  ControlCenterBenchmarkTimingSummary,
  summarizeBenchmarkTimingSamples
} from "./benchmarkHarness.js"

/** Stable location written by the real-runtime benchmark command. */
export const CONTROL_CENTER_RUNTIME_BENCHMARK_DEFAULT_OUTPUT = "test-results/control-center/runtime-benchmark.json"

/** Environment variable that can relocate the durable runtime report. */
export const CONTROL_CENTER_RUNTIME_BENCHMARK_OUTPUT_ENV = "CONTROL_CENTER_RUNTIME_BENCHMARK_OUTPUT"

/** Version of the browser-backed runtime report contract. */
export const CONTROL_CENTER_RUNTIME_BENCHMARK_REPORT_VERSION = 1

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))

const RuntimeRequestMeasurement = Schema.Struct({
  requests: Schema.Literal(CONTROL_CENTER_BENCHMARK_WARMUP_RUNS + CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS),
  sampleRuns: Schema.Literal(CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS),
  timing: ControlCenterBenchmarkTimingSummary,
  warmupRuns: Schema.Literal(CONTROL_CENTER_BENCHMARK_WARMUP_RUNS)
})

/** Durable proof that authenticated HTTP/SSE paths ran and every owned resource was released. */
export const ControlCenterRuntimeBenchmarkReport = Schema.Struct({
  caps: ControlCenterBenchmarkCaps,
  cardinalities: Schema.Struct({
    generatedEdges: Schema.Literal(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.edges),
    generatedFiles: Schema.Literal(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.files),
    persistedEntities: Schema.Literal(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.entities),
    persistedEvents: Schema.Literal(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.timelineEvents),
    persistedReleases: Schema.Literal(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases)
  }),
  generatedAt: UtcTimestamp,
  lifecycle: Schema.Struct({
    browserContextsAfterClose: Schema.Literal(0),
    browserContextsPeak: Schema.Literal(CONTROL_CENTER_BENCHMARK_CAPS.browserContexts),
    managedServersAfterDispose: Schema.Literal(0),
    managedServersPeak: Schema.Literal(1)
  }),
  machine: ControlCenterBenchmarkMachine,
  measurements: Schema.Struct({
    freshIngestionMilliseconds: NonNegativeFinite,
    portfolio: RuntimeRequestMeasurement,
    sse: Schema.Struct({
      decodedEvents: Schema.Literal(CONTROL_CENTER_BENCHMARK_CAPS.sseBurstEvents),
      firstCursor: PositiveInteger,
      lastCursor: PositiveInteger,
      ordered: Schema.Literal(true),
      requests: Schema.Literal(CONTROL_CENTER_BENCHMARK_WARMUP_RUNS + CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS),
      sampleRuns: Schema.Literal(CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS),
      timing: ControlCenterBenchmarkTimingSummary,
      warmupRuns: Schema.Literal(CONTROL_CENTER_BENCHMARK_WARMUP_RUNS)
    }).check(
      Schema.makeFilter(
        ({ firstCursor, lastCursor }) => lastCursor - firstCursor + 1 === CONTROL_CENTER_BENCHMARK_CAPS.sseBurstEvents,
        { expected: "one contiguous 500-event SSE replay" }
      )
    )
  }),
  timingIsAcceptanceAssertion: Schema.Literal(false),
  version: Schema.Literal(CONTROL_CENTER_RUNTIME_BENCHMARK_REPORT_VERSION)
}).annotate({ identifier: "ControlCenterRuntimeBenchmarkReport" })

/** Decoded browser-backed runtime report. */
export type ControlCenterRuntimeBenchmarkReport = typeof ControlCenterRuntimeBenchmarkReport.Type

/** Runtime observations needed to construct a schema-verified report. */
export interface MakeControlCenterRuntimeBenchmarkReportInput {
  readonly browserContextsAfterClose: number
  readonly browserContextsPeak: number
  readonly freshIngestionMilliseconds: number
  readonly generatedEdges: number
  readonly generatedFiles: number
  readonly managedServersAfterDispose: number
  readonly managedServersPeak: number
  readonly persistedEntities: number
  readonly persistedEvents: number
  readonly persistedReleases: number
  readonly portfolioHttpRequests: number
  readonly portfolioSamplesMilliseconds: ReadonlyArray<number>
  readonly sseDecodedEvents: number
  readonly sseFirstCursor: number
  readonly sseLastCursor: number
  readonly sseOrdered: boolean
  readonly sseReplayRequests: number
  readonly sseSamplesMilliseconds: ReadonlyArray<number>
}

/** Collect supported machine facts without claiming an unverified storage class. */
export const collectControlCenterBenchmarkMachine = Effect.fn("ControlCenterBenchmark.collectMachine")(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const nodeVersion = yield* spawner.string(ChildProcess.make("node", ["--version"])).pipe(
    Effect.map(String.trim),
    Effect.mapError(() => new BenchmarkReportError({ reason: "Could not read the Node runtime version." }))
  )
  return yield* Schema.decodeUnknownEffect(ControlCenterBenchmarkMachine)({
    architecture: arch(),
    logicalCpuCount: availableParallelism(),
    nodeVersion,
    platform: platform(),
    storageClass: "unverified",
    totalMemoryBytes: totalmem()
  }).pipe(Effect.mapError(() => new BenchmarkReportError({ reason: "Machine metadata failed its result schema." })))
})

/** Build a complete runtime report from server-side metadata and browser timing samples. */
export const makeControlCenterRuntimeBenchmarkReport = Effect.fn("ControlCenterBenchmark.makeRuntimeReport")(function*(
  input: MakeControlCenterRuntimeBenchmarkReportInput
) {
  const machine = yield* collectControlCenterBenchmarkMachine()
  const generatedAt = yield* DateTime.now
  return yield* Schema.decodeUnknownEffect(ControlCenterRuntimeBenchmarkReport)({
    caps: CONTROL_CENTER_BENCHMARK_CAPS,
    cardinalities: {
      generatedEdges: input.generatedEdges,
      generatedFiles: input.generatedFiles,
      persistedEntities: input.persistedEntities,
      persistedEvents: input.persistedEvents,
      persistedReleases: input.persistedReleases
    },
    generatedAt: DateTime.formatIso(generatedAt),
    lifecycle: {
      browserContextsAfterClose: input.browserContextsAfterClose,
      browserContextsPeak: input.browserContextsPeak,
      managedServersAfterDispose: input.managedServersAfterDispose,
      managedServersPeak: input.managedServersPeak
    },
    machine,
    measurements: {
      freshIngestionMilliseconds: input.freshIngestionMilliseconds,
      portfolio: {
        requests: input.portfolioHttpRequests,
        sampleRuns: CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS,
        timing: summarizeBenchmarkTimingSamples(input.portfolioSamplesMilliseconds),
        warmupRuns: CONTROL_CENTER_BENCHMARK_WARMUP_RUNS
      },
      sse: {
        decodedEvents: input.sseDecodedEvents,
        firstCursor: input.sseFirstCursor,
        lastCursor: input.sseLastCursor,
        ordered: input.sseOrdered,
        requests: input.sseReplayRequests,
        sampleRuns: CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS,
        timing: summarizeBenchmarkTimingSamples(input.sseSamplesMilliseconds),
        warmupRuns: CONTROL_CENTER_BENCHMARK_WARMUP_RUNS
      }
    },
    timingIsAcceptanceAssertion: false,
    version: CONTROL_CENTER_RUNTIME_BENCHMARK_REPORT_VERSION
  }).pipe(
    Effect.mapError(() => new BenchmarkReportError({ reason: "Runtime benchmark evidence failed its report schema." }))
  )
})

/** Decode a JSON report and reject missing, pruned, or inconsistent evidence. */
export const decodeControlCenterRuntimeBenchmarkReportJson = (content: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(ControlCenterRuntimeBenchmarkReport))(content).pipe(
    Effect.mapError(
      () => new BenchmarkReportError({ reason: "Runtime benchmark report JSON is invalid or incomplete." })
    )
  )

/** Encode and durably write a runtime report through Effect's filesystem boundary. */
export const writeControlCenterRuntimeBenchmarkReport = Effect.fn("ControlCenterBenchmark.writeRuntimeReport")(
  function*(report: ControlCenterRuntimeBenchmarkReport, outputPath: string) {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const encoded = yield* Schema.encodeEffect(ControlCenterRuntimeBenchmarkReport)(report).pipe(
      Effect.mapError(() => new BenchmarkReportError({ reason: "Runtime benchmark report could not be encoded." }))
    )
    yield* fileSystem
      .makeDirectory(path.dirname(outputPath), { recursive: true })
      .pipe(
        Effect.mapError(
          () => new BenchmarkReportError({ reason: "Runtime benchmark report directory could not be created." })
        )
      )
    yield* fileSystem
      .writeFileString(outputPath, `${JSON.stringify(encoded, undefined, 2)}\n`)
      .pipe(
        Effect.mapError(() => new BenchmarkReportError({ reason: "Runtime benchmark report could not be written." }))
      )
    return outputPath
  }
)

/** Read and decode a durable report, failing when the file is missing or pruned. */
export const readControlCenterRuntimeBenchmarkReport = Effect.fn("ControlCenterBenchmark.readRuntimeReport")(function*(
  outputPath: string
) {
  const fileSystem = yield* FileSystem.FileSystem
  const content = yield* fileSystem
    .readFileString(outputPath)
    .pipe(
      Effect.mapError(() => new BenchmarkReportError({ reason: "Runtime benchmark report is missing or unreadable." }))
    )
  return yield* decodeControlCenterRuntimeBenchmarkReportJson(content)
})

/** Resolve the benchmark output location from configuration with a deterministic default. */
export const controlCenterRuntimeBenchmarkOutputPath = Config.string(CONTROL_CENTER_RUNTIME_BENCHMARK_OUTPUT_ENV).pipe(
  Config.withDefault(CONTROL_CENTER_RUNTIME_BENCHMARK_DEFAULT_OUTPUT)
)
