import { describe, expect, it } from "@effect/vitest"
import type { IngestStatus, SourceStatus } from "../src/core/Ingest.js"
import { describeIngest } from "../src/server/IngestSummary.js"

const source = (overrides: Partial<SourceStatus> = {}): SourceStatus => ({
  rootMissing: false,
  filesScanned: 1,
  filesRead: 1,
  eventsAdded: 3,
  skipped: { unparseableLine: 0, missingTimestamp: 0, oversizedLine: 0 },
  unreadable: [],
  ...overrides
})

const status = (claudeLimitSamples: SourceStatus): IngestStatus => ({
  startedAt: 0,
  finishedAt: 42,
  claude: source(),
  codex: source({ rootMissing: true }),
  claudeLimitSamples
})

describe("describeIngest", () => {
  it("summarises every source, the claude-statusline limit log included", () => {
    expect(describeIngest(status(source({ skipped: { unparseableLine: 2, missingTimestamp: 0, oversizedLine: 0 } }))))
      .toEqual([
        "claude: 1/1 files read, 3 events added",
        "codex: no sessions directory",
        "claude-statusline limits: read, 2 lines skipped",
        "took 42ms"
      ])
    expect(describeIngest(status(source({ rootMissing: true, filesScanned: 0, filesRead: 0 })))[2]).toBe(
      "claude-statusline limits: none logged yet"
    )
  })
})
