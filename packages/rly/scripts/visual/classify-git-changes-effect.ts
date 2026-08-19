import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Stream from "effect/Stream"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import type { VisualClassification } from "./classify-changes.js"

export class VisualGitError extends Data.TaggedError("VisualGitError")<{
  readonly reason: string
}> {}

export const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024

export const failClosedVisualClassification: VisualClassification = {
  reasons: ["git-or-catalog-failure"],
  scope: "full"
}

interface ByteAccumulator {
  readonly bytes: number
  readonly chunks: ReadonlyArray<Uint8Array>
}

const isVisualGitError = (cause: unknown): cause is VisualGitError =>
  Predicate.isTagged(cause, "VisualGitError") &&
  Predicate.hasProperty(cause, "reason") &&
  Predicate.isString(cause.reason)

const collectBounded = (
  stream: Stream.Stream<Uint8Array, unknown>,
  maximumBytes: number,
  label: "stderr" | "stdout"
): Effect.Effect<string, VisualGitError> =>
  stream.pipe(
    Stream.runFoldEffect(
      (): ByteAccumulator => ({ bytes: 0, chunks: [] }),
      (accumulator, chunk) => {
        const bytes = accumulator.bytes + chunk.byteLength
        return bytes > maximumBytes
          ? Effect.fail(new VisualGitError({ reason: `Git ${label} exceeded the classifier bound` }))
          : Effect.succeed({ bytes, chunks: [...accumulator.chunks, Uint8Array.from(chunk)] })
      }
    ),
    Effect.flatMap((accumulator) =>
      Stream.fromIterable(accumulator.chunks).pipe(
        Stream.decodeText(),
        Stream.mkString
      )
    ),
    Effect.mapError((cause) =>
      isVisualGitError(cause)
        ? cause
        : new VisualGitError({ reason: `Git ${label} could not be read` })
    )
  )

/**
 * Drain a Git process while enforcing byte bounds before output collection.
 * A reader failure terminates the child so it cannot continue producing data.
 */
export const collectBoundedGitProcess = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  maximumBytes = MAX_GIT_OUTPUT_BYTES
): Effect.Effect<string, VisualGitError> =>
  Effect.all({
    exitCode: handle.exitCode.pipe(
      Effect.mapError(() => new VisualGitError({ reason: "Git command failed" }))
    ),
    stderr: collectBounded(handle.stderr, maximumBytes, "stderr"),
    stdout: collectBounded(handle.stdout, maximumBytes, "stdout")
  }, { concurrency: "unbounded" }).pipe(
    Effect.onError(() => handle.kill().pipe(Effect.ignore)),
    Effect.flatMap(({ exitCode, stdout }) =>
      exitCode === 0
        ? Effect.succeed(stdout)
        : Effect.fail(new VisualGitError({ reason: "Git command failed" }))
    )
  )

/** Fail closed for expected Git/catalog errors while preserving defects and interruption. */
export const recoverVisualGitFailure = <E, R>(
  effect: Effect.Effect<VisualClassification, E, R>
): Effect.Effect<VisualClassification, never, R> =>
  effect.pipe(Effect.catch(() => Effect.succeed(failClosedVisualClassification)))
