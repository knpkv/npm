import { Cause, Effect, Predicate, Stream } from "effect"
import type { Duration } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { ClaudeFailureCause, transportFailure, transportToAiError } from "./errors.js"
import type { ClaudeTransportError } from "./errors.js"
import { type ClaudeResult, decodeClaudeOutput } from "./protocol.js"

interface RunOptions {
  readonly access: "read-only" | "workspace-write"
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly executable: string
  readonly jsonSchema: string | undefined
  readonly maxOutputBytes: number
  readonly maxStderrBytes: number
  readonly model: string | undefined
  readonly prompt: string
  readonly timeout: Duration.Input
}

interface CollectedBytes {
  readonly chunks: ReadonlyArray<Uint8Array>
  readonly size: number
}

const collectBounded = (
  source: Stream.Stream<Uint8Array, unknown>,
  maximumBytes: number,
  label: string,
  method: string
): Effect.Effect<string, ClaudeTransportError> =>
  source.pipe(
    Stream.mapError((cause) =>
      transportFailure("process", `Failed while reading Claude CLI ${label} for ${method}`, cause)
    ),
    Stream.runFoldEffect(
      (): CollectedBytes => ({ chunks: [], size: 0 }),
      (collected, chunk) => {
        const size = collected.size + chunk.byteLength
        return size > maximumBytes
          ? Effect.fail(transportFailure(
            "process",
            `Claude CLI ${label} exceeded ${maximumBytes} bytes for ${method}`,
            new ClaudeFailureCause({ reason: `${label}-limit-exceeded` })
          ))
          : Effect.succeed({ chunks: [...collected.chunks, chunk], size })
      }
    ),
    Effect.flatMap((collected) =>
      Stream.fromIterable(collected.chunks).pipe(
        Stream.decodeText(),
        Stream.mkString,
        Effect.mapError((cause) =>
          transportFailure("process", `Claude CLI ${label} was not valid UTF-8 for ${method}`, cause)
        )
      )
    )
  )

const redactDiagnostic = (diagnostic: string, cwd: string): string => {
  const safeLines = diagnostic.split("\n").map((line) => {
    const lower = line.toLowerCase()
    return lower.includes("authorization") || lower.includes("api_key") || lower.includes("api key") ||
        lower.includes("token")
      ? "[redacted]"
      : line.replaceAll(cwd, "<cwd>")
  })
  return safeLines.join("\n").trim().slice(0, 1_000)
}

const makeArguments = (options: RunOptions): ReadonlyArray<string> => {
  const tools = options.access === "workspace-write" ? "Read,Glob,Grep,Edit,Write" : "Read,Glob,Grep"
  const permissionMode = options.access === "workspace-write" ? "acceptEdits" : "plan"
  const arguments_: Array<string> = [
    "--print",
    "--output-format",
    "json",
    "--input-format",
    "text",
    "--permission-mode",
    permissionMode,
    "--tools",
    tools,
    "--no-session-persistence",
    "--safe-mode"
  ]
  if (options.model !== undefined) arguments_.push("--model", options.model)
  if (options.jsonSchema !== undefined) arguments_.push("--json-schema", options.jsonSchema)
  return arguments_
}

const makeCommand = (options: RunOptions, arguments_: ReadonlyArray<string>) =>
  ChildProcess.make(options.executable, arguments_, {
    cwd: options.cwd,
    env: options.environment,
    extendEnv: false,
    forceKillAfter: "3 seconds",
    killSignal: "SIGTERM",
    shell: false,
    stderr: "pipe",
    stdin: { stream: Stream.make(options.prompt).pipe(Stream.encodeText), endOnDone: true },
    stdout: "pipe"
  })

export const runClaude = Effect.fn("ClaudeCliLanguageModel.runClaude")(function*(
  options: RunOptions,
  method: string,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
): Effect.fn.Return<ClaudeResult, ReturnType<typeof transportToAiError>> {
  const command = makeCommand(options, makeArguments(options))

  const execution = Effect.gen(function*() {
    const handle = yield* spawner.spawn(command).pipe(
      Effect.mapError((cause) => transportFailure("process", "Unable to start Claude CLI", cause))
    )
    const collected = yield* Effect.all({
      exitCode: handle.exitCode.pipe(
        Effect.mapError((cause) => transportFailure("process", "Unable to read Claude CLI exit status", cause))
      ),
      stderr: collectBounded(handle.stderr, options.maxStderrBytes, "stderr", method),
      stdout: collectBounded(handle.stdout, options.maxOutputBytes, "stdout", method)
    }, { concurrency: "unbounded" })

    if (collected.exitCode !== ChildProcessSpawner.ExitCode(0)) {
      const diagnostic = redactDiagnostic(collected.stderr, options.cwd)
      const suffix = diagnostic.length > 0 ? `: ${diagnostic}` : ""
      return yield* transportFailure(
        "process",
        `Claude CLI exited with code ${collected.exitCode}${suffix}`,
        new ClaudeFailureCause({ reason: `exit-${collected.exitCode}` })
      )
    }

    const result = yield* decodeClaudeOutput(collected.stdout, method)
    if (result.is_error) {
      return yield* transportFailure(
        "process",
        "Claude CLI returned an error result",
        new ClaudeFailureCause({ reason: "error-result" })
      )
    }
    return result
  }).pipe(Effect.scoped)

  return yield* execution.pipe(
    Effect.timeout(options.timeout),
    Effect.mapError((cause) => {
      if (Predicate.isTagged(cause, "ClaudeTransportError")) return transportToAiError(cause, method)
      if (Cause.isTimeoutError(cause)) {
        return transportToAiError(
          transportFailure("timeout", "Claude CLI timed out", cause),
          method
        )
      }
      return cause
    })
  )
})
