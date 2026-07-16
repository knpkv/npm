import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

import {
  CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS,
  CONTROL_CENTER_BENCHMARK_FIXTURE_SEED,
  CONTROL_CENTER_BENCHMARK_FIXTURE_VERSION,
  generateControlCenterBenchmarkFixture
} from "../../scripts/benchmarkFixture.js"
import {
  type BenchmarkOperationOutcome,
  CONTROL_CENTER_BENCHMARK_CAPS,
  CONTROL_CENTER_BENCHMARK_REPORT_VERSION,
  CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS,
  CONTROL_CENTER_BENCHMARK_WARMUP_RUNS,
  ControlCenterBenchmarkMachine,
  ControlCenterBenchmarkReport,
  prepareGeneratedFixtureMaterialization,
  preparePortfolioContractSerialization,
  prepareSseContractSerialization,
  runControlCenterBenchmark,
  summarizeBenchmarkSamples
} from "../../scripts/benchmarkHarness.js"

const machine = Schema.decodeUnknownSync(ControlCenterBenchmarkMachine)({
  architecture: "x64",
  logicalCpuCount: 4,
  nodeVersion: "v24.0.0",
  platform: "linux",
  storageClass: "unverified",
  totalMemoryBytes: 8 * 1_024 * 1_024 * 1_024
})

const samples = [11, 7, 13, 5, 9]

const measurement = (
  name: "fixture.generated-materialization" | "portfolio.contract-serialization" | "sse.contract-serialization",
  batchCap: number,
  outcome: BenchmarkOperationOutcome
) => summarizeBenchmarkSamples({ batchCap, name }, outcome, samples)

describe("control center benchmark harness", () => {
  it("keeps ingestion, portfolio, and SSE work within explicit caps", () => {
    const fixture = generateControlCenterBenchmarkFixture()
    const ingestion = prepareGeneratedFixtureMaterialization(fixture)
    const portfolio = preparePortfolioContractSerialization(fixture)
    const sse = prepareSseContractSerialization(fixture)

    expect(ingestion.processedCount).toBe(32_600)
    expect(ingestion.batchCount).toBe(66)
    expect(ingestion.maximumBatchSize).toBe(CONTROL_CENTER_BENCHMARK_CAPS.ingestionPageSize)
    expect(portfolio.processedCount).toBe(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases)
    expect(portfolio.maximumBatchSize).toBeLessThanOrEqual(CONTROL_CENTER_BENCHMARK_CAPS.portfolioReleases)
    expect(sse.processedCount).toBe(CONTROL_CENTER_BENCHMARK_CAPS.sseBurstEvents)
    expect(sse.batchCount).toBe(4)
    expect(sse.maximumBatchSize).toBe(CONTROL_CENTER_BENCHMARK_CAPS.liveEventPageSize)
    expect(CONTROL_CENTER_BENCHMARK_CAPS.sseBurstEvents).toBeLessThanOrEqual(
      CONTROL_CENTER_BENCHMARK_CAPS.liveEventReplayEvents
    )
    expect(CONTROL_CENTER_BENCHMARK_CAPS.browserContexts).toBe(1)
    expect(CONTROL_CENTER_BENCHMARK_CAPS.wakeupQueue).toBe(64)
  })

  it("reports median and p95 only after the documented warmup", () => {
    const outcome = {
      batchCount: 4,
      maximumBatchSize: 128,
      processedCount: 500,
      serializedBytes: 4_096
    }
    const result = measurement("sse.contract-serialization", 128, outcome)

    expect(result.warmupRuns).toBe(CONTROL_CENTER_BENCHMARK_WARMUP_RUNS)
    expect(result.samplesMilliseconds).toHaveLength(CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS)
    expect(result.medianMilliseconds).toBe(9)
    expect(result.p95Milliseconds).toBe(13)
    expect(result.timingIsAcceptanceAssertion).toBe(false)
  })

  it("keeps invalid seed failures in the typed error channel", async () => {
    for (const seed of ["", "x".repeat(101)]) {
      const result = await Effect.runPromise(
        runControlCenterBenchmark({ machine, seed }).pipe(Effect.result)
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("BenchmarkInvariantError")
      }
    }
  })

  it("decodes a complete machine-readable report with result metadata", () => {
    const fixture = generateControlCenterBenchmarkFixture()
    const measurements = [
      measurement(
        "fixture.generated-materialization",
        CONTROL_CENTER_BENCHMARK_CAPS.ingestionPageSize,
        prepareGeneratedFixtureMaterialization(fixture)
      ),
      measurement(
        "portfolio.contract-serialization",
        CONTROL_CENTER_BENCHMARK_CAPS.portfolioReleases,
        preparePortfolioContractSerialization(fixture)
      ),
      measurement(
        "sse.contract-serialization",
        CONTROL_CENTER_BENCHMARK_CAPS.liveEventPageSize,
        prepareSseContractSerialization(fixture)
      )
    ]
    const report = Schema.decodeUnknownSync(ControlCenterBenchmarkReport)({
      caps: CONTROL_CENTER_BENCHMARK_CAPS,
      fixture: {
        counts: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS,
        seed: CONTROL_CENTER_BENCHMARK_FIXTURE_SEED,
        version: CONTROL_CENTER_BENCHMARK_FIXTURE_VERSION
      },
      generatedAt: "2026-07-14T10:00:00.000Z",
      machine,
      measurements,
      sampleRuns: CONTROL_CENTER_BENCHMARK_SAMPLE_RUNS,
      version: CONTROL_CENTER_BENCHMARK_REPORT_VERSION,
      warmupRuns: CONTROL_CENTER_BENCHMARK_WARMUP_RUNS
    })

    expect(report.machine.logicalCpuCount).toBe(4)
    expect(report.fixture.counts.timelineEvents).toBe(20_000)
    expect(report.measurements.map(({ name }) => name)).toStrictEqual([
      "fixture.generated-materialization",
      "portfolio.contract-serialization",
      "sse.contract-serialization"
    ])
    expect(Schema.encodeSync(ControlCenterBenchmarkReport)(report)).toMatchObject({
      generatedAt: "2026-07-14T10:00:00.000Z",
      version: CONTROL_CENTER_BENCHMARK_REPORT_VERSION
    })
  })
})
