import { collectBounded } from "@knpkv/bounded-io"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

const GIT_EXECUTABLE = "git"
const READ_TIMEOUT = Duration.minutes(2)
/** Matches the largest diff the executor previously reassembled from retained command artifacts. */
const MAXIMUM_READ_BYTES = 64 * 1_024 * 1_025
const textDecoder = new TextDecoder("utf-8", { fatal: false })

/** A host-side revision read could not complete: it timed out, overflowed, or `git` failed. */
export class PrReviewRevisionReadError extends Schema.TaggedError<PrReviewRevisionReadError>()(
  "PrReviewRevisionReadError",
  { reason: Schema.Literals(["unavailable", "timeout", "output-rejected"]) }
) {}

/**
 * Reads exact review revisions from the host's own source checkout.
 *
 * The review agent works in a writable copy inside the sandbox, where it can rewrite refs,
 * replacement refs and object files; evidence validation therefore never reads that copy. This
 * reader runs `git` on the host against the checkout the sandbox only mounts read-only, as argv
 * without a shell, with replacement objects disabled and no global or system configuration.
 */
export interface PrReviewRevisionReader {
  /** Object type at `revision:path` (`blob`, `tree`, …), or `null` when the path is absent. */
  readonly objectType: (revision: string, path: string) => Effect.Effect<string | null, PrReviewRevisionReadError>
  /** Blob content at `revision:path`, or `null` when the path is absent or not a blob. */
  readonly blob: (revision: string, path: string) => Effect.Effect<Uint8Array | null, PrReviewRevisionReadError>
  /** Zero-context, inter-hunk-free diff text for literal `paths` between two revisions. */
  readonly diff: (input: {
    readonly base: string
    readonly head: string
    readonly paths: ReadonlyArray<string>
    readonly findRenames: boolean
  }) => Effect.Effect<string, PrReviewRevisionReadError>
  /** The base path a rename-detected head `path` came from, or `null` when it was not renamed. */
  readonly renamedFrom: (input: {
    readonly base: string
    readonly head: string
    readonly path: string
  }) => Effect.Effect<string | null, PrReviewRevisionReadError>
  /** Whether `patch` applies to `revision`'s tree, checked in a throwaway index outside the checkout. */
  readonly patchApplies: (revision: string, patch: string) => Effect.Effect<boolean, PrReviewRevisionReadError>
}

interface GitResult {
  readonly exitCode: ChildProcessSpawner.ExitCode
  readonly stdout: Uint8Array
}

const unavailable = () => new PrReviewRevisionReadError({ reason: "unavailable" })

const baseEnvironment = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  HOME: "/nonexistent",
  LANG: "C",
  LC_ALL: "C"
} satisfies Readonly<Record<string, string>>

const succeeded = (result: GitResult) => result.exitCode === ChildProcessSpawner.ExitCode(0)

/** Builds a reader over `sourceRoot`; `executablePath` is the host `PATH` used to find `git`. */
export const makePrReviewRevisionReader = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  sourceRoot: string,
  executablePath: string
): PrReviewRevisionReader => {
  const git = (
    args: ReadonlyArray<string>,
    options: {
      readonly input?: Uint8Array
      readonly environment?: Readonly<Record<string, string>>
    } = {}
  ): Effect.Effect<GitResult, PrReviewRevisionReadError> =>
    Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            GIT_EXECUTABLE,
            [
              "--no-replace-objects",
              "--no-optional-locks",
              "-c",
              "core.fsmonitor=false",
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "core.quotePath=false",
              ...args
            ],
            {
              cwd: sourceRoot,
              env: { ...baseEnvironment, ...options.environment, PATH: executablePath },
              extendEnv: false,
              forceKillAfter: Duration.seconds(5),
              shell: false,
              stdin: options.input === undefined ? "ignore" : Stream.make(options.input),
              stdout: "pipe",
              stderr: "pipe"
            }
          )
        ).pipe(Effect.mapError(unavailable))
        const [exitCode, stdout] = yield* Effect.all([
          handle.exitCode.pipe(Effect.mapError(unavailable)),
          collectBounded(handle.stdout, MAXIMUM_READ_BYTES).pipe(
            Effect.mapError(() => new PrReviewRevisionReadError({ reason: "output-rejected" }))
          ),
          handle.stderr.pipe(Stream.runDrain, Effect.mapError(unavailable))
        ], { concurrency: "unbounded" })
        return { exitCode, stdout }
      })
    ).pipe(
      Effect.timeoutOrElse({
        duration: READ_TIMEOUT,
        orElse: () => Effect.fail(new PrReviewRevisionReadError({ reason: "timeout" }))
      })
    )

  const objectType = Effect.fn("PrReviewRevisionReader.objectType")(function*(revision: string, objectPath: string) {
    const result = yield* git(["cat-file", "-t", `${revision}:${objectPath}`])
    return succeeded(result) ? textDecoder.decode(result.stdout).trim() : null
  })

  const blob = Effect.fn("PrReviewRevisionReader.blob")(function*(revision: string, objectPath: string) {
    if ((yield* objectType(revision, objectPath)) !== "blob") return null
    const result = yield* git(["cat-file", "blob", `${revision}:${objectPath}`])
    return succeeded(result) ? result.stdout : yield* unavailable()
  })

  const diff = Effect.fn("PrReviewRevisionReader.diff")(function*(input: {
    readonly base: string
    readonly head: string
    readonly paths: ReadonlyArray<string>
    readonly findRenames: boolean
  }) {
    const result = yield* git([
      "--literal-pathspecs",
      "diff",
      input.findRenames ? "--find-renames" : "--no-renames",
      "--unified=0",
      "--inter-hunk-context=0",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      input.base,
      input.head,
      "--",
      ...input.paths
    ])
    return succeeded(result) ? textDecoder.decode(result.stdout) : yield* unavailable()
  })

  const renamedFrom = Effect.fn("PrReviewRevisionReader.renamedFrom")(function*(input: {
    readonly base: string
    readonly head: string
    readonly path: string
  }) {
    const result = yield* git(["diff", "--name-status", "--find-renames", "-z", input.base, input.head])
    if (!succeeded(result)) return yield* unavailable()
    // `-z` records: `<status>\0<path>\0`, or `<R|C><score>\0<from>\0<to>\0` for renames and copies.
    const fields = textDecoder.decode(result.stdout).split("\0")
    for (let index = 0; index < fields.length;) {
      const status = fields[index] ?? ""
      if (!/^[RC][0-9]*$/u.test(status)) {
        index += 2
        continue
      }
      if (status.startsWith("R") && fields[index + 2] === input.path) return fields[index + 1] ?? null
      index += 3
    }
    return null
  })

  const patchApplies = Effect.fn("PrReviewRevisionReader.patchApplies")(function*(revision: string, patch: string) {
    return yield* Effect.scoped(
      Effect.gen(function*() {
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cc-pr-review-index-" }).pipe(
          Effect.mapError(unavailable)
        )
        const environment = { GIT_INDEX_FILE: path.join(directory, "index") }
        const read = yield* git(["read-tree", revision], { environment })
        if (!succeeded(read)) return yield* unavailable()
        const applied = yield* git(["apply", "--check", "--cached", "-"], {
          environment,
          input: new TextEncoder().encode(`${patch}\n`)
        })
        return succeeded(applied)
      })
    )
  })

  return { objectType, blob, diff, renamedFrom, patchApplies }
}
