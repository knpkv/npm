import { Cause, Effect, Predicate, Stream } from "effect"
import type * as Duration from "effect/Duration"
import type * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { CodexFailureCause, CodexTransportError, sanitizeDiagnostic } from "./errors.js"

interface ByteAccumulator {
  readonly bytes: number
  readonly chunks: ReadonlyArray<Uint8Array>
}

interface RunCodexOptions {
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly executable: string
  readonly maxOutputBytes: number
  readonly maxStderrBytes: number
  readonly prompt: string
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly timeout: Duration.Input
}

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
        return Effect.fail(
          new CodexTransportError({
            cause: new CodexFailureCause({ reason: `${streamName}-limit-exceeded` }),
            diagnostic: `${streamName} exceeded ${maximumBytes} bytes`,
            phase: "process"
          })
        )
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

export const runCodex = Effect.fn("CodexProcess.run")(function*(
  options: RunCodexOptions
): Effect.fn.Return<string, CodexTransportError> {
  const command = ChildProcess.make(options.executable, options.args, {
    cwd: options.cwd,
    forceKillAfter: "2 seconds",
    killSignal: "SIGTERM",
    shell: false,
    stderr: "pipe",
    stdin: Stream.make(options.prompt).pipe(Stream.encodeText),
    stdout: "pipe"
  })

  const execution = Effect.scoped(Effect.gen(function*() {
    const handle = yield* options.spawner.spawn(command)
    return yield* Effect.all({
      exitCode: handle.exitCode,
      stderr: collectBounded(handle.stderr, options.maxStderrBytes, "stderr"),
      stdout: collectBounded(handle.stdout, options.maxOutputBytes, "stdout")
    }, { concurrency: "unbounded" })
  }))

  const result = yield* execution.pipe(
    Effect.timeout(options.timeout),
    Effect.mapError((cause) =>
      Predicate.isTagged(cause, "CodexTransportError")
        ? cause
        : transportError(
          Cause.isTimeoutError(cause) ? "timeout" : "process",
          Cause.isTimeoutError(cause) ? "Codex turn exceeded its timeout" : "Unable to execute Codex CLI",
          cause
        )
    )
  )

  if (result.exitCode !== 0) {
    return yield* transportError(
      "process",
      result.stderr.trim().length > 0 ? result.stderr : `Codex exited with code ${result.exitCode}`,
      new CodexFailureCause({ reason: `exit-${result.exitCode}` })
    )
  }

  return result.stdout
})
