import { Effect, Fiber, Schema, Stream } from "effect"
import type * as Duration from "effect/Duration"
import type * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { type NormalizedOptions, PROMPT_ONLY_DISABLED_FEATURES, PROMPT_ONLY_SAFE_FEATURES } from "./configuration.js"
import {
  CodexFailureCause,
  CodexTransportError,
  configurationFailure,
  invalidRequest,
  sanitizeDiagnostic
} from "./errors.js"

interface ByteAccumulator {
  readonly bytes: number
  readonly chunks: ReadonlyArray<Uint8Array>
}

interface RunCodexOptions {
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly executable: string
  readonly maxOutputBytes: number
  readonly maxStderrBytes: number
  readonly prompt: string
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly timeout: Duration.Input
}

const outputLimitError = (maximumBytes: number, streamName: "stderr" | "stdout"): CodexTransportError =>
  new CodexTransportError({
    cause: new CodexFailureCause({ reason: `${streamName}-limit-exceeded` }),
    diagnostic: `${streamName} exceeded ${maximumBytes} bytes`,
    phase: "process"
  })

const collectBounded = (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  maximumBytes: number,
  streamName: "stderr" | "stdout"
): Effect.Effect<string, PlatformError.PlatformError | CodexTransportError> =>
  Stream.runFoldEffect(
    stream,
    (): ByteAccumulator => ({ bytes: 0, chunks: [] }),
    (accumulator, chunk) => {
      const bytes = accumulator.bytes + chunk.byteLength
      if (bytes > maximumBytes) {
        return Effect.fail(outputLimitError(maximumBytes, streamName))
      }
      return Effect.succeed({
        bytes,
        chunks: [...accumulator.chunks, chunk]
      })
    }
  ).pipe(
    Effect.flatMap((accumulator) =>
      Stream.fromIterable(accumulator.chunks).pipe(
        Stream.decodeText(),
        Stream.mkString
      )
    )
  )

const transportError = (
  phase: "process" | "timeout",
  diagnostic: string,
  cause: unknown
): CodexTransportError =>
  new CodexTransportError({
    cause,
    diagnostic: sanitizeDiagnostic(diagnostic),
    phase
  })

const isCodexTransportError = Schema.is(CodexTransportError)

const makeCommand = (options: RunCodexOptions) =>
  Object.freeze(ChildProcess.make(
    options.executable,
    Object.freeze([...options.args]),
    Object.freeze({
      cwd: options.cwd,
      env: Object.freeze({ ...options.environment }),
      extendEnv: false,
      forceKillAfter: "2 seconds",
      killSignal: "SIGTERM",
      shell: false,
      stderr: "pipe",
      stdin: Object.freeze({
        stream: Stream.make(options.prompt).pipe(Stream.encodeText),
        endOnDone: true
      }),
      stdout: "pipe"
    })
  ))

const FEATURE_NAME = /^[a-z][a-z0-9_]*$/u

/** Negotiates the installed Codex manifest and rejects every unclassified feature. */
export const resolvePromptOnlyDisabledFeatures = Effect.fn(
  "CodexProcess.resolvePromptOnlyDisabledFeatures"
)(function*(
  options: NormalizedOptions,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  method: string
) {
  if (!options.promptOnly) return []

  const output = yield* spawner.string(makeCommand({
    args: ["features", "list"],
    cwd: options.cwd,
    environment: options.environment,
    executable: options.executable,
    maxOutputBytes: options.maxOutputBytes,
    maxStderrBytes: options.maxStderrBytes,
    prompt: "",
    spawner,
    timeout: options.timeout
  })).pipe(
    Effect.mapError((cause) => configurationFailure(method, cause))
  )
  const installed = new Set(
    output.split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u)[0] ?? "")
      .filter((name) => FEATURE_NAME.test(name))
  )
  if (installed.size === 0) {
    return yield* invalidRequest(method, "promptOnly", "installed Codex feature inventory is empty")
  }

  const classified = new Set([...PROMPT_ONLY_DISABLED_FEATURES, ...PROMPT_ONLY_SAFE_FEATURES])
  const unclassified = [...installed].filter((feature) => !classified.has(feature)).sort()
  if (unclassified.length > 0) {
    return yield* invalidRequest(
      method,
      "promptOnly",
      `installed Codex has unclassified features: ${unclassified.join(", ")}`
    )
  }
  return PROMPT_ONLY_DISABLED_FEATURES.filter((feature) => installed.has(feature))
})

const boundedStdout = (
  stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  maximumBytes: number
): Stream.Stream<Uint8Array, PlatformError.PlatformError | CodexTransportError> =>
  stdout.pipe(
    Stream.mapAccumEffect(
      () => 0,
      (bytes, chunk) => {
        const nextBytes = bytes + chunk.byteLength
        if (nextBytes > maximumBytes) return Effect.fail(outputLimitError(maximumBytes, "stdout"))
        const result: readonly [state: number, values: ReadonlyArray<Uint8Array>] = [nextBytes, [chunk]]
        return Effect.succeed(result)
      }
    )
  )

const processError = (cause: unknown): CodexTransportError =>
  isCodexTransportError(cause)
    ? cause
    : transportError("process", "Unable to execute Codex CLI", cause)

const verifyCompletion = Effect.fn("CodexProcess.verifyCompletion")(function*(
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>,
  stderrFiber: Fiber.Fiber<string, PlatformError.PlatformError | CodexTransportError>
) {
  const result = yield* Effect.all({
    exitCode,
    stderr: Fiber.join(stderrFiber)
  }, { concurrency: "unbounded" })

  if (result.exitCode !== 0) {
    return yield* transportError(
      "process",
      result.stderr.trim().length > 0 ? result.stderr : `Codex exited with code ${result.exitCode}`,
      new CodexFailureCause({ reason: `exit-${result.exitCode}` })
    )
  }
})

export const streamCodexLines = (options: RunCodexOptions): Stream.Stream<string, CodexTransportError> =>
  Stream.unwrap(Effect.gen(function*() {
    const handle = yield* options.spawner.spawn(makeCommand(options)).pipe(
      Effect.mapError(processError)
    )
    const stderrFiber = yield* collectBounded(handle.stderr, options.maxStderrBytes, "stderr").pipe(
      Effect.mapError(processError),
      Effect.forkScoped({ startImmediately: true })
    )
    const stderrFailure = Fiber.join(stderrFiber).pipe(
      Effect.matchEffect({
        onFailure: Effect.fail,
        onSuccess: () => Effect.never
      })
    )

    return boundedStdout(handle.stdout, options.maxOutputBytes).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.interruptWhen(stderrFailure),
      Stream.concat(Stream.fromEffectDrain(verifyCompletion(handle.exitCode, stderrFiber)))
    )
  })).pipe(
    Stream.interruptWhen(
      Effect.sleep(options.timeout).pipe(
        Effect.andThen(Effect.fail(transportError(
          "timeout",
          "Codex turn exceeded its timeout",
          new CodexFailureCause({ reason: "timeout" })
        )))
      )
    ),
    Stream.mapError(processError)
  )

export const runCodex = Effect.fn("CodexProcess.run")(function*(
  options: RunCodexOptions
): Effect.fn.Return<string, CodexTransportError> {
  return yield* streamCodexLines(options).pipe(
    Stream.intersperse("\n"),
    Stream.mkString
  )
})
