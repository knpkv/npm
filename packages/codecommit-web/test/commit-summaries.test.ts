import { describe, expect, it } from "@effect/vitest"
import { AwsProfileName, AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import * as ReadClient from "@knpkv/codecommit-core/ReadClient.js"
import { DateTime, Effect, Ref, Result, Schema } from "effect"
import { makeCommitSummaryReader } from "../src/server/review/CommitSummaries.js"

const account = {
  profile: Schema.decodeUnknownSync(AwsProfileName)("reviewer-profile"),
  region: Schema.decodeUnknownSync(AwsRegion)("eu-west-1")
}
const commit = "c".repeat(40)

const reader = Effect.fn("CommitSummariesTest.reader")(function*(fail: Ref.Ref<boolean>) {
  const calls = yield* Ref.make(0)
  const getCommit: ReadClient.CodeCommitReadClientService["getCommit"] = (request) =>
    Ref.update(calls, (n) => n + 1).pipe(
      Effect.andThen(Ref.get(fail)),
      Effect.flatMap((failing) =>
        failing
          ? Effect.fail(new ReadClient.CodeCommitReadNotFoundError({ operation: "get-commit" }))
          : Effect.succeed(
            new ReadClient.CodeCommitCommitSummary({
              commitId: ReadClient.CodeCommitCommitId.make(request.commitId),
              title: "Restore the draft on reconnect",
              committedAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 17, 14, 18))
            })
          )
      )
    )
  const read = yield* makeCommitSummaryReader(getCommit)
  return { calls, read }
})

describe("commit summaries", () => {
  it.effect("reads a commit once and gives its title and time in epoch milliseconds", () =>
    Effect.gen(function*() {
      const { calls, read } = yield* reader(yield* Ref.make(false))
      const target = { account, repositoryName: "relay-web", commit }
      expect(yield* read(target)).toEqual({
        commitId: commit,
        title: "Restore the draft on reconnect",
        committedAt: Date.UTC(2026, 9, 17, 14, 18)
      })
      yield* read(target)
      expect(yield* Ref.get(calls)).toBe(1)
    }))

  it.effect("does not keep a failed read, so the next request asks again", () =>
    Effect.gen(function*() {
      const failing = yield* Ref.make(true)
      const { calls, read } = yield* reader(failing)
      const target = { account, repositoryName: "relay-web", commit }
      expect(Result.isFailure(yield* Effect.result(read(target)))).toBe(true)
      yield* Ref.set(failing, false)
      expect((yield* read(target)).title).toBe("Restore the draft on reconnect")
      expect(yield* Ref.get(calls)).toBe(2)
    }))
})
