/** Writable, credential-free sbx session for one exact pull-request revision. @module */
import * as Cause from "effect/Cause"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { AgentThreadId, JobId, ReviewCommandArtifactId, WorkspaceId } from "../../../domain/identifiers.js"
import { AgentAttemptSequence } from "../../persistence/repositories/agentJobModels.js"
import {
  ReviewCommandArtifactHandle,
  ReviewCommandArtifactMetadata,
  type ReviewCommandArtifactPage,
  ReviewCommandArtifactRepository,
  type ReviewCommandArtifactRepositoryService,
  type ReviewCommandArtifactStream
} from "../../persistence/repositories/reviewCommandArtifactRepository.js"
import { PrReviewSourceError, type PrReviewSourceRequest, PrReviewSourceWorkspace } from "./PrReviewSourceWorkspace.js"
import { emitPrReviewTelemetry } from "./PrReviewTelemetry.js"
import { PR_REVIEW_AUTHORITY_CONFIG_PATTERN } from "./PrReviewWorkspaceProtocol.js"

const DEFAULT_SBX_EXECUTABLE = "sbx"
const SANDBOX_PREFIX = "cc-pr-review-"
const SANDBOX_JOB_TOKEN_LENGTH = 4
const CONTROL_TIMEOUT = Duration.seconds(30)
const SOURCE_HANDOFF_TIMEOUT = Duration.minutes(5)
const DEFAULT_COMMAND_TIMEOUT_MILLIS = 120_000
const MAXIMUM_COMMAND_TIMEOUT_MILLIS = 1_200_000
const DEFAULT_SESSION_TIMEOUT_MILLIS = 1_200_000
const MAXIMUM_SESSION_TIMEOUT_MILLIS = 1_800_000
const MAXIMUM_CONTROL_OUTPUT_BYTES = 64 * 1_024
const MAXIMUM_COMMAND_OUTPUT_BYTES = 16 * 1_024 * 1_024
const MAXIMUM_VISIBLE_OUTPUT_BYTES = 32 * 1_024
const MAXIMUM_PATCH_BYTES = 256 * 1_024
const MAXIMUM_ARTIFACT_PAGE_BYTES = 64 * 1_024
const NATIVE_CODEX_BASE_REF = "control-center-review-base"
const NATIVE_CODEX_OUTPUT_PATH = "/tmp/control-center-review-output.json"
const NATIVE_CODEX_SCHEMA_PATH = "/tmp/control-center-review-schema.json"

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true })

const GitRevision = Schema.String.check(
  Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, {
    expected: "a full lowercase Git object identifier"
  })
)

const SandboxAttemptId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{12}$/u, {
    expected: "a 12-character lowercase hexadecimal attempt identifier"
  })
)

const Executable = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => !value.includes("\u0000"), {
    expected: "an executable path without NUL bytes"
  })
)

const Template = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.makeFilter((value) => !value.includes("\u0000"), {
    expected: "an sbx template without NUL bytes"
  })
)

const RelativeSandboxPath = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.makeFilter(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("-") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment !== "..") &&
      Array.from(value).every((character) => {
        const codePoint = character.codePointAt(0)
        return codePoint !== undefined &&
          !((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
      }),
    { expected: "a relative Linux workspace path without traversal or control characters" }
  )
)

const CommandText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(16_384),
  Schema.makeFilter((value) => !value.includes("\u0000"), {
    expected: "a non-empty shell command without NUL bytes"
  })
)

const SearchText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.makeFilter((value) => !value.includes("\u0000"), {
    expected: "a non-empty search value without NUL bytes"
  })
)

const PositiveOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAXIMUM_ARTIFACT_PAGE_BYTES }))
const CommandTimeoutMillis = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAXIMUM_COMMAND_TIMEOUT_MILLIS })
)
const SessionTimeoutMillis = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAXIMUM_SESSION_TIMEOUT_MILLIS })
)
const PatchText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter(
    (value) => textEncoder.encode(value).byteLength <= MAXIMUM_PATCH_BYTES,
    { expected: `a patch encoded as at most ${MAXIMUM_PATCH_BYTES} UTF-8 bytes` }
  )
)

/** Opaque identifier for durable, expiring Review Sandbox output. */
export const PrReviewCommandArtifactId = ReviewCommandArtifactId
export type PrReviewCommandArtifactId = ReviewCommandArtifactId

/** Durable artifact identity safe to carry across worker-attempt recovery. */
export const PrReviewCommandArtifactHandle = ReviewCommandArtifactHandle
export type PrReviewCommandArtifactHandle = ReviewCommandArtifactHandle

const SessionRequest = Schema.Struct({
  workspaceId: WorkspaceId,
  threadId: AgentThreadId,
  jobId: JobId,
  attemptSequence: AgentAttemptSequence,
  repository: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,100}$/u)),
  attemptId: SandboxAttemptId,
  baseRevision: GitRevision,
  headRevision: GitRevision,
  providerId: Schema.optionalKey(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))),
  model: Schema.optionalKey(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))),
  reviewExecution: Schema.optionalKey(Schema.Literals(["effect-ai", "native-claude", "native-codex"]))
})

const NativeCodexReviewRequest = Schema.Struct({
  executable: Executable,
  prompt: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_048_576)),
  outputSchema: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_048_576)),
  model: Schema.optionalKey(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))),
  maximumDurationMillis: SessionTimeoutMillis
})

const NativeClaudeReviewRequest = Schema.Struct({
  executable: Executable,
  prompt: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_048_576)),
  outputSchema: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_048_576)),
  model: Schema.optionalKey(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))),
  maximumDurationMillis: SessionTimeoutMillis
})

const NativeClaudeReviewEnvelope = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.Literal("success"),
  is_error: Schema.Literal(false),
  structured_output: Schema.Unknown
})

const SessionOptions = Schema.Struct({
  executable: Schema.optionalKey(Executable),
  template: Schema.optionalKey(Template),
  maximumCommandDurationMillis: Schema.optionalKey(CommandTimeoutMillis),
  maximumSessionDurationMillis: Schema.optionalKey(SessionTimeoutMillis)
})

/** Exact review identity used to acquire a disposable writable session. */
export interface PrReviewSandboxSessionRequest extends PrReviewSourceRequest {
  readonly threadId: AgentThreadId
  readonly attemptSequence: AgentAttemptSequence
  readonly attemptId: string
  readonly reviewExecution?: "effect-ai" | "native-claude" | "native-codex"
  readonly providerId?: string
  readonly model?: string
}

/** Structured native Codex review material accepted only by Codex-backed sessions. */
export interface PrReviewNativeCodexRequest {
  readonly executable: string
  readonly prompt: string
  readonly outputSchema: string
  readonly model?: string
  readonly maximumDurationMillis: number
}

/** Structured native Claude review material accepted only by Claude-backed sessions. */
export interface PrReviewNativeClaudeRequest {
  readonly executable: string
  readonly prompt: string
  readonly outputSchema: string
  readonly model?: string
  readonly maximumDurationMillis: number
}

/** Trusted local construction material for the sbx Review Sandbox runtime. */
export interface PrReviewSandboxSessionOptions {
  readonly executable?: string
  readonly template?: string
  readonly maximumCommandDurationMillis?: number
  readonly maximumSessionDurationMillis?: number
}

/** Stable redacted session failures; host paths, commands, output, and credentials are omitted. */
export class PrReviewSandboxSessionError extends Schema.TaggedErrorClass<PrReviewSandboxSessionError>()(
  "PrReviewSandboxSessionError",
  {
    reason: Schema.Literals([
      "invalid-configuration",
      "invalid-request",
      "source-unavailable",
      "sandbox-unavailable",
      "sandbox-timeout",
      "command-timeout",
      "output-rejected",
      "artifact-unavailable",
      "session-closed",
      "cleanup-failed"
    ])
  }
) {}

const sessionError = (
  reason: PrReviewSandboxSessionError["reason"]
): PrReviewSandboxSessionError => new PrReviewSandboxSessionError({ reason })

const isSessionError = Schema.is(PrReviewSandboxSessionError)

/** Bounded output plus an optional handle to the complete retained bytes. */
export interface PrReviewSandboxOutput {
  readonly artifact: PrReviewCommandArtifactHandle | null
  readonly byteLength: number
  readonly text: string
  readonly truncated: boolean
}

/** One contained shell-command result. Non-zero exits remain inspectable data. */
export interface PrReviewSandboxCommandResult {
  readonly exitCode: number
  readonly stderr: PrReviewSandboxOutput
  readonly stdout: PrReviewSandboxOutput
}

/** A live sbx session. `close` is idempotent and every other operation fails after it. */
export interface PrReviewSandboxSession {
  readonly attemptId: string
  readonly baseRevision: string
  readonly headRevision: string
  readonly jobId: JobId
  readonly readFile: (
    path: string,
    offset?: number,
    limit?: number
  ) => Effect.Effect<PrReviewSandboxCommandResult, PrReviewSandboxSessionError>
  readonly listFiles: (
    path?: string
  ) => Effect.Effect<PrReviewSandboxCommandResult, PrReviewSandboxSessionError>
  readonly searchFiles: (
    query: string,
    path?: string
  ) => Effect.Effect<PrReviewSandboxCommandResult, PrReviewSandboxSessionError>
  readonly runCommand: (
    command: string,
    maximumDurationMillis?: number
  ) => Effect.Effect<PrReviewSandboxCommandResult, PrReviewSandboxSessionError>
  readonly applyPatch: (
    patch: string
  ) => Effect.Effect<PrReviewSandboxCommandResult, PrReviewSandboxSessionError>
  readonly readDiff: () => Effect.Effect<PrReviewSandboxCommandResult, PrReviewSandboxSessionError>
  readonly listArtifacts: () => Effect.Effect<
    ReadonlyArray<typeof ReviewCommandArtifactMetadata.Type>,
    PrReviewSandboxSessionError
  >
  readonly pageArtifact: (
    artifact: PrReviewCommandArtifactHandle,
    offset: number,
    limit: number
  ) => Effect.Effect<ReviewCommandArtifactPage, PrReviewSandboxSessionError>
  readonly searchArtifact: (
    artifact: PrReviewCommandArtifactHandle,
    query: string
  ) => Effect.Effect<ReadonlyArray<number>, PrReviewSandboxSessionError>
  readonly runNativeCodexReview?: (
    request: PrReviewNativeCodexRequest
  ) => Effect.Effect<PrReviewSandboxCommandResult, PrReviewSandboxSessionError>
  readonly runNativeClaudeReview?: (
    request: PrReviewNativeClaudeRequest
  ) => Effect.Effect<PrReviewSandboxCommandResult, PrReviewSandboxSessionError>
  readonly close: Effect.Effect<void, PrReviewSandboxSessionError>
}

/** Startup cleanup report for stale Review Sandboxes. */
export interface PrReviewSandboxReconciliation {
  readonly removedSandboxes: ReadonlyArray<string>
  /** Live server-private sandboxes retained for recovery inspection. */
  readonly reattachedSandboxes?: ReadonlyArray<string>
  /** Parsed identity coordinates used to attribute live sandboxes to attempts. */
  readonly reattachedSandboxIdentities?: ReadonlyArray<{
    readonly name: string
    readonly jobToken: string
    readonly attemptId: string
  }>
}

/** Session owner. The callback is scoped to the sbx sandbox lifetime. */
export class PrReviewSandboxSessions extends Context.Service<
  PrReviewSandboxSessions,
  {
    readonly withSession: <Success, Failure, Requirements>(
      request: PrReviewSandboxSessionRequest,
      use: (
        session: PrReviewSandboxSession
      ) => Effect.Effect<Success, Failure, Requirements>
    ) => Effect.Effect<
      Success,
      Failure | PrReviewSandboxSessionError,
      Requirements
    >
    readonly reconcile: (workspaceId: WorkspaceId) => Effect.Effect<
      PrReviewSandboxReconciliation,
      PrReviewSandboxSessionError
    >
    /** Remove only names already attributed as unmatched by startup recovery. */
    readonly cleanupUnmatched?: (
      names: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyArray<string>, PrReviewSandboxSessionError>
  }
>()("@knpkv/control-center/server/agent/internal/PrReviewSandboxSessions") {}

interface ProcessResult {
  readonly exitCode: ChildProcessSpawner.ExitCode
  readonly stderr: Uint8Array
  readonly stdout: Uint8Array
}

interface ByteAccumulator {
  readonly chunks: Array<Uint8Array>
  readonly length: number
}

const concatenate = ({ chunks, length }: ByteAccumulator): Uint8Array => {
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

const collectBounded = (
  stream: Stream.Stream<Uint8Array, unknown>,
  maximumBytes: number,
  reason: PrReviewSandboxSessionError["reason"]
): Effect.Effect<Uint8Array, PrReviewSandboxSessionError> =>
  stream.pipe(
    Stream.runFoldEffect(
      (): ByteAccumulator => ({ chunks: [], length: 0 }),
      (accumulator, chunk) => {
        const length = accumulator.length + chunk.byteLength
        if (length > maximumBytes) return Effect.fail(sessionError(reason))
        accumulator.chunks.push(Uint8Array.from(chunk))
        return Effect.succeed({ chunks: accumulator.chunks, length })
      }
    ),
    Effect.map(concatenate),
    Effect.mapError(() => sessionError(reason))
  )

const successful = (result: ProcessResult): boolean => result.exitCode === ChildProcessSpawner.ExitCode(0)

const execute = Effect.fnUntraced(
  function*(
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    executable: string,
    environment: Readonly<Record<string, string>>,
    args: ReadonlyArray<string>,
    maximumOutputBytes: number,
    timeout: Duration.Input,
    input?: Uint8Array
  ) {
    return yield* Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* spawner.spawn(
          ChildProcess.make(executable, args, {
            env: environment,
            extendEnv: false,
            forceKillAfter: Duration.seconds(5),
            shell: false,
            stdin: input === undefined ? "ignore" : Stream.make(input),
            stdout: "pipe",
            stderr: "pipe"
          })
        ).pipe(Effect.mapError(() => sessionError("sandbox-unavailable")))
        const [exitCode, stderr, stdout] = yield* Effect.all([
          handle.exitCode.pipe(Effect.mapError(() => sessionError("sandbox-unavailable"))),
          collectBounded(handle.stderr, maximumOutputBytes, "output-rejected"),
          collectBounded(handle.stdout, maximumOutputBytes, "output-rejected")
        ], { concurrency: "unbounded" })
        return { exitCode, stderr, stdout } satisfies ProcessResult
      })
    ).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(sessionError("command-timeout"))
      })
    )
  },
  Effect.withTracerEnabled(false)
)

const decodeUtf8 = (
  bytes: Uint8Array,
  reason: PrReviewSandboxSessionError["reason"]
): Effect.Effect<string, PrReviewSandboxSessionError> =>
  Effect.try({
    try: () => textDecoder.decode(bytes),
    catch: () => sessionError(reason)
  })

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const compactUuid = (identifier: WorkspaceId | JobId): string => identifier.replaceAll("-", "")

const workspaceSandboxPrefix = (workspaceId: WorkspaceId): string => `${SANDBOX_PREFIX}${compactUuid(workspaceId)}-`

const sandboxName = (
  workspaceId: WorkspaceId,
  jobId: JobId,
  attemptId: string
): string => `${workspaceSandboxPrefix(workspaceId)}${compactUuid(jobId).slice(-SANDBOX_JOB_TOKEN_LENGTH)}-${attemptId}`

const visiblePrefix = (bytes: Uint8Array): Uint8Array => {
  let end = Math.min(bytes.byteLength, MAXIMUM_VISIBLE_OUTPUT_BYTES)
  while (end > 0 && end < bytes.byteLength && (bytes[end] ?? 0) >> 6 === 0b10) {
    end -= 1
  }
  return bytes.slice(0, end)
}

const makeCommandOutputs = Effect.fnUntraced(function*(
  artifacts: ReviewCommandArtifactRepositoryService,
  request: typeof SessionRequest.Type,
  commandSequence: number,
  stderrBytes: Uint8Array,
  stdoutBytes: Uint8Array
) {
  const decoded = {
    stderr: yield* decodeUtf8(stderrBytes, "output-rejected"),
    stdout: yield* decodeUtf8(stdoutBytes, "output-rejected")
  }
  const candidates: ReadonlyArray<
    readonly [ReviewCommandArtifactStream, Uint8Array, string]
  > = [
    ["stderr", stderrBytes, decoded.stderr],
    ["stdout", stdoutBytes, decoded.stdout]
  ]
  const retained = candidates.filter(([, bytes]) => bytes.byteLength > MAXIMUM_VISIBLE_OUTPUT_BYTES)
  const metadata = retained.length === 0
    ? []
    : yield* artifacts.createCommand({
      workspaceId: request.workspaceId,
      threadId: request.threadId,
      jobId: request.jobId,
      attemptSequence: request.attemptSequence,
      commandSequence,
      artifacts: retained.map(([stream, , content]) => ({ stream, content }))
    }).pipe(Effect.mapError(() => sessionError("artifact-unavailable")))
  const output = (
    stream: ReviewCommandArtifactStream,
    bytes: Uint8Array,
    complete: string
  ): Effect.Effect<PrReviewSandboxOutput, PrReviewSandboxSessionError> =>
    bytes.byteLength <= MAXIMUM_VISIBLE_OUTPUT_BYTES
      ? Effect.succeed({
        artifact: null,
        byteLength: bytes.byteLength,
        text: complete,
        truncated: false
      })
      : Effect.gen(function*() {
        const artifact = metadata.find((candidate) => candidate.stream === stream)
        if (artifact === undefined) return yield* sessionError("artifact-unavailable")
        return {
          artifact: PrReviewCommandArtifactHandle.make({
            artifactId: artifact.artifactId,
            attemptSequence: artifact.attemptSequence,
            commandSequence: artifact.commandSequence,
            stream: artifact.stream
          }),
          byteLength: bytes.byteLength,
          text: yield* decodeUtf8(visiblePrefix(bytes), "output-rejected"),
          truncated: true
        }
      })
  return {
    stderr: yield* output("stderr", stderrBytes, decoded.stderr),
    stdout: yield* output("stdout", stdoutBytes, decoded.stdout)
  }
}, Effect.withTracerEnabled(false))

const makeSessions = Effect.fn("PrReviewSandboxSessions.make")(function*(
  unknownOptions: PrReviewSandboxSessionOptions
) {
  const options = yield* Schema.decodeUnknownEffect(SessionOptions)(unknownOptions).pipe(
    Effect.mapError(() => sessionError("invalid-configuration"))
  )
  const sourceWorkspace = yield* PrReviewSourceWorkspace
  const artifacts = yield* ReviewCommandArtifactRepository
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const home = yield* Config.string("HOME").pipe(
    Effect.mapError(() => sessionError("invalid-configuration"))
  )
  const path = yield* Config.string("PATH").pipe(
    Effect.mapError(() => sessionError("invalid-configuration"))
  )
  const executable = options.executable ?? DEFAULT_SBX_EXECUTABLE
  const maximumCommandDurationMillis = options.maximumCommandDurationMillis ?? DEFAULT_COMMAND_TIMEOUT_MILLIS
  const maximumSessionDurationMillis = options.maximumSessionDurationMillis ?? DEFAULT_SESSION_TIMEOUT_MILLIS
  const hostEnvironment = {
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: path
  }
  const runControl = (
    args: ReadonlyArray<string>,
    timeout: Duration.Input = CONTROL_TIMEOUT,
    environment: Readonly<Record<string, string>> = hostEnvironment
  ) =>
    execute(
      spawner,
      executable,
      environment,
      args,
      MAXIMUM_CONTROL_OUTPUT_BYTES,
      timeout
    ).pipe(
      Effect.mapError((failure) =>
        failure.reason === "command-timeout"
          ? sessionError("sandbox-timeout")
          : failure
      )
    )

  const forceRemoveSandbox = Effect.fn("PrReviewSandboxSession.forceRemoveSandbox")(function*(name: string) {
    const removed = yield* runControl(["rm", "--force", name])
    if (!successful(removed)) return yield* sessionError("cleanup-failed")
  })

  const removeSandbox = Effect.fn("PrReviewSandboxSession.removeSandbox")(function*(name: string) {
    const listed = yield* runControl(["ls", "--quiet"])
    if (!successful(listed)) return yield* sessionError("cleanup-failed")
    const names = (yield* decodeUtf8(listed.stdout, "cleanup-failed")).split("\n")
    if (!names.includes(name)) return
    yield* forceRemoveSandbox(name)
  })

  const withSession = Effect.fnUntraced(function*<
    Success,
    Failure,
    Requirements
  >(
    unknownRequest: PrReviewSandboxSessionRequest,
    use: (session: PrReviewSandboxSession) => Effect.Effect<Success, Failure, Requirements>
  ) {
    const request = yield* Schema.decodeUnknownEffect(SessionRequest)(unknownRequest).pipe(
      Effect.mapError(() => sessionError("invalid-request"))
    )
    const name = sandboxName(request.workspaceId, request.jobId, request.attemptId)
    const nativeCodex = request.reviewExecution === "native-codex"
    const nativeClaude = request.reviewExecution === "native-claude"
    const nativeAgent = nativeCodex || nativeClaude
    return yield* sourceWorkspace.withSource(
      request,
      (sourceRoot) =>
        Effect.acquireUseRelease(
          runControl(
            nativeAgent
              ? [
                "run",
                nativeCodex ? "codex" : "claude",
                sourceRoot,
                "--clone",
                "--name",
                name,
                "--detached"
              ]
              : [
                "create",
                "shell",
                sourceRoot,
                "--clone",
                "--name",
                name,
                "--quiet",
                ...(options.template === undefined ? [] : ["--template", options.template])
              ],
            SOURCE_HANDOFF_TIMEOUT,
            hostEnvironment
          ).pipe(
            Effect.flatMap((created) =>
              successful(created)
                ? Effect.succeed(name)
                : Effect.fail(sessionError("sandbox-unavailable"))
            ),
            Effect.tapError(() => forceRemoveSandbox(name).pipe(Effect.ignore))
          ),
          () =>
            Effect.gen(function*() {
              if (!nativeAgent) {
                const denied = yield* runControl([
                  "policy",
                  "deny",
                  "network",
                  "--sandbox",
                  name,
                  "**"
                ])
                if (!successful(denied)) return yield* sessionError("sandbox-unavailable")
              }

              const closed = yield* Ref.make(false)
              const commandSequence = yield* Ref.make(0)

              const executeObserved = Effect.fnUntraced(function*(
                phase: string,
                commandName: string,
                args: ReadonlyArray<string>,
                maximumOutputBytes: number,
                timeout: Duration.Input,
                input?: Uint8Array
              ) {
                const startedAt = yield* DateTime.now
                const execution = yield* Effect.exit(execute(
                  spawner,
                  executable,
                  hostEnvironment,
                  args,
                  maximumOutputBytes,
                  timeout,
                  input
                ))
                const completedAt = yield* DateTime.now
                if (Exit.isFailure(execution)) {
                  const failure = Cause.findErrorOption(execution.cause)
                  yield* emitPrReviewTelemetry({
                    workspaceId: request.workspaceId,
                    jobId: request.jobId,
                    attemptSequence: request.attemptSequence,
                    revision: request.headRevision,
                    provider: request.providerId ?? "unknown",
                    model: request.model ?? null,
                    cli: request.reviewExecution ?? "effect-ai",
                    phase,
                    commandName,
                    durationMillis: Math.max(
                      0,
                      DateTime.toEpochMillis(completedAt) - DateTime.toEpochMillis(startedAt)
                    ),
                    exitStatus: null,
                    stdoutBytes: 0,
                    stderrBytes: 0,
                    suggestionCount: 0,
                    noteCount: 0,
                    errorType: Option.isSome(failure) && isSessionError(failure.value)
                      ? failure.value.reason
                      : "execution-failed"
                  })
                  return yield* Effect.failCause(execution.cause)
                }
                const result = execution.value
                yield* emitPrReviewTelemetry({
                  workspaceId: request.workspaceId,
                  jobId: request.jobId,
                  attemptSequence: request.attemptSequence,
                  revision: request.headRevision,
                  provider: request.providerId ?? "unknown",
                  model: request.model ?? null,
                  cli: request.reviewExecution ?? "effect-ai",
                  phase,
                  commandName,
                  durationMillis: Math.max(
                    0,
                    DateTime.toEpochMillis(completedAt) - DateTime.toEpochMillis(startedAt)
                  ),
                  exitStatus: Number(result.exitCode),
                  stdoutBytes: result.stdout.byteLength,
                  stderrBytes: result.stderr.byteLength,
                  suggestionCount: 0,
                  noteCount: 0,
                  errorType: successful(result) ? null : "non-zero-exit"
                })
                return result
              })

              const close = Ref.getAndSet(closed, true).pipe(
                Effect.flatMap((wasClosed) => wasClosed ? Effect.void : removeSandbox(name))
              )

              const executeContained = Effect.fn("PrReviewSandboxSession.executeContained")(function*(
                commandText: string,
                durationMillis: number,
                input?: Uint8Array
              ) {
                if (yield* Ref.get(closed)) return yield* sessionError("session-closed")
                return yield* executeObserved(
                  "sandbox-command",
                  "review-command",
                  [
                    "exec",
                    ...(input === undefined ? [] : ["--interactive"]),
                    "--workdir",
                    sourceRoot,
                    name,
                    "env",
                    "-i",
                    "HOME=/tmp",
                    "LANG=C",
                    "LC_ALL=C",
                    "PATH=/usr/local/bin:/usr/bin:/bin",
                    "/bin/sh",
                    "-lc",
                    commandText
                  ],
                  MAXIMUM_COMMAND_OUTPUT_BYTES,
                  Duration.millis(durationMillis),
                  input
                )
              })

              const runContainedCommand = Effect.fn(
                "PrReviewSandboxSession.runContainedCommand"
              )(function*(commandText: string, durationMillis: number, input?: Uint8Array) {
                const result = yield* executeContained(commandText, durationMillis, input)
                const sequence = yield* Ref.updateAndGet(commandSequence, (current) => current + 1)
                return {
                  exitCode: result.exitCode,
                  ...yield* makeCommandOutputs(
                    artifacts,
                    request,
                    sequence,
                    result.stderr,
                    result.stdout
                  )
                } satisfies PrReviewSandboxCommandResult
              })

              const runCommand = Effect.fn("PrReviewSandboxSession.runCommand")(function*(
                unknownCommand: string,
                unknownDuration = maximumCommandDurationMillis
              ) {
                const commandText = yield* Schema.decodeUnknownEffect(CommandText)(unknownCommand).pipe(
                  Effect.mapError(() => sessionError("invalid-request"))
                )
                const durationMillis = yield* Schema.decodeUnknownEffect(CommandTimeoutMillis)(unknownDuration).pipe(
                  Effect.mapError(() => sessionError("invalid-request"))
                )
                return yield* runContainedCommand(
                  commandText,
                  Math.min(durationMillis, maximumCommandDurationMillis)
                )
              })

              const runNativeCodexReview = nativeCodex
                ? Effect.fn("PrReviewSandboxSession.runNativeCodexReview")(function*(
                  unknownRequest: PrReviewNativeCodexRequest
                ) {
                  const nativeRequest = yield* Schema.decodeUnknownEffect(
                    NativeCodexReviewRequest
                  )(unknownRequest).pipe(
                    Effect.mapError(() => sessionError("invalid-request"))
                  )
                  if (yield* Ref.get(closed)) return yield* sessionError("session-closed")
                  const schemaWritten = yield* executeContained(
                    `umask 077 && cat > ${shellQuote(NATIVE_CODEX_SCHEMA_PATH)} && ` +
                      `rm -f -- ${shellQuote(NATIVE_CODEX_OUTPUT_PATH)}`,
                    maximumCommandDurationMillis,
                    textEncoder.encode(nativeRequest.outputSchema)
                  )
                  if (!successful(schemaWritten)) return yield* sessionError("sandbox-unavailable")
                  const reviewed = yield* executeObserved(
                    "native-review",
                    "codex",
                    [
                      "exec",
                      "--interactive",
                      "--workdir",
                      sourceRoot,
                      name,
                      nativeRequest.executable,
                      "exec",
                      "--ephemeral",
                      "--ignore-rules",
                      "--ignore-user-config",
                      "--dangerously-bypass-approvals-and-sandbox",
                      "-c",
                      "project_doc_max_bytes=0",
                      "-c",
                      "mcp_servers={}",
                      "--output-schema",
                      NATIVE_CODEX_SCHEMA_PATH,
                      "--output-last-message",
                      NATIVE_CODEX_OUTPUT_PATH,
                      ...(nativeRequest.model === undefined ? [] : ["--model", nativeRequest.model]),
                      "-"
                    ],
                    MAXIMUM_COMMAND_OUTPUT_BYTES,
                    Duration.millis(
                      Math.min(
                        nativeRequest.maximumDurationMillis,
                        maximumSessionDurationMillis
                      )
                    ),
                    textEncoder.encode(nativeRequest.prompt)
                  )
                  if (!successful(reviewed)) {
                    const safeDiagnostic = new TextDecoder("utf-8", { fatal: false })
                      .decode(reviewed.stderr)
                      .match(/Invalid schema for response_format[^"\n]*/u)?.[0]
                    if (safeDiagnostic !== undefined) {
                      yield* Effect.logWarning("Native Codex rejected the response schema", {
                        diagnostic: safeDiagnostic
                      })
                    }
                    const sequence = yield* Ref.updateAndGet(commandSequence, (current) => current + 1)
                    return {
                      exitCode: reviewed.exitCode,
                      ...yield* makeCommandOutputs(
                        artifacts,
                        request,
                        sequence,
                        reviewed.stderr,
                        reviewed.stdout
                      )
                    } satisfies PrReviewSandboxCommandResult
                  }
                  return yield* runContainedCommand(
                    `test -s ${shellQuote(NATIVE_CODEX_OUTPUT_PATH)} && ` +
                      `cat -- ${shellQuote(NATIVE_CODEX_OUTPUT_PATH)}`,
                    maximumCommandDurationMillis
                  )
                })
                : undefined

              const runNativeClaudeReview = nativeClaude
                ? Effect.fn("PrReviewSandboxSession.runNativeClaudeReview")(function*(
                  unknownRequest: PrReviewNativeClaudeRequest
                ) {
                  const nativeRequest = yield* Schema.decodeUnknownEffect(
                    NativeClaudeReviewRequest
                  )(unknownRequest).pipe(
                    Effect.mapError(() => sessionError("invalid-request"))
                  )
                  if (yield* Ref.get(closed)) return yield* sessionError("session-closed")
                  const reviewed = yield* executeObserved(
                    "native-review",
                    "claude",
                    [
                      "exec",
                      "--interactive",
                      "--workdir",
                      sourceRoot,
                      name,
                      nativeRequest.executable,
                      "-p",
                      "--output-format",
                      "json",
                      "--json-schema",
                      nativeRequest.outputSchema,
                      "--dangerously-skip-permissions",
                      "--no-session-persistence",
                      "--safe-mode",
                      "--setting-sources",
                      "",
                      "--strict-mcp-config",
                      "--mcp-config",
                      "{\"mcpServers\":{}}",
                      ...(nativeRequest.model === undefined ? [] : ["--model", nativeRequest.model]),
                      "--tools",
                      "Bash,Glob,Grep,Read"
                    ],
                    MAXIMUM_COMMAND_OUTPUT_BYTES,
                    Duration.millis(
                      Math.min(
                        nativeRequest.maximumDurationMillis,
                        maximumSessionDurationMillis
                      )
                    ),
                    textEncoder.encode(nativeRequest.prompt)
                  )
                  if (!successful(reviewed)) {
                    const sequence = yield* Ref.updateAndGet(commandSequence, (current) => current + 1)
                    return {
                      exitCode: reviewed.exitCode,
                      ...yield* makeCommandOutputs(
                        artifacts,
                        request,
                        sequence,
                        reviewed.stderr,
                        reviewed.stdout
                      )
                    } satisfies PrReviewSandboxCommandResult
                  }
                  const envelope = yield* Schema.decodeUnknownEffect(
                    Schema.fromJsonString(NativeClaudeReviewEnvelope),
                    { onExcessProperty: "ignore" }
                  )(yield* decodeUtf8(reviewed.stdout, "output-rejected")).pipe(
                    Effect.mapError(() => sessionError("output-rejected"))
                  )
                  const structuredOutput = yield* Effect.try({
                    try: () => JSON.stringify(envelope.structured_output),
                    catch: () => sessionError("output-rejected")
                  }).pipe(
                    Effect.filterOrFail(
                      (value): value is string => value !== undefined,
                      () => sessionError("output-rejected")
                    )
                  )
                  const sequence = yield* Ref.updateAndGet(commandSequence, (current) => current + 1)
                  return {
                    exitCode: reviewed.exitCode,
                    ...yield* makeCommandOutputs(
                      artifacts,
                      request,
                      sequence,
                      reviewed.stderr,
                      textEncoder.encode(structuredOutput)
                    )
                  } satisfies PrReviewSandboxCommandResult
                })
                : undefined

              const safePath = (unknownPath: string) =>
                Schema.decodeUnknownEffect(RelativeSandboxPath)(unknownPath).pipe(
                  Effect.mapError(() => sessionError("invalid-request"))
                )

              const session: PrReviewSandboxSession = {
                attemptId: request.attemptId,
                baseRevision: request.baseRevision,
                headRevision: request.headRevision,
                jobId: request.jobId,
                runCommand,
                readFile: (unknownPath, offset = 0, limit = 32_768) =>
                  Effect.gen(function*() {
                    const safe = yield* safePath(unknownPath)
                    const decodedOffset = yield* Schema.decodeUnknownEffect(PositiveOffset)(offset).pipe(
                      Effect.mapError(() => sessionError("invalid-request"))
                    )
                    const decodedLimit = yield* Schema.decodeUnknownEffect(PositiveLimit)(limit).pipe(
                      Effect.mapError(() => sessionError("invalid-request"))
                    )
                    return yield* runCommand(
                      `test -f ${shellQuote(safe)} && ` +
                        `tail -c +${String(decodedOffset + 1)} -- ${shellQuote(safe)} | ` +
                        `head -c ${String(decodedLimit)}`
                    )
                  }),
                listFiles: (unknownPath = ".") =>
                  Effect.gen(function*() {
                    const safe = yield* safePath(unknownPath)
                    const operand = safe === "." ? "." : `./${safe}`
                    return yield* runCommand(
                      `find ${shellQuote(operand)} -mindepth 1 -maxdepth 1 -print | LC_ALL=C sort`
                    )
                  }),
                searchFiles: (unknownQuery, unknownPath = ".") =>
                  Effect.gen(function*() {
                    const query = yield* Schema.decodeUnknownEffect(SearchText)(unknownQuery).pipe(
                      Effect.mapError(() => sessionError("invalid-request"))
                    )
                    const safe = yield* safePath(unknownPath)
                    return yield* runCommand(
                      `grep -RInF --exclude-dir=.git -- ${shellQuote(query)} ${shellQuote(safe)}`
                    )
                  }),
                applyPatch: (unknownPatch) =>
                  Effect.gen(function*() {
                    const patch = yield* Schema.decodeUnknownEffect(PatchText)(unknownPatch).pipe(
                      Effect.mapError(() => sessionError("invalid-request"))
                    )
                    return yield* runContainedCommand(
                      "git apply --whitespace=nowarn --",
                      maximumCommandDurationMillis,
                      textEncoder.encode(patch)
                    )
                  }),
                readDiff: () =>
                  runCommand(
                    "git add --intent-to-add -- . && " +
                      "git -c core.quotePath=false diff --no-ext-diff --no-textconv --no-color HEAD -- ."
                  ),
                listArtifacts: () =>
                  Effect.gen(function*() {
                    if (yield* Ref.get(closed)) return yield* sessionError("session-closed")
                    return yield* artifacts.list({
                      workspaceId: request.workspaceId,
                      threadId: request.threadId,
                      jobId: request.jobId,
                      limit: 256
                    }).pipe(Effect.mapError(() => sessionError("artifact-unavailable")))
                  }),
                pageArtifact: (unknownArtifact, unknownOffset, unknownLimit) =>
                  Effect.gen(function*() {
                    if (yield* Ref.get(closed)) return yield* sessionError("session-closed")
                    const artifact = yield* Schema.decodeUnknownEffect(
                      PrReviewCommandArtifactHandle
                    )(unknownArtifact).pipe(Effect.mapError(() => sessionError("invalid-request")))
                    const offset = yield* Schema.decodeUnknownEffect(PositiveOffset)(unknownOffset).pipe(
                      Effect.mapError(() => sessionError("invalid-request"))
                    )
                    const limit = yield* Schema.decodeUnknownEffect(PositiveLimit)(unknownLimit).pipe(
                      Effect.mapError(() => sessionError("invalid-request"))
                    )
                    return yield* artifacts.page({
                      workspaceId: request.workspaceId,
                      threadId: request.threadId,
                      jobId: request.jobId,
                      ...artifact,
                      offset,
                      limit
                    }).pipe(Effect.mapError(() => sessionError("artifact-unavailable")))
                  }),
                searchArtifact: (unknownArtifact, unknownQuery) =>
                  Effect.gen(function*() {
                    if (yield* Ref.get(closed)) return yield* sessionError("session-closed")
                    const artifact = yield* Schema.decodeUnknownEffect(
                      PrReviewCommandArtifactHandle
                    )(unknownArtifact).pipe(Effect.mapError(() => sessionError("invalid-request")))
                    const query = yield* Schema.decodeUnknownEffect(SearchText)(unknownQuery).pipe(
                      Effect.mapError(() => sessionError("invalid-request"))
                    )
                    return yield* artifacts.search({
                      workspaceId: request.workspaceId,
                      threadId: request.threadId,
                      jobId: request.jobId,
                      ...artifact,
                      query
                    }).pipe(Effect.mapError(() => sessionError("artifact-unavailable")))
                  }),
                ...(runNativeCodexReview === undefined ? {} : { runNativeCodexReview }),
                ...(runNativeClaudeReview === undefined ? {} : { runNativeClaudeReview }),
                close
              }

              const prepared = yield* runCommand(
                "for remote in $(git remote); do git remote remove \"$remote\"; done && " +
                  "git config --local --unset-all credential.helper >/dev/null 2>&1 || true; " +
                  "test \"$(git rev-parse --verify HEAD)\" = " +
                  shellQuote(request.headRevision) +
                  " && test -z \"$(git remote)\" && " +
                  "authority_keys=$(git config --local --name-only --get-regexp '.*' || true) && " +
                  "! printf '%s\\n' \"$authority_keys\" | LC_ALL=C tr '[:upper:]' '[:lower:]' | grep -E " +
                  shellQuote(PR_REVIEW_AUTHORITY_CONFIG_PATTERN) +
                  (nativeAgent
                    ? " && git branch --force " +
                      shellQuote(NATIVE_CODEX_BASE_REF) +
                      " " +
                      shellQuote(request.baseRevision)
                    : "")
              )
              if (prepared.exitCode !== 0) return yield* sessionError("source-unavailable")

              return yield* use(session).pipe(
                Effect.timeoutOrElse({
                  duration: Duration.millis(maximumSessionDurationMillis),
                  orElse: () => Effect.fail(sessionError("sandbox-timeout"))
                })
              )
            }),
          () => removeSandbox(name)
        )
    ).pipe(
      Effect.mapError((failure) =>
        isSessionError(failure)
          ? failure
          : Schema.is(PrReviewSourceError)(failure)
          ? sessionError("source-unavailable")
          : failure
      )
    )
  }, Effect.withTracerEnabled(false))

  const reconcile = Effect.fn("PrReviewSandboxSessions.reconcile")(function*(
    workspaceId: WorkspaceId
  ) {
    const listed = yield* runControl(["ls", "--quiet"])
    if (!successful(listed)) return yield* sessionError("sandbox-unavailable")
    const text = yield* decodeUtf8(listed.stdout, "sandbox-unavailable")
    const ownedPrefix = workspaceSandboxPrefix(workspaceId)
    const names = text.split("\n")
      .filter((name) => name.startsWith(ownedPrefix))
      .sort()
    const identityPattern = new RegExp(`^${ownedPrefix}([a-f0-9]{${SANDBOX_JOB_TOKEN_LENGTH}})-([a-f0-9]{12})$`, "u")
    const identities = names.flatMap((name) => {
      const match = identityPattern.exec(name)
      return match === null || match[1] === undefined || match[2] === undefined
        ? []
        : [{ name, jobToken: match[1], attemptId: match[2] }]
    })
    return {
      removedSandboxes: [],
      reattachedSandboxes: names,
      reattachedSandboxIdentities: identities
    } satisfies PrReviewSandboxReconciliation
  })

  const cleanupUnmatched = Effect.fn("PrReviewSandboxSessions.cleanupUnmatched")(function*(
    names: ReadonlyArray<string>
  ) {
    yield* Effect.forEach(names, removeSandbox)
    return names
  })

  return PrReviewSandboxSessions.of({ cleanupUnmatched, reconcile, withSession })
})

/** Production layer for scoped writable sbx Review Sandbox sessions. */
export const prReviewSandboxSessionsLayer = (
  options: PrReviewSandboxSessionOptions
): Layer.Layer<
  PrReviewSandboxSessions,
  PrReviewSandboxSessionError,
  ReviewCommandArtifactRepository | PrReviewSourceWorkspace | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(PrReviewSandboxSessions, makeSessions(options))

const ToolOutput = Schema.Struct({
  artifact: Schema.NullOr(PrReviewCommandArtifactHandle),
  byteLength: Schema.Int,
  text: Schema.String,
  truncated: Schema.Boolean
})

const ToolCommandResult = Schema.Struct({
  exitCode: Schema.Int,
  stderr: ToolOutput,
  stdout: ToolOutput
})

/** Read a bounded byte range from one workspace-relative file. */
export const ReviewReadFile = Tool.make("ReviewReadFile", {
  description: "Read a bounded byte range from one workspace-relative file.",
  failure: PrReviewSandboxSessionError,
  parameters: Schema.Struct({
    path: RelativeSandboxPath,
    offset: Schema.optionalKey(PositiveOffset),
    limit: Schema.optionalKey(PositiveLimit)
  }),
  success: ToolCommandResult
})

/** List one workspace-relative directory. */
export const ReviewListFiles = Tool.make("ReviewListFiles", {
  description: "List the direct entries in one workspace-relative directory.",
  failure: PrReviewSandboxSessionError,
  parameters: Schema.Struct({ path: Schema.optionalKey(RelativeSandboxPath) }),
  success: ToolCommandResult
})

/** Search project files for one literal value. */
export const ReviewSearchFiles = Tool.make("ReviewSearchFiles", {
  description: "Search project files recursively for one literal value.",
  failure: PrReviewSandboxSessionError,
  parameters: Schema.Struct({
    query: SearchText,
    path: Schema.optionalKey(RelativeSandboxPath)
  }),
  success: ToolCommandResult
})

/** Run an arbitrary shell command inside the isolated workspace. */
export const ReviewRunCommand = Tool.make("ReviewRunCommand", {
  description: "Run an arbitrary shell command inside the isolated writable workspace.",
  failure: PrReviewSandboxSessionError,
  parameters: Schema.Struct({
    command: CommandText,
    maximumDurationMillis: Schema.optionalKey(CommandTimeoutMillis)
  }),
  success: ToolCommandResult
})

/** Apply one temporary unified patch inside the disposable workspace. */
export const ReviewApplyPatch = Tool.make("ReviewApplyPatch", {
  description: "Apply one temporary unified Git patch inside the disposable workspace.",
  failure: PrReviewSandboxSessionError,
  parameters: Schema.Struct({ patch: PatchText }),
  success: ToolCommandResult
})

/** Read the complete temporary Git diff, with artifact retention when large. */
export const ReviewReadDiff = Tool.make("ReviewReadDiff", {
  description: "Read the current temporary workspace Git diff.",
  failure: PrReviewSandboxSessionError,
  success: ToolCommandResult
})

/** Discover safe durable artifact handles retained for the current review run. */
export const ReviewListArtifacts = Tool.make("ReviewListArtifacts", {
  description: "List bounded secret-free metadata for durable command output owned by this review job.",
  failure: PrReviewSandboxSessionError,
  success: Schema.Struct({ artifacts: Schema.Array(ReviewCommandArtifactMetadata) })
})

/** Page retained command output using its durable immutable-command handle. */
export const ReviewPageArtifact = Tool.make("ReviewPageArtifact", {
  description: "Read a bounded UTF-8 byte page from durable complete command output.",
  failure: PrReviewSandboxSessionError,
  parameters: Schema.Struct({
    artifact: PrReviewCommandArtifactHandle,
    offset: PositiveOffset,
    limit: PositiveLimit
  }),
  success: Schema.Struct({
    page: Schema.String,
    nextOffset: PositiveOffset,
    complete: Schema.Boolean
  })
})

/** Search retained command output without returning the complete artifact. */
export const ReviewSearchArtifact = Tool.make("ReviewSearchArtifact", {
  description: "Find UTF-8 byte offsets in durable complete command output.",
  failure: PrReviewSandboxSessionError,
  parameters: Schema.Struct({
    artifact: PrReviewCommandArtifactHandle,
    query: SearchText
  }),
  success: Schema.Struct({ offsets: Schema.Array(PositiveOffset) })
})

/** Provider-neutral toolkit exposed to the structured Review Agent loop. */
export const PrReviewSandboxTools = Toolkit.make(
  ReviewReadFile,
  ReviewListFiles,
  ReviewSearchFiles,
  ReviewRunCommand,
  ReviewApplyPatch,
  ReviewReadDiff,
  ReviewListArtifacts,
  ReviewPageArtifact,
  ReviewSearchArtifact
)

/** Bind the typed Review Sandbox tools to one live scoped session. */
export const prReviewSandboxToolsLayer = (
  session: PrReviewSandboxSession
): Layer.Layer<Tool.HandlersFor<typeof PrReviewSandboxTools.tools>> =>
  PrReviewSandboxTools.toLayer({
    ReviewReadFile: ({ limit, offset, path }) => session.readFile(path, offset, limit),
    ReviewListFiles: ({ path }) => session.listFiles(path),
    ReviewSearchFiles: ({ path, query }) => session.searchFiles(query, path),
    ReviewRunCommand: ({ command, maximumDurationMillis }) => session.runCommand(command, maximumDurationMillis),
    ReviewApplyPatch: ({ patch }) => session.applyPatch(patch),
    ReviewReadDiff: () => session.readDiff(),
    ReviewListArtifacts: () => session.listArtifacts().pipe(Effect.map((artifacts) => ({ artifacts }))),
    ReviewPageArtifact: ({ artifact, limit, offset }) =>
      session.pageArtifact(artifact, offset, limit).pipe(
        Effect.map(({ complete, nextOffset, text: page }) => ({ complete, nextOffset, page }))
      ),
    ReviewSearchArtifact: ({ artifact, query }) =>
      session.searchArtifact(artifact, query).pipe(Effect.map((offsets) => ({ offsets })))
  })
