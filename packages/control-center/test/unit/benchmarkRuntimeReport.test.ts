import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS } from "../../scripts/benchmarkFixture.js"
import {
  CONTROL_CENTER_BENCHMARK_CAPS,
  ControlCenterBenchmarkMachine,
  summarizeBenchmarkTimingSamples
} from "../../scripts/benchmarkHarness.js"
import {
  CONTROL_CENTER_PORTFOLIO_P95_BUDGET_MILLISECONDS,
  CONTROL_CENTER_RUNTIME_BENCHMARK_DEFAULT_OUTPUT,
  CONTROL_CENTER_RUNTIME_BENCHMARK_REPORT_VERSION,
  controlCenterBenchmarkMachineIsTimingEligible,
  ControlCenterRuntimeBenchmarkReport,
  decodeControlCenterRuntimeBenchmarkReportJson,
  readControlCenterRuntimeBenchmarkReport,
  validateControlCenterRuntimeBenchmarkCiAcceptance
} from "../../scripts/benchmarkRuntimeReport.js"

const machine = Schema.decodeUnknownSync(ControlCenterBenchmarkMachine)({
  architecture: "x64",
  logicalCpuCount: 4,
  nodeVersion: "v24.0.0",
  platform: "linux",
  storageClass: "local-ssd",
  totalMemoryBytes: 8 * 1_024 * 1_024 * 1_024
})

const samples = [11, 7, 13, 5, 9]

const githubWorkflowStep = (workflow: string, name: string): string | undefined => {
  const lines = workflow.split("\n")
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`)
  if (start < 0) return undefined
  const indentation = lines[start]?.search(/\S/u) ?? 0
  const siblingPrefix = `${" ".repeat(indentation)}- `
  const relativeEnd = lines.slice(start + 1).findIndex((line) => line.startsWith(siblingPrefix))
  const end = relativeEnd < 0 ? lines.length : start + relativeEnd + 1
  return lines.slice(start, end).join("\n")
}

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
  timingAcceptance: {
    budgetMilliseconds: CONTROL_CENTER_PORTFOLIO_P95_BUDGET_MILLISECONDS,
    eligible: true,
    passed: true,
    reason: "eligible-and-within-budget"
  },
  timingIsAcceptanceAssertion: true,
  version: CONTROL_CENTER_RUNTIME_BENCHMARK_REPORT_VERSION
})

const decodeResult = (input: unknown) =>
  decodeControlCenterRuntimeBenchmarkReportJson(JSON.stringify(input)).pipe(Effect.result)

describe("control center runtime benchmark report", () => {
  it.effect("decodes exact-five samples with correctly derived median and p95", () =>
    Effect.gen(function*() {
      const report = yield* decodeControlCenterRuntimeBenchmarkReportJson(JSON.stringify(validReportInput()))

      expect(report.machine.logicalCpuCount).toBe(4)
      expect(report.measurements.portfolio.timing.samplesMilliseconds).toHaveLength(5)
      expect(report.measurements.portfolio.timing.medianMilliseconds).toBe(9)
      expect(report.measurements.portfolio.timing.p95Milliseconds).toBe(13)
      expect(report.measurements.sse.timing.medianMilliseconds).toBe(9)
      expect(report.measurements.sse.timing.p95Milliseconds).toBe(13)
      expect(report.timingAcceptance).toEqual({
        budgetMilliseconds: 2_000,
        eligible: true,
        passed: true,
        reason: "eligible-and-within-budget"
      })
      expect(report.timingIsAcceptanceAssertion).toBe(true)
    }))

  it("qualifies only the documented Node 24, CPU, memory, platform, and architecture baseline", () => {
    expect(controlCenterBenchmarkMachineIsTimingEligible(machine)).toBe(true)
    const ineligibleMachines = [
      { ...machine, architecture: "riscv64" },
      { ...machine, logicalCpuCount: 3 },
      { ...machine, nodeVersion: "v23.11.0" },
      { ...machine, platform: "darwin" },
      { ...machine, storageClass: "unverified" },
      { ...machine, totalMemoryBytes: 8 * 1_024 * 1_024 * 1_024 - 1 }
    ].map((input) => Schema.decodeUnknownSync(ControlCenterBenchmarkMachine)(input))
    for (const ineligible of ineligibleMachines) {
      expect(controlCenterBenchmarkMachineIsTimingEligible(ineligible)).toBe(false)
    }
  })

  it("rejects malformed Node version evidence before timing eligibility is evaluated", () => {
    for (
      const nodeVersion of [
        "v24beta",
        "x24.invalid",
        "v24.1",
        "v024.1.0",
        "v24.0.0-..",
        "v24.0.0-a..b",
        "v24.0.0-01",
        "v24.0.0+build..1"
      ]
    ) {
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(ControlCenterBenchmarkMachine)({
            ...machine,
            nodeVersion
          })
        )
      ).toBe(true)
    }
    const supportedPrerelease = Schema.decodeUnknownSync(ControlCenterBenchmarkMachine)({
      ...machine,
      nodeVersion: "v24.10.0-rc.1"
    })
    expect(controlCenterBenchmarkMachineIsTimingEligible(supportedPrerelease)).toBe(true)
  })

  it.effect("rejects an over-budget or contradictory eligible timing claim", () =>
    Effect.gen(function*() {
      const valid = validReportInput()
      const overBudget = {
        ...valid,
        measurements: {
          ...valid.measurements,
          portfolio: {
            ...valid.measurements.portfolio,
            timing: summarizeBenchmarkTimingSamples([2_001, 2_002, 2_003, 2_004, 2_005])
          }
        }
      }
      const contradictory = {
        ...valid,
        timingAcceptance: {
          ...valid.timingAcceptance,
          passed: false
        }
      }

      expect(Result.isFailure(yield* decodeResult(overBudget))).toBe(true)
      expect(Result.isFailure(yield* decodeResult(contradictory))).toBe(true)
    }))

  it.effect("rejects one extra durable release while preserving the exact fixture cardinality", () =>
    Effect.gen(function*() {
      const valid = validReportInput()
      expect(Result.isSuccess(yield* decodeResult(valid))).toBe(true)
      expect(
        Result.isFailure(
          yield* decodeResult({
            ...valid,
            cardinalities: {
              ...valid.cardinalities,
              persistedReleases: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases + 1
            }
          })
        )
      ).toBe(true)
    }))

  it.effect("keeps over-budget timing informational on an ineligible machine", () =>
    Effect.gen(function*() {
      const valid = validReportInput()
      const report = yield* decodeControlCenterRuntimeBenchmarkReportJson(
        JSON.stringify({
          ...valid,
          machine: { ...machine, logicalCpuCount: 2 },
          measurements: {
            ...valid.measurements,
            portfolio: {
              ...valid.measurements.portfolio,
              timing: summarizeBenchmarkTimingSamples([2_001, 2_002, 2_003, 2_004, 2_005])
            }
          },
          timingAcceptance: {
            budgetMilliseconds: CONTROL_CENTER_PORTFOLIO_P95_BUDGET_MILLISECONDS,
            eligible: false,
            passed: false,
            reason: "ineligible-machine"
          },
          timingIsAcceptanceAssertion: false
        })
      )

      expect(report.measurements.portfolio.timing.p95Milliseconds).toBe(2_005)
      expect(report.timingAcceptance.reason).toBe("ineligible-machine")
    }))

  it.effect("rejects reports with missing machine or timing aggregates", () =>
    Effect.gen(function*() {
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
        expect(Result.isFailure(yield* decodeResult(invalid))).toBe(true)
      }
    }))

  it.effect("rejects a pruned JSON report and a missing report file", () =>
    Effect.gen(function*() {
      const pruned = yield* decodeControlCenterRuntimeBenchmarkReportJson("{\"version\":1,\"machine\":").pipe(
        Effect.result
      )
      expect(Result.isFailure(pruned)).toBe(true)

      const missing = yield* Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectory({ prefix: "control-center-runtime-report-test-" })
        return yield* readControlCenterRuntimeBenchmarkReport(path.join(root, "missing.json")).pipe(
          Effect.result,
          Effect.ensuring(fileSystem.remove(root, { force: true, recursive: true }).pipe(Effect.orDie))
        )
      }).pipe(Effect.provide(NodeServices.layer))
      expect(Result.isFailure(missing)).toBe(true)
    }))

  it.effect("keeps the package command deterministic and validates the durable report", () =>
    Effect.gen(function*() {
      const packageJson = yield* Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const packagePath = yield* path.fromFileUrl(new URL("../../package.json", import.meta.url))
        const workflowPath = yield* path.fromFileUrl(
          new URL("../../../../.github/workflows/check.yml", import.meta.url)
        )
        return {
          manifest: yield* fileSystem.readFileString(packagePath),
          workflow: yield* fileSystem.readFileString(workflowPath)
        }
      }).pipe(Effect.provide(NodeServices.layer))
      const manifest = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) }))
      )(packageJson.manifest)
      const command = manifest.scripts["benchmark:runtime"]
      const preparedCommand = manifest.scripts["benchmark:runtime:prepared"]
      const validationCommand = manifest.scripts["benchmark:validate-runtime"]

      expect(command).toContain("pnpm build")
      expect(command).toContain("pnpm benchmark:runtime:prepared")
      expect(preparedCommand).toContain(`rimraf ${CONTROL_CENTER_RUNTIME_BENCHMARK_DEFAULT_OUTPUT}`)
      expect(preparedCommand).toContain(
        `CONTROL_CENTER_RUNTIME_BENCHMARK_OUTPUT=${CONTROL_CENTER_RUNTIME_BENCHMARK_DEFAULT_OUTPUT}`
      )
      expect(preparedCommand).toContain("pnpm benchmark:validate-runtime")
      expect(validationCommand).toContain("scripts/validateRuntimeBenchmarkReport.ts")
      const uploadStep = githubWorkflowStep(packageJson.workflow, "Upload Control Center runtime benchmark evidence")
      expect(uploadStep).toBeDefined()
      expect(uploadStep).toContain("if: ${{ always() }}")
      expect(uploadStep).toContain("uses: actions/upload-artifact@v7")
      expect(uploadStep).toContain(
        "path: packages/control-center/test-results/control-center/runtime-benchmark.json"
      )
      expect(uploadStep).toContain("if-no-files-found: error")
    }))

  it("keeps every runtime evidence upload field in the named workflow step", () => {
    const splitFields = `
      - name: Upload Control Center runtime benchmark evidence
        if: \${{ always() }}
      - name: Different upload
        uses: actions/upload-artifact@v7
        with:
          path: packages/control-center/test-results/control-center/runtime-benchmark.json
          if-no-files-found: error`
    const completeStep = `
      - name: Upload Control Center runtime benchmark evidence
        if: \${{ always() }}
        uses: actions/upload-artifact@v7
        with:
          path: packages/control-center/test-results/control-center/runtime-benchmark.json
          if-no-files-found: error
      - name: Later step
        run: pnpm test`

    expect(githubWorkflowStep(splitFields, "Upload Control Center runtime benchmark evidence")).not.toContain(
      "actions/upload-artifact"
    )
    expect(githubWorkflowStep(completeStep, "Upload Control Center runtime benchmark evidence")).toContain(
      "path: packages/control-center/test-results/control-center/runtime-benchmark.json"
    )
    expect(githubWorkflowStep(completeStep, "Upload Control Center runtime benchmark evidence")).toContain(
      "if-no-files-found: error"
    )
  })

  it.effect("rejects aggregates that do not match their samples", () =>
    Effect.gen(function*() {
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

      expect(Result.isFailure(yield* decodeResult(invalid))).toBe(true)
      expect(() => Schema.decodeUnknownSync(ControlCenterRuntimeBenchmarkReport)(invalid)).toThrow()
    }))

  it.effect("requires an eligible timing assertion in CI but keeps local evidence informational", () =>
    Effect.gen(function*() {
      const valid = validReportInput()
      const ineligibleReport = yield* decodeControlCenterRuntimeBenchmarkReportJson(
        JSON.stringify({
          ...valid,
          machine: { ...machine, storageClass: "unverified" },
          timingAcceptance: {
            budgetMilliseconds: CONTROL_CENTER_PORTFOLIO_P95_BUDGET_MILLISECONDS,
            eligible: false,
            passed: false,
            reason: "ineligible-machine"
          },
          timingIsAcceptanceAssertion: false
        })
      )

      expect(
        Result.isFailure(
          yield* validateControlCenterRuntimeBenchmarkCiAcceptance(ineligibleReport, true).pipe(Effect.result)
        )
      ).toBe(true)
      expect(
        Result.isSuccess(
          yield* validateControlCenterRuntimeBenchmarkCiAcceptance(ineligibleReport, false).pipe(Effect.result)
        )
      ).toBe(true)
    }))
})
