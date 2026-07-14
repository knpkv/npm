import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

import { CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS } from "../../scripts/benchmarkFixture.js"
import {
  CONTROL_CENTER_BENCHMARK_CAPS,
  ControlCenterBenchmarkMachine,
  summarizeBenchmarkTimingSamples
} from "../../scripts/benchmarkHarness.js"
import {
  CONTROL_CENTER_RUNTIME_BENCHMARK_DEFAULT_OUTPUT,
  CONTROL_CENTER_RUNTIME_BENCHMARK_REPORT_VERSION,
  ControlCenterRuntimeBenchmarkReport,
  decodeControlCenterRuntimeBenchmarkReportJson,
  readControlCenterRuntimeBenchmarkReport
} from "../../scripts/benchmarkRuntimeReport.js"

const machine = Schema.decodeUnknownSync(ControlCenterBenchmarkMachine)({
  architecture: "x64",
  logicalCpuCount: 4,
  nodeVersion: "v24.0.0",
  platform: "linux",
  storageClass: "unverified",
  totalMemoryBytes: 8 * 1_024 * 1_024 * 1_024
})

const samples = [11, 7, 13, 5, 9]

const validReportInput = () => ({
  caps: CONTROL_CENTER_BENCHMARK_CAPS,
  cardinalities: {
    generatedEdges: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.edges,
    generatedFiles: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.files,
    persistedEntities: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.entities,
    persistedEvents: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.timelineEvents,
    persistedReleases: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases
  },
  generatedAt: "2026-07-14T10:00:00.000Z",
  lifecycle: {
    browserContextsAfterClose: 0,
    browserContextsPeak: 1,
    managedServersAfterDispose: 0,
    managedServersPeak: 1
  },
  machine,
  measurements: {
    freshIngestionMilliseconds: 321,
    portfolio: {
      requests: 6,
      sampleRuns: 5,
      timing: summarizeBenchmarkTimingSamples(samples),
      warmupRuns: 1
    },
    sse: {
      decodedEvents: 500,
      firstCursor: 19_501,
      lastCursor: 20_000,
      ordered: true,
      requests: 6,
      sampleRuns: 5,
      timing: summarizeBenchmarkTimingSamples(samples),
      warmupRuns: 1
    }
  },
  timingIsAcceptanceAssertion: false,
  version: CONTROL_CENTER_RUNTIME_BENCHMARK_REPORT_VERSION
})

const decodeResult = (input: unknown) =>
  Effect.runPromise(decodeControlCenterRuntimeBenchmarkReportJson(JSON.stringify(input)).pipe(Effect.result))

describe("control center runtime benchmark report", () => {
  it("decodes exact-five samples with correctly derived median and p95", async () => {
    const report = await Effect.runPromise(
      decodeControlCenterRuntimeBenchmarkReportJson(JSON.stringify(validReportInput()))
    )

    expect(report.machine.logicalCpuCount).toBe(4)
    expect(report.measurements.portfolio.timing.samplesMilliseconds).toHaveLength(5)
    expect(report.measurements.portfolio.timing.medianMilliseconds).toBe(9)
    expect(report.measurements.portfolio.timing.p95Milliseconds).toBe(13)
    expect(report.measurements.sse.timing.medianMilliseconds).toBe(9)
    expect(report.measurements.sse.timing.p95Milliseconds).toBe(13)
    expect(report.timingIsAcceptanceAssertion).toBe(false)
  })

  it("rejects reports with missing machine or timing aggregates", async () => {
    const valid = validReportInput()
    const { machine: _machine, ...missingMachine } = valid
    const { medianMilliseconds: _median, ...missingMedianTiming } = valid.measurements.portfolio.timing
    const { p95Milliseconds: _p95, ...missingP95Timing } = valid.measurements.sse.timing
    const missingMedian = {
      ...valid,
      measurements: {
        ...valid.measurements,
        portfolio: {
          ...valid.measurements.portfolio,
          timing: missingMedianTiming
        }
      }
    }
    const missingP95 = {
      ...valid,
      measurements: {
        ...valid.measurements,
        sse: {
          ...valid.measurements.sse,
          timing: missingP95Timing
        }
      }
    }

    for (const invalid of [missingMachine, missingMedian, missingP95]) {
      expect(Result.isFailure(await decodeResult(invalid))).toBe(true)
    }
  })

  it("rejects a pruned JSON report and a missing report file", async () => {
    const pruned = await Effect.runPromise(
      decodeControlCenterRuntimeBenchmarkReportJson("{\"version\":1,\"machine\":").pipe(Effect.result)
    )
    expect(Result.isFailure(pruned)).toBe(true)

    const missing = await Effect.runPromise(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectory({ prefix: "control-center-runtime-report-test-" })
        return yield* readControlCenterRuntimeBenchmarkReport(path.join(root, "missing.json")).pipe(
          Effect.result,
          Effect.ensuring(fileSystem.remove(root, { force: true, recursive: true }).pipe(Effect.orDie))
        )
      }).pipe(Effect.provide(NodeServices.layer))
    )
    expect(Result.isFailure(missing)).toBe(true)
  })

  it("keeps the package command deterministic and validates the durable report", async () => {
    const packageJson = await Effect.runPromise(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const packagePath = yield* path.fromFileUrl(new URL("../../package.json", import.meta.url))
        return yield* fileSystem.readFileString(packagePath)
      }).pipe(Effect.provide(NodeServices.layer))
    )
    const manifest = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) }))
    )(packageJson)
    const command = manifest.scripts["benchmark:runtime"]

    expect(command).toContain(`rimraf ${CONTROL_CENTER_RUNTIME_BENCHMARK_DEFAULT_OUTPUT}`)
    expect(command).toContain(
      `CONTROL_CENTER_RUNTIME_BENCHMARK_OUTPUT=${CONTROL_CENTER_RUNTIME_BENCHMARK_DEFAULT_OUTPUT}`
    )
    expect(command).toContain("scripts/validateRuntimeBenchmarkReport.ts")
  })

  it("rejects aggregates that do not match their samples", async () => {
    const valid = validReportInput()
    const invalid = {
      ...valid,
      measurements: {
        ...valid.measurements,
        portfolio: {
          ...valid.measurements.portfolio,
          timing: {
            ...valid.measurements.portfolio.timing,
            medianMilliseconds: 10
          }
        }
      }
    }

    expect(Result.isFailure(await decodeResult(invalid))).toBe(true)
    expect(() => Schema.decodeUnknownSync(ControlCenterRuntimeBenchmarkReport)(invalid)).toThrow()
  })
})
