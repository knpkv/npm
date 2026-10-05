/**
 * A local blob is read under the same byte budget as a provider blob, and an
 * oversized one fails with the provider's own too-large error, carrying the
 * size seen when the budget was crossed.
 */
import { describe, expect, it } from "@effect/vitest"
import { ReadClient } from "@knpkv/codecommit-core"
import { Effect, Sink, Stream } from "effect"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { loadLocalGitBlob } from "../src/tui/file-diff.js"

const blobId = ReadClient.CodeCommitBlobId.make("a".repeat(40))
const half = ReadClient.CODECOMMIT_BLOB_MAXIMUM_BYTES / 2

const gitWritingChunks = (chunks: ReadonlyArray<Uint8Array>) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(ChildProcessSpawner.makeHandle({
      all: Stream.empty,
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      pid: ChildProcessSpawner.ProcessId(1),
      stderr: Stream.empty,
      stdin: Sink.drain,
      stdout: Stream.fromIterable(chunks),
      unref: Effect.succeed(Effect.void)
    }))
  )

describe("loadLocalGitBlob", () => {
  it.effect("returns a blob of exactly the maximum size", () =>
    Effect.gen(function*() {
      const content = yield* loadLocalGitBlob(
        gitWritingChunks([new Uint8Array(half), new Uint8Array(half)]),
        { blobId, worktreePath: "/worktree" }
      )
      expect(content.bytes.byteLength).toBe(ReadClient.CODECOMMIT_BLOB_MAXIMUM_BYTES)
    }))

  it.effect("fails with the provider's too-large error past the maximum", () =>
    Effect.gen(function*() {
      const error = yield* loadLocalGitBlob(
        gitWritingChunks([new Uint8Array(half), new Uint8Array(half + 1)]),
        { blobId, worktreePath: "/worktree" }
      ).pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: "CodeCommitBlobTooLargeError",
        actualBytes: ReadClient.CODECOMMIT_BLOB_MAXIMUM_BYTES + 1,
        maximumBytes: ReadClient.CODECOMMIT_BLOB_MAXIMUM_BYTES,
        operation: "read-local-blob"
      })
    }))
})
