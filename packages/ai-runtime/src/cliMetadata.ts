/** Bounded discovery of local CLI implementation metadata. @module */
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

const DEFAULT_DISCOVERY_TIMEOUT = "5 seconds"
const MAXIMUM_VERSION_OUTPUT_BYTES = 4 * 1_024

const RuntimeImplementation = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u)
)

const RuntimeVersion = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.makeFilter(
    (value) =>
      Array.from(value).every((character) => {
        const codePoint = character.codePointAt(0)
        return codePoint !== undefined &&
          codePoint >= 0x20 &&
          !(codePoint >= 0x7f && codePoint <= 0x9f) &&
          codePoint !== 0x061c &&
          codePoint !== 0x200e &&
          codePoint !== 0x200f &&
          !(codePoint >= 0x2028 && codePoint <= 0x202e) &&
          !(codePoint >= 0x2066 && codePoint <= 0x2069)
      }),
    { expected: "a printable one-line CLI version" }
  )
)
const Executable = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => !value.includes("\u0000"), {
    expected: "an executable without NUL bytes"
  })
)
const VersionArgument = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => !value.includes("\u0000"), {
    expected: "a version argument without NUL bytes"
  })
)
const WorkingDirectory = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => !value.includes("\u0000"), {
    expected: "a working directory without NUL bytes"
  })
)

/** Safe implementation metadata persisted with an agent run. */
export const AgentRuntimeMetadata = Schema.Union([
  Schema.TaggedStruct("local-cli", {
    implementation: RuntimeImplementation,
    version: RuntimeVersion
  }),
  Schema.TaggedStruct("remote-api", {
    implementation: RuntimeImplementation,
    version: Schema.NullOr(RuntimeVersion)
  })
]).pipe(Schema.toTaggedUnion("_tag"))
export type AgentRuntimeMetadata = typeof AgentRuntimeMetadata.Type

/** Redacted local CLI discovery failure. */
export class AgentRuntimeMetadataError extends Schema.TaggedError<AgentRuntimeMetadataError>()(
  "AgentRuntimeMetadataError",
  {
    implementation: RuntimeImplementation,
    reason: Schema.Literals(["invalid-output", "unavailable"])
  }
) {}
const isRuntimeMetadataError = Schema.is(AgentRuntimeMetadataError)

/** Trusted executable selection used only to read a local CLI's version. */
export interface LocalCliRuntimeMetadataOptions {
  readonly cwd?: string
  readonly executable: string
  readonly implementation: string
  readonly versionArguments?: ReadonlyArray<string>
}

interface CollectedOutput {
  readonly bytes: number
  readonly chunks: ReadonlyArray<Uint8Array>
}

const collectBounded = (
  implementation: string,
  stream: Stream.Stream<Uint8Array, unknown>
): Effect.Effect<string, AgentRuntimeMetadataError> =>
  stream.pipe(
    Stream.runFoldEffect(
      (): CollectedOutput => ({ bytes: 0, chunks: [] }),
      (collected, chunk) => {
        const bytes = collected.bytes + chunk.byteLength
        return bytes > MAXIMUM_VERSION_OUTPUT_BYTES
          ? Effect.fail(
            new AgentRuntimeMetadataError({
              implementation,
              reason: "invalid-output"
            })
          )
          : Effect.succeed({ bytes, chunks: [...collected.chunks, chunk] })
      }
    ),
    Effect.flatMap(({ chunks }) =>
      Stream.fromIterable(chunks).pipe(
        Stream.decodeText(),
        Stream.mkString
      )
    ),
    Effect.mapError(() =>
      new AgentRuntimeMetadataError({
        implementation,
        reason: "invalid-output"
      })
    )
  )

/** Read one bounded, credential-free version string through Effect Process. */
export const readLocalCliRuntimeMetadata = Effect.fn("AgentRuntimeMetadata.readLocalCli")(function*(
  unknownOptions: LocalCliRuntimeMetadataOptions
) {
  const implementation = yield* Schema.decodeUnknownEffect(RuntimeImplementation)(
    unknownOptions.implementation
  ).pipe(
    Effect.mapError(() =>
      new AgentRuntimeMetadataError({
        implementation: "local-cli",
        reason: "invalid-output"
      })
    )
  )
  const path = yield* Config.string("PATH").pipe(
    Effect.mapError(() => new AgentRuntimeMetadataError({ implementation, reason: "unavailable" }))
  )
  const executable = yield* Schema.decodeUnknownEffect(Executable)(unknownOptions.executable).pipe(
    Effect.mapError(() => new AgentRuntimeMetadataError({ implementation, reason: "invalid-output" }))
  )
  const cwd = unknownOptions.cwd === undefined
    ? undefined
    : yield* Schema.decodeUnknownEffect(WorkingDirectory)(unknownOptions.cwd).pipe(
      Effect.mapError(() => new AgentRuntimeMetadataError({ implementation, reason: "invalid-output" }))
    )
  const versionArguments = yield* Schema.decodeUnknownEffect(
    Schema.Array(VersionArgument).check(Schema.isMinLength(1), Schema.isMaxLength(8))
  )(unknownOptions.versionArguments ?? ["--version"]).pipe(
    Effect.mapError(() => new AgentRuntimeMetadataError({ implementation, reason: "invalid-output" }))
  )
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const command = ChildProcess.make(
    executable,
    [...versionArguments],
    {
      env: { PATH: path },
      extendEnv: false,
      forceKillAfter: "1 second",
      killSignal: "SIGTERM",
      shell: false,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
      ...(cwd === undefined ? {} : { cwd })
    }
  )
  const result = yield* Effect.scoped(
    Effect.gen(function*() {
      const handle = yield* spawner.spawn(command)
      const result = yield* Effect.all({
        exitCode: handle.exitCode,
        output: collectBounded(implementation, handle.stdout),
        stderr: Stream.runDrain(handle.stderr)
      }, { concurrency: "unbounded" })
      return {
        exitCode: result.exitCode,
        output: result.output
      }
    })
  ).pipe(
    Effect.timeout(DEFAULT_DISCOVERY_TIMEOUT),
    Effect.mapError((failure) =>
      isRuntimeMetadataError(failure)
        ? failure
        : new AgentRuntimeMetadataError({ implementation, reason: "unavailable" })
    )
  )
  if (result.exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new AgentRuntimeMetadataError({ implementation, reason: "unavailable" })
  }
  const firstLine = result.output.trim().split(/\r?\n/u, 1)[0] ?? ""
  const normalizedVersion = firstLine.startsWith(`${implementation} `)
    ? firstLine.slice(implementation.length + 1)
    : firstLine
  const version = yield* Schema.decodeUnknownEffect(RuntimeVersion)(normalizedVersion).pipe(
    Effect.mapError(() => new AgentRuntimeMetadataError({ implementation, reason: "invalid-output" }))
  )
  return AgentRuntimeMetadata.make({
    _tag: "local-cli",
    implementation,
    version
  })
})
