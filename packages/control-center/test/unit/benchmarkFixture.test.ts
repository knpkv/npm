import { describe, expect, it } from "vitest"

import { BenchmarkInvariantError } from "../../scripts/benchmarkErrors.js"
import {
  CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS,
  CONTROL_CENTER_BENCHMARK_FIXTURE_SEED,
  generateBenchmarkEdges,
  generateBenchmarkEntities,
  generateBenchmarkFiles,
  generateBenchmarkReleases,
  generateBenchmarkTimelineEvents,
  generateControlCenterBenchmarkFixture,
  makeBenchmarkPortfolioSnapshot
} from "../../scripts/benchmarkFixture.js"

describe("control center benchmark fixture", () => {
  it("generates the same complete reference fixture for the same seed", () => {
    const first = generateControlCenterBenchmarkFixture()
    const second = generateControlCenterBenchmarkFixture(CONTROL_CENTER_BENCHMARK_FIXTURE_SEED)

    expect(second).toStrictEqual(first)
    expect(first.releases).toHaveLength(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases)
    expect(first.entities).toHaveLength(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.entities)
    expect(first.edges).toHaveLength(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.edges)
    expect(first.files).toHaveLength(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.files)
    expect(first.timelineEvents).toHaveLength(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.timelineEvents)
    expect(new Set(first.entities.map(({ id }) => id))).toHaveLength(first.entities.length)
    expect(new Set(first.edges.map(({ id }) => id))).toHaveLength(first.edges.length)
  })

  it("changes stable identities when the explicit seed changes", () => {
    const reference = generateControlCenterBenchmarkFixture()
    const alternative = generateControlCenterBenchmarkFixture("control-center-large-alternative")

    expect(alternative.releases[0]?.id).not.toBe(reference.releases[0]?.id)
    expect(alternative.entities[0]?.id).not.toBe(reference.entities[0]?.id)
    expect(alternative.timelineEvents[0]?.releaseId).not.toBe(reference.timelineEvents[0]?.releaseId)
  })

  it("rejects empty and overlong seeds with the typed benchmark invariant", () => {
    const generators = [
      generateBenchmarkReleases,
      generateBenchmarkEntities,
      generateBenchmarkEdges,
      generateBenchmarkFiles,
      generateBenchmarkTimelineEvents,
      generateControlCenterBenchmarkFixture
    ]
    for (const seed of ["", "x".repeat(101)]) {
      for (const generate of generators) {
        expect(() => generate(seed)).toThrow(BenchmarkInvariantError)
      }
    }
  })

  it("projects all 100 releases through the real bounded portfolio contract", () => {
    const fixture = generateControlCenterBenchmarkFixture()
    const portfolio = makeBenchmarkPortfolioSnapshot(fixture)

    expect(portfolio.releases).toHaveLength(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases)
    expect(portfolio.eventCursor).toBe(CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.timelineEvents)
    expect(portfolio.releases[0]?.serviceName).toBe("service-001")
    expect(portfolio.releases[99]?.serviceName).toBe("service-100")
  })
})
