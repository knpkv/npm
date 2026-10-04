import { describe, expect, it } from "@effect/vitest"
import { initialSamplesState, readClaudeLimitSamples } from "../src/core/ClaudeLimitSamples.js"
import type { SourceLine } from "../src/core/Readers.js"

const file = { fileKey: "claude-limits.jsonl", machine: "host-a", sessionId: "claude-limits" }

const lines = (...texts: ReadonlyArray<string>): ReadonlyArray<SourceLine> =>
  texts.map((text, index) => ({ offset: index * 100, text }))

/** A sample line's fields, loose enough to write the malformed lines the reader must skip. */
interface SampleFields {
  readonly v?: number
  readonly observedAt?: number
  readonly machine?: string
  readonly window?: string
  readonly usedPercentage?: number | string
  readonly resetsAt?: number | null
  readonly futureField?: boolean
}

const sample = (overrides: SampleFields = {}): string =>
  JSON.stringify({
    v: 1,
    observedAt: 1_791_136_131_724,
    machine: "KNPKV-SER8",
    window: "five_hour",
    usedPercentage: 6,
    resetsAt: 1_791_139_731_000,
    ...overrides
  })

describe("readClaudeLimitSamples", () => {
  it("turns each sample into a Claude limit snapshot of the local machine", () => {
    const result = readClaudeLimitSamples(
      file,
      lines(
        sample(),
        sample({ window: "seven_day", usedPercentage: 20, resetsAt: 1_791_395_331_000 }),
        sample({ window: "spend", usedPercentage: 12.5, resetsAt: null, futureField: true })
      ),
      initialSamplesState
    )
    expect(result.snapshots).toEqual([
      {
        agent: "claude",
        machine: "host-a",
        source: "claude-statusline",
        label: "five_hour",
        windowMinutes: 300,
        observedAt: 1_791_136_131_724,
        reading: { _tag: "Known", usedPercent: 6, resetsAt: 1_791_139_731_000 }
      },
      {
        agent: "claude",
        machine: "host-a",
        source: "claude-statusline",
        label: "seven_day",
        windowMinutes: 10_080,
        observedAt: 1_791_136_131_724,
        reading: { _tag: "Known", usedPercent: 20, resetsAt: 1_791_395_331_000 }
      },
      {
        agent: "claude",
        machine: "host-a",
        source: "claude-statusline",
        label: "spend",
        windowMinutes: null,
        observedAt: 1_791_136_131_724,
        reading: { _tag: "Known", usedPercent: 12.5, resetsAt: null }
      }
    ])
    expect(result.events).toEqual([])
  })

  it("keeps one sample per (machine, window, resetsAt, usedPercentage), across chunks", () => {
    const first = readClaudeLimitSamples(
      file,
      lines(sample(), sample({ observedAt: 1_791_136_140_000 })),
      initialSamplesState
    )
    expect(first.snapshots).toHaveLength(1)
    const second = readClaudeLimitSamples(
      file,
      lines(sample({ observedAt: 1_791_136_150_000 }), sample({ observedAt: 1_791_136_160_000, usedPercentage: 7 })),
      first.state
    )
    expect(second.snapshots.map((snapshot) => snapshot.observedAt)).toEqual([1_791_136_160_000])
    // Another machine's identical reading is its own sample.
    const third = readClaudeLimitSamples(file, lines(sample({ machine: "OTHER" })), first.state)
    expect(third.snapshots).toHaveLength(1)
  })

  it("skips and counts lines it cannot decode, including another format version", () => {
    const result = readClaudeLimitSamples(
      file,
      lines("not json", sample({ v: 2 }), sample({ window: "monthly" }), sample({ usedPercentage: "6" }), sample()),
      initialSamplesState
    )
    expect(result.snapshots).toHaveLength(1)
    expect(result.skipped.unparseableLine).toBe(4)
  })
})
