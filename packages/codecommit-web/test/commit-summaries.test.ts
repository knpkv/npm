import { describe, expect, it } from "@effect/vitest"
import * as ReadClient from "@knpkv/codecommit-core/ReadClient.js"
import { DateTime } from "effect"
import { commitSummaryWire } from "../src/server/review/CommitSummaries.js"

describe("commit summaries", () => {
  it("gives a commit's title and its commit time in epoch milliseconds", () => {
    const commit = "c".repeat(40)
    expect(commitSummaryWire(
      new ReadClient.CodeCommitCommitSummary({
        commitId: ReadClient.CodeCommitCommitId.make(commit),
        title: "Restore the draft on reconnect",
        committedAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 17, 14, 18))
      })
    )).toEqual({
      commitId: commit,
      title: "Restore the draft on reconnect",
      committedAt: Date.UTC(2026, 9, 17, 14, 18)
    })
  })
})
