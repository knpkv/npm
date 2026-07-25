/** Writable, credential-free Docker session for one exact pull-request revision. @module */
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { JobId, WorkspaceId } from "../../../domain/identifiers.js"
import { PrReviewSourceError, type PrReviewSourceRequest, PrReviewSourceWorkspace } from "./PrReviewSourceWorkspace.js"
import { PR_REVIEW_AUTHORITY_CONFIG_PATTERN } from "./PrReviewWorkspaceProtocol.js"

const OCI_EXECUTABLE = "docker"
const CONTAINER_SOURCE = "/workspace"
const CONTAINER_UID_GID = "65532:65532"
const CONTAINER_KIND_LABEL = "dev.knpkv.control-center.pr-review.kind"
const CONTAINER_JOB_LABEL = "dev.knpkv.control-center.pr-review.job"
const CONTAINER_ATTEMPT_LABEL = "dev.knpkv.control-center.pr-review.attempt"
const CONTROL_TIMEOUT = Duration.seconds(30)
const SOURCE_HANDOFF_TIMEOUT = Duration.minutes(5)
const DEFAULT_COMMAND_TIMEOUT_MILLIS = 120_000
const MAXIMUM_COMMAND_TIMEOUT_MILLIS = 1_200_000
const DEFAULT_SESSION_TIMEOUT_MILLIS = 1_200_000
const MAXIMUM_SESSION_TIMEOUT_MILLIS = 1_800_000
const DEFAULT_MAXIMUM_WORKSPACE_BYTES = 1_024 * 1_024 * 1_024
const MINIMUM_WORKSPACE_BYTES = 1 * 1_024 * 1_024
const MAXIMUM_WORKSPACE_BYTES = 16 * 1_024 * 1_024 * 1_024
const MAXIMUM_CONTROL_OUTPUT_BYTES = 8_192
const MAXIMUM_COMMAND_OUTPUT_BYTES = 16 * 1_024 * 1_024
const MAXIMUM_VISIBLE_OUTPUT_BYTES = 32 * 1_024
const MAXIMUM_PATCH_BYTES = 256 * 1_024
const MAXIMUM_ARTIFACT_PAGE_BYTES = 64 * 1_024
const MAXIMUM_RETAINED_ARTIFACT_BYTES = 64 * 1_024 * 1_024
const MAXIMUM_RETAINED_ARTIFACTS = 64

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

const DigestPinnedImage = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(512),
  Schema.isPattern(
    /^(?:(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?@)?sha256:[a-f0-9]{64}$/u,
    { expected: "an OCI image reference pinned by a sha256 digest" }
  )
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
  Schema.makeFilter(
    (value) => !value.includes("\u0000"),
    { expected: "a non-empty shell command without NUL bytes" }
  )
)

const SearchText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.makeFilter(
    (value) => !value.includes("\u0000"),
    { expected: "a non-empty search value without NUL bytes" }
  )
)

const PositiveOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAXIMUM_ARTIFACT_PAGE_BYTES }))
const CommandTimeoutMillis = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAXIMUM_COMMAND_TIMEOUT_MILLIS })
)
const WorkspaceBytes = Schema.Int.check(
  Schema.isBetween({
    minimum: MINIMUM_WORKSPACE_BYTES,
    maximum: MAXIMUM_WORKSPACE_BYTES
  })
)
const PatchText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter(
    (value) => textEncoder.encode(value).byteLength <= MAXIMUM_PATCH_BYTES,
    {
      expected: `a patch encoded as at most ${MAXIMUM_PATCH_BYTES} UTF-8 bytes`
    }
  )
)

/** Opaque identifier for output retained only by one Review Sandbox session. */
export const PrReviewCommandArtifactId = Schema.String.check(
  Schema.isPattern(/^review-artifact-[1-9][0-9]*$/u)
).pipe(Schema.brand("PrReviewCommandArtifactId"))
export type PrReviewCommandArtifactId = typeof PrReviewCommandArtifactId.Type

const SessionRequest = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  repository: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9._-]{1,100}$/u)
  ),
  attemptId: SandboxAttemptId,
  baseRevision: GitRevision,
  headRevision: GitRevision
})

const SessionOptions = Schema.Struct({
  image: DigestPinnedImage,
  maximumCommandDurationMillis: Schema.optionalKey(CommandTimeoutMillis),
  maximumSessionDurationMillis: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAXIMUM_SESSION_TIMEOUT_MILLIS })
    )
  ),
  maximumWorkspaceBytes: Schema.optionalKey(WorkspaceBytes)
})

/** Exact review identity used to acquire a disposable writable session. */
export interface PrReviewSandboxSessionRequest extends PrReviewSourceRequest {
  readonly attemptId: string
}

/** Trusted local construction material for the Review Sandbox runtime. */
export interface PrReviewSandboxSessionOptions {
  readonly image: string
  readonly maximumCommandDurationMillis?: number
  readonly maximumSessionDurationMillis?: number
  readonly maximumWorkspaceBytes?: number
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
  readonly artifactId: PrReviewCommandArtifactId | null
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

/** A live session. `close` is idempotent and every other operation fails after it. */
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
  readonly pageArtifact: (
    artifactId: PrReviewCommandArtifactId,
    offset: number,
    limit: number
  ) => Effect.Effect<string, PrReviewSandboxSessionError>
  readonly searchArtifact: (
    artifactId: PrReviewCommandArtifactId,
    query: string
  ) => Effect.Effect<ReadonlyArray<number>, PrReviewSandboxSessionError>
  readonly close: Effect.Effect<void, PrReviewSandboxSessionError>
}

/** Reconciled identity of one labeled Review Sandbox container. */
export interface PrReviewSandboxLiveContainer {
  readonly attemptId: string
  readonly containerName: string
  readonly jobId: JobId
}

/** Startup cleanup report plus the exact sessions still available for reattachment. */
export interface PrReviewSandboxReconciliation {
  readonly liveSessions: ReadonlyArray<PrReviewSandboxLiveContainer>
  readonly removedInitializerContainers: ReadonlyArray<string>
  readonly removedNonRunningSessionContainers: ReadonlyArray<string>
  readonly removedOrphanVolumes: ReadonlyArray<string>
}

/** Session owner. The callback is scoped to the container and named volume lifetime. */
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
    readonly reconcile: () => Effect.Effect<
      PrReviewSandboxReconciliation,
      PrReviewSandboxSessionError
    >
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

interface RetainedArtifact {
  readonly byteLength: number
  readonly text: string
}

interface LabeledResource {
  readonly attemptId: string
  readonly jobId: JobId
  readonly kind: string
  readonly name: string
}

interface LabeledContainerResource extends LabeledResource {
  readonly state: string
}

const labeledResource = (line: string): LabeledResource | null => {
  const [name, kind, unknownJobId, attemptId, ...rest] = line.split("\t")
  return name !== undefined &&
      kind !== undefined &&
      unknownJobId !== undefined &&
      attemptId !== undefined &&
      rest.length === 0 &&
      Schema.is(JobId)(unknownJobId) &&
      Schema.is(SandboxAttemptId)(attemptId)
    ? {
      attemptId,
      jobId: unknownJobId,
      kind,
      name
    }
    : null
}

const labeledContainerResource = (
  line: string
): LabeledContainerResource | null => {
  const [name, kind, unknownJobId, attemptId, state, ...rest] = line.split("\t")
  return name !== undefined &&
      kind !== undefined &&
      unknownJobId !== undefined &&
      attemptId !== undefined &&
      state !== undefined &&
      rest.length === 0 &&
      Schema.is(JobId)(unknownJobId) &&
      Schema.is(SandboxAttemptId)(attemptId)
    ? {
      attemptId,
      jobId: unknownJobId,
      kind,
      name,
      state
    }
    : null
}

const resourceKey = (
  jobId: JobId,
  attemptId: string
): string => `${jobId}:${attemptId}`

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
  stream: Stream.Stream<Uint8Array, unknown, never>,
  maximumBytes: number
): Effect.Effect<Uint8Array, PrReviewSandboxSessionError> =>
  stream.pipe(
    Stream.runFoldEffect(
      (): ByteAccumulator => ({ chunks: [], length: 0 }),
      (accumulator, chunk) => {
        const length = accumulator.length + chunk.byteLength
        if (length > maximumBytes) {
          return Effect.fail(sessionError("output-rejected"))
        }
        accumulator.chunks.push(Uint8Array.from(chunk))
        return Effect.succeed({
          chunks: accumulator.chunks,
          length
        })
      }
    ),
    Effect.map(concatenate),
    Effect.mapError((error) =>
      isSessionError(error)
        ? error
        : sessionError("sandbox-unavailable")
    )
  )

const processEnvironment: Readonly<Record<string, string>> = {
  DOCKER_CONFIG: "/nonexistent",
  HOME: "/nonexistent",
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin"
}

const execute = Effect.fn("PrReviewSandboxSession.execute")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  args: ReadonlyArray<string>,
  maximumOutputBytes: number,
  timeout: Duration.Input,
  input?: Uint8Array
) {
  return yield* Effect.scoped(
    Effect.gen(function*() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(OCI_EXECUTABLE, args, {
          env: processEnvironment,
          extendEnv: false,
          forceKillAfter: Duration.seconds(5),
          shell: false,
          stdin: input === undefined ? "ignore" : Stream.make(input),
          stdout: "pipe",
          stderr: "pipe"
        })
      ).pipe(Effect.mapError(() => sessionError("sandbox-unavailable")))
      const [exitCode, stderr, stdout] = yield* Effect.all([
        handle.exitCode.pipe(
          Effect.mapError(() => sessionError("sandbox-unavailable"))
        ),
        collectBounded(handle.stderr, maximumOutputBytes),
        collectBounded(handle.stdout, maximumOutputBytes)
      ], { concurrency: "unbounded" })
      return { exitCode, stderr, stdout } satisfies ProcessResult
    })
  ).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(sessionError("command-timeout"))
    })
  )
})

const executeControlWithin = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  args: ReadonlyArray<string>,
  timeout: Duration.Input
): Effect.Effect<ProcessResult, PrReviewSandboxSessionError> =>
  execute(
    spawner,
    args,
    MAXIMUM_CONTROL_OUTPUT_BYTES,
    timeout
  ).pipe(
    Effect.mapError((error) =>
      error.reason === "command-timeout"
        ? sessionError("sandbox-timeout")
        : error
    )
  )

const executeControl = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  args: ReadonlyArray<string>
): Effect.Effect<ProcessResult, PrReviewSandboxSessionError> => executeControlWithin(spawner, args, CONTROL_TIMEOUT)

const successful = (result: ProcessResult): boolean => result.exitCode === ChildProcessSpawner.ExitCode(0)

const decodeUtf8 = (
  bytes: Uint8Array,
  reason: PrReviewSandboxSessionError["reason"]
): Effect.Effect<string, PrReviewSandboxSessionError> =>
  Effect.try({
    try: () => textDecoder.decode(bytes),
    catch: () => sessionError(reason)
  })

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const containerName = (jobId: JobId, attemptId: string): string => `cc-pr-review-session-${jobId}-${attemptId}`

const initializerName = (jobId: JobId, attemptId: string): string => `cc-pr-review-init-${jobId}-${attemptId}`

const volumeName = (jobId: JobId, attemptId: string): string => `cc-pr-review-${jobId}-${attemptId}`

const labels = (
  kind: "initializer" | "session" | "volume",
  jobId: JobId,
  attemptId: string
): ReadonlyArray<string> => [
  "--label",
  `${CONTAINER_KIND_LABEL}=${kind}`,
  "--label",
  `${CONTAINER_JOB_LABEL}=${jobId}`,
  "--label",
  `${CONTAINER_ATTEMPT_LABEL}=${attemptId}`
]

const volumeMount = (name: string): string => `type=volume,src=${name},dst=${CONTAINER_SOURCE},volume-nocopy`

const createInitializerArguments = (
  name: string,
  volume: string,
  jobId: JobId,
  attemptId: string,
  image: string
): ReadonlyArray<string> => [
  "container",
  "create",
  "--name",
  name,
  ...labels("initializer", jobId, attemptId),
  "--pull",
  "never",
  "--log-driver",
  "none",
  "--user",
  "0:0",
  "--read-only",
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--cap-add",
  "CHOWN",
  "--security-opt",
  "no-new-privileges:true",
  "--pids-limit",
  "32",
  "--memory",
  "128m",
  "--memory-swap",
  "128m",
  "--mount",
  volumeMount(volume),
  "--entrypoint",
  "/bin/sh",
  image,
  "-c",
  "while :; do sleep 3600; done"
]

const createSessionArguments = (
  name: string,
  volume: string,
  jobId: JobId,
  attemptId: string,
  image: string
): ReadonlyArray<string> => [
  "container",
  "create",
  "--name",
  name,
  ...labels("session", jobId, attemptId),
  "--pull",
  "never",
  "--log-driver",
  "none",
  "--user",
  CONTAINER_UID_GID,
  "--read-only",
  "--network",
  "none",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges:true",
  "--pids-limit",
  "128",
  "--cpus",
  "1",
  "--memory",
  "1g",
  "--memory-swap",
  "1g",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,size=256m,uid=65532,gid=65532,mode=0700",
  "--mount",
  volumeMount(volume),
  "--workdir",
  CONTAINER_SOURCE,
  "--entrypoint",
  "/bin/sh",
  image,
  "-c",
  "while :; do sleep 3600; done"
]

const missingResource = (stderr: string): boolean =>
  /no such (?:container|volume)/iu.test(stderr) ||
  /(?:container|volume)[^\n]*\bnot found\b/iu.test(stderr)

const removeContainer = Effect.fn("PrReviewSandboxSession.removeContainer")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  name: string
) {
  const removed = yield* executeControl(
    spawner,
    ["container", "rm", "--force", "--volumes", name]
  ).pipe(Effect.mapError(() => sessionError("cleanup-failed")))
  if (successful(removed)) return
  const stderr = yield* decodeUtf8(removed.stderr, "cleanup-failed")
  if (!missingResource(stderr)) return yield* sessionError("cleanup-failed")
})

const removeVolume = Effect.fn("PrReviewSandboxSession.removeVolume")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  name: string
) {
  const removed = yield* executeControl(
    spawner,
    ["volume", "rm", "--force", name]
  ).pipe(Effect.mapError(() => sessionError("cleanup-failed")))
  if (successful(removed)) return
  const stderr = yield* decodeUtf8(removed.stderr, "cleanup-failed")
  if (!missingResource(stderr)) return yield* sessionError("cleanup-failed")
})

const makeOutput = Effect.fn("PrReviewSandboxSession.makeOutput")(function*(
  artifacts: Ref.Ref<Map<PrReviewCommandArtifactId, RetainedArtifact>>,
  artifactSequence: Ref.Ref<number>,
  bytes: Uint8Array
) {
  const complete = yield* decodeUtf8(bytes, "output-rejected")
  if (bytes.byteLength <= MAXIMUM_VISIBLE_OUTPUT_BYTES) {
    return {
      artifactId: null,
      byteLength: bytes.byteLength,
      text: complete,
      truncated: false
    } satisfies PrReviewSandboxOutput
  }
  const sequence = yield* Ref.updateAndGet(
    artifactSequence,
    (value) => value + 1
  )
  const artifactId = PrReviewCommandArtifactId.make(
    `review-artifact-${sequence}`
  )
  yield* Ref.update(artifacts, (current) => {
    const next = new Map(current)
    next.set(artifactId, {
      byteLength: bytes.byteLength,
      text: complete
    })
    let retainedBytes = 0
    for (const artifact of next.values()) {
      retainedBytes += artifact.byteLength
    }
    while (
      next.size > MAXIMUM_RETAINED_ARTIFACTS ||
      retainedBytes > MAXIMUM_RETAINED_ARTIFACT_BYTES
    ) {
      const oldest = next.entries().next().value
      if (oldest === undefined) break
      const [oldestId, oldestArtifact] = oldest
      next.delete(oldestId)
      retainedBytes -= oldestArtifact.byteLength
    }
    return next
  })
  const half = Math.floor(MAXIMUM_VISIBLE_OUTPUT_BYTES / 2)
  let headEnd = half
  while (
    headEnd > 0 &&
    headEnd < bytes.byteLength &&
    (bytes[headEnd] ?? 0) >= 0x80 &&
    (bytes[headEnd] ?? 0) <= 0xbf
  ) {
    headEnd -= 1
  }
  const head = textDecoder.decode(bytes.slice(0, headEnd))
  let tailOffset = bytes.byteLength - half
  while (
    tailOffset < bytes.byteLength &&
    (bytes[tailOffset] ?? 0) >= 0x80 &&
    (bytes[tailOffset] ?? 0) <= 0xbf
  ) {
    tailOffset += 1
  }
  const tail = textDecoder.decode(bytes.slice(tailOffset))
  return {
    artifactId,
    byteLength: bytes.byteLength,
    text: `${head}\n\n[output retained as ${artifactId}]\n\n${tail}`,
    truncated: true
  } satisfies PrReviewSandboxOutput
})

const alignUtf8Page = (
  bytes: Uint8Array,
  requestedOffset: number,
  windowOffset: number,
  requestedLimit: number
): Uint8Array => {
  let start = requestedOffset - windowOffset
  while (
    start < bytes.byteLength &&
    (bytes[start] ?? 0) >= 0x80 &&
    (bytes[start] ?? 0) <= 0xbf
  ) {
    start += 1
  }
  let end = Math.min(
    bytes.byteLength,
    requestedOffset - windowOffset + requestedLimit
  )
  while (
    end < bytes.byteLength &&
    (bytes[end] ?? 0) >= 0x80 &&
    (bytes[end] ?? 0) <= 0xbf
  ) {
    end += 1
  }
  return bytes.slice(start, Math.max(start, end))
}

const makeSessions = Effect.fn("PrReviewSandboxSessions.make")(function*(
  unknownOptions: PrReviewSandboxSessionOptions
) {
  const options = yield* Schema.decodeUnknownEffect(SessionOptions)(
    unknownOptions
  ).pipe(Effect.mapError(() => sessionError("invalid-configuration")))
  const fileSystem = yield* FileSystem.FileSystem
  const sourceWorkspace = yield* PrReviewSourceWorkspace
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const maximumCommandDurationMillis = options.maximumCommandDurationMillis ?? DEFAULT_COMMAND_TIMEOUT_MILLIS
  const maximumSessionDurationMillis = options.maximumSessionDurationMillis ?? DEFAULT_SESSION_TIMEOUT_MILLIS
  const maximumWorkspaceBytes = options.maximumWorkspaceBytes ?? DEFAULT_MAXIMUM_WORKSPACE_BYTES

  const withSession = Effect.fn(
    "PrReviewSandboxSessions.withSession"
  )(function*<Success, Failure, Requirements>(
    unknownRequest: PrReviewSandboxSessionRequest,
    use: (
      session: PrReviewSandboxSession
    ) => Effect.Effect<Success, Failure, Requirements>
  ) {
    const request = yield* Schema.decodeUnknownEffect(SessionRequest)(
      unknownRequest
    ).pipe(Effect.mapError(() => sessionError("invalid-request")))
    const name = containerName(request.jobId, request.attemptId)
    const initName = initializerName(request.jobId, request.attemptId)
    const volume = volumeName(request.jobId, request.attemptId)

    return yield* sourceWorkspace.withSource(
      request,
      (sourceRoot) =>
        Effect.acquireUseRelease(
          executeControl(spawner, [
            "volume",
            "create",
            ...labels("volume", request.jobId, request.attemptId),
            "--driver",
            "local",
            "--opt",
            "type=tmpfs",
            "--opt",
            "device=tmpfs",
            "--opt",
            `o=size=${maximumWorkspaceBytes}`,
            volume
          ]).pipe(
            Effect.flatMap((created) =>
              successful(created)
                ? Effect.succeed(volume)
                : Effect.fail(sessionError("sandbox-unavailable"))
            )
          ),
          () =>
            Effect.acquireUseRelease(
              executeControl(
                spawner,
                createInitializerArguments(
                  initName,
                  volume,
                  request.jobId,
                  request.attemptId,
                  options.image
                )
              ).pipe(
                Effect.flatMap((created) =>
                  successful(created)
                    ? Effect.succeed(initName)
                    : Effect.fail(sessionError("sandbox-unavailable"))
                )
              ),
              () =>
                Effect.gen(function*() {
                  const initializerStarted = yield* executeControlWithin(
                    spawner,
                    ["container", "start", initName],
                    SOURCE_HANDOFF_TIMEOUT
                  )
                  if (!successful(initializerStarted)) {
                    return yield* sessionError("sandbox-unavailable")
                  }
                  const copied = yield* executeControlWithin(
                    spawner,
                    [
                      "container",
                      "cp",
                      "--archive",
                      `${sourceRoot}/.`,
                      `${initName}:${CONTAINER_SOURCE}`
                    ],
                    SOURCE_HANDOFF_TIMEOUT
                  )
                  if (!successful(copied)) {
                    return yield* sessionError("sandbox-unavailable")
                  }
                  const initialized = yield* executeControlWithin(
                    spawner,
                    [
                      "container",
                      "exec",
                      initName,
                      "chown",
                      "-R",
                      CONTAINER_UID_GID,
                      CONTAINER_SOURCE
                    ],
                    SOURCE_HANDOFF_TIMEOUT
                  )
                  if (!successful(initialized)) {
                    return yield* sessionError("sandbox-unavailable")
                  }

                  yield* fileSystem.remove(sourceRoot, {
                    force: true,
                    recursive: true
                  }).pipe(
                    Effect.mapError(() => sessionError("cleanup-failed"))
                  )

                  return yield* Effect.acquireUseRelease(
                    executeControl(
                      spawner,
                      createSessionArguments(
                        name,
                        volume,
                        request.jobId,
                        request.attemptId,
                        options.image
                      )
                    ).pipe(
                      Effect.flatMap((created) =>
                        successful(created)
                          ? Effect.succeed(name)
                          : Effect.fail(sessionError("sandbox-unavailable"))
                      )
                    ),
                    () =>
                      Effect.gen(function*() {
                        const started = yield* executeControl(
                          spawner,
                          ["container", "start", name]
                        )
                        if (!successful(started)) {
                          return yield* sessionError("sandbox-unavailable")
                        }
                        yield* removeContainer(spawner, initName)

                        const closed = yield* Ref.make(false)
                        const artifacts = yield* Ref.make(
                          new Map<PrReviewCommandArtifactId, RetainedArtifact>()
                        )
                        const artifactSequence = yield* Ref.make(0)

                        const close = Ref.getAndSet(closed, true).pipe(
                          Effect.flatMap((wasClosed) =>
                            wasClosed
                              ? Effect.void
                              : removeContainer(spawner, name).pipe(
                                Effect.andThen(removeVolume(spawner, volume))
                              )
                          )
                        )

                        const executeContained = Effect.fn(
                          "PrReviewSandboxSession.executeContained"
                        )(function*(
                          commandText: string,
                          durationMillis: number,
                          input?: Uint8Array
                        ) {
                          if (yield* Ref.get(closed)) {
                            return yield* sessionError("session-closed")
                          }
                          const result = yield* execute(
                            spawner,
                            [
                              "container",
                              "exec",
                              ...(input === undefined ? [] : ["--interactive"]),
                              "--workdir",
                              CONTAINER_SOURCE,
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
                          ).pipe(
                            Effect.tapError((error) =>
                              error.reason === "command-timeout"
                                ? close
                                : Effect.void
                            )
                          )
                          return result
                        })

                        const runContainedCommand = Effect.fn(
                          "PrReviewSandboxSession.runContainedCommand"
                        )(function*(
                          commandText: string,
                          durationMillis: number,
                          input?: Uint8Array
                        ) {
                          const result = yield* executeContained(
                            commandText,
                            durationMillis,
                            input
                          )
                          return {
                            exitCode: result.exitCode,
                            stderr: yield* makeOutput(
                              artifacts,
                              artifactSequence,
                              result.stderr
                            ),
                            stdout: yield* makeOutput(
                              artifacts,
                              artifactSequence,
                              result.stdout
                            )
                          } satisfies PrReviewSandboxCommandResult
                        })

                        const runCommand = Effect.fn(
                          "PrReviewSandboxSession.runCommand"
                        )(function*(
                          unknownCommand: string,
                          unknownDuration = maximumCommandDurationMillis
                        ) {
                          const commandText = yield* Schema.decodeUnknownEffect(
                            CommandText
                          )(unknownCommand).pipe(
                            Effect.mapError(() => sessionError("invalid-request"))
                          )
                          const durationMillis = yield* Schema.decodeUnknownEffect(
                            CommandTimeoutMillis
                          )(unknownDuration).pipe(
                            Effect.mapError(() => sessionError("invalid-request"))
                          )
                          return yield* runContainedCommand(
                            commandText,
                            Math.min(
                              durationMillis,
                              maximumCommandDurationMillis
                            )
                          )
                        })

                        const safePath = Effect.fn(
                          "PrReviewSandboxSession.safePath"
                        )(function*(unknownPath: string) {
                          return yield* Schema.decodeUnknownEffect(
                            RelativeSandboxPath
                          )(unknownPath).pipe(
                            Effect.mapError(() => sessionError("invalid-request"))
                          )
                        })

                        const session: PrReviewSandboxSession = {
                          attemptId: request.attemptId,
                          baseRevision: request.baseRevision,
                          headRevision: request.headRevision,
                          jobId: request.jobId,
                          runCommand,
                          readFile: (unknownPath, offset = 0, limit = 32_768) =>
                            Effect.gen(function*() {
                              const path = yield* safePath(unknownPath)
                              const decodedOffset = yield* Schema.decodeUnknownEffect(
                                PositiveOffset
                              )(offset).pipe(
                                Effect.mapError(() => sessionError("invalid-request"))
                              )
                              const decodedLimit = yield* Schema.decodeUnknownEffect(
                                PositiveLimit
                              )(limit).pipe(
                                Effect.mapError(() => sessionError("invalid-request"))
                              )
                              const windowOffset = Math.max(0, decodedOffset - 3)
                              const windowLimit = decodedLimit + 6
                              const result = yield* executeContained(
                                `dd if=${shellQuote(path)} bs=1 skip=${windowOffset} count=${windowLimit} status=none`,
                                maximumCommandDurationMillis
                              )
                              return {
                                exitCode: result.exitCode,
                                stderr: yield* makeOutput(
                                  artifacts,
                                  artifactSequence,
                                  result.stderr
                                ),
                                stdout: yield* makeOutput(
                                  artifacts,
                                  artifactSequence,
                                  alignUtf8Page(
                                    result.stdout,
                                    decodedOffset,
                                    windowOffset,
                                    decodedLimit
                                  )
                                )
                              } satisfies PrReviewSandboxCommandResult
                            }),
                          listFiles: (unknownPath = ".") =>
                            Effect.gen(function*() {
                              const path = yield* safePath(unknownPath)
                              const operand = path === "." ? "." : `./${path}`
                              return yield* runCommand(
                                "list_file=$(mktemp /tmp/review-list.XXXXXX) && " +
                                  "trap 'rm -f \"$list_file\"' EXIT HUP INT TERM && " +
                                  `find ${shellQuote(operand)} -mindepth 1 -maxdepth 1 -print > "$list_file" && ` +
                                  "LC_ALL=C sort \"$list_file\""
                              )
                            }),
                          searchFiles: (unknownQuery, unknownPath = ".") =>
                            Effect.gen(function*() {
                              const query = yield* Schema.decodeUnknownEffect(
                                SearchText
                              )(unknownQuery).pipe(
                                Effect.mapError(() => sessionError("invalid-request"))
                              )
                              const path = yield* safePath(unknownPath)
                              return yield* runCommand(
                                `grep -RInF --exclude-dir=.git -- ${shellQuote(query)} ${shellQuote(path)}`
                              )
                            }),
                          applyPatch: (unknownPatch) =>
                            Effect.gen(function*() {
                              const patch = yield* Schema.decodeUnknownEffect(
                                PatchText
                              )(unknownPatch).pipe(
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
                          pageArtifact: (
                            artifactId,
                            unknownOffset,
                            unknownLimit
                          ) =>
                            Effect.gen(function*() {
                              if (yield* Ref.get(closed)) {
                                return yield* sessionError("session-closed")
                              }
                              const offset = yield* Schema.decodeUnknownEffect(
                                PositiveOffset
                              )(unknownOffset).pipe(
                                Effect.mapError(() => sessionError("invalid-request"))
                              )
                              const limit = yield* Schema.decodeUnknownEffect(
                                PositiveLimit
                              )(unknownLimit).pipe(
                                Effect.mapError(() => sessionError("invalid-request"))
                              )
                              const artifact = (yield* Ref.get(artifacts)).get(
                                artifactId
                              )
                              if (artifact === undefined) {
                                return yield* sessionError("artifact-unavailable")
                              }
                              return artifact.text.slice(offset, offset + limit)
                            }),
                          searchArtifact: (artifactId, unknownQuery) =>
                            Effect.gen(function*() {
                              if (yield* Ref.get(closed)) {
                                return yield* sessionError("session-closed")
                              }
                              const query = yield* Schema.decodeUnknownEffect(
                                SearchText
                              )(unknownQuery).pipe(
                                Effect.mapError(() => sessionError("invalid-request"))
                              )
                              const artifact = (yield* Ref.get(artifacts)).get(
                                artifactId
                              )
                              if (artifact === undefined) {
                                return yield* sessionError("artifact-unavailable")
                              }
                              const matches = new Array<number>()
                              for (
                                let offset = artifact.text.indexOf(query);
                                offset !== -1 && matches.length < 100;
                                offset = artifact.text.indexOf(query, offset + 1)
                              ) {
                                matches.push(offset)
                              }
                              return matches
                            }),
                          close
                        }

                        const verified = yield* runCommand(
                          "test \"$(git rev-parse --verify HEAD)\" = " +
                            shellQuote(request.headRevision) +
                            " && test -z \"$(git remote)\" && " +
                            "authority_keys=$(git config --local --name-only --get-regexp '.*') && " +
                            "! printf '%s\\n' \"$authority_keys\" | " +
                            "LC_ALL=C tr '[:upper:]' '[:lower:]' | grep -E " +
                            shellQuote(PR_REVIEW_AUTHORITY_CONFIG_PATTERN)
                        )
                        if (verified.exitCode !== 0) {
                          return yield* sessionError("source-unavailable")
                        }

                        return yield* use(session).pipe(
                          Effect.timeoutOrElse({
                            duration: Duration.millis(
                              maximumSessionDurationMillis
                            ),
                            orElse: () => Effect.fail(sessionError("sandbox-timeout"))
                          })
                        )
                      }),
                    () => removeContainer(spawner, name)
                  )
                }),
              () => removeContainer(spawner, initName)
            ),
          () => removeVolume(spawner, volume)
        )
    ).pipe(
      Effect.mapError((error) =>
        isSessionError(error)
          ? error
          : Schema.is(PrReviewSourceError)(error)
          ? sessionError("source-unavailable")
          : error
      )
    )
  })

  const reconcile = Effect.fn(
    "PrReviewSandboxSessions.reconcile"
  )(function*() {
    const listedContainers = yield* executeControl(spawner, [
      "container",
      "ls",
      "--all",
      "--filter",
      `label=${CONTAINER_JOB_LABEL}`,
      "--format",
      `{{.Names}}\t{{.Label "${CONTAINER_KIND_LABEL}"}}\t{{.Label "${CONTAINER_JOB_LABEL}"}}\t` +
      `{{.Label "${CONTAINER_ATTEMPT_LABEL}"}}\t{{.State}}`
    ])
    const listedVolumes = yield* executeControl(spawner, [
      "volume",
      "ls",
      "--filter",
      `label=${CONTAINER_JOB_LABEL}`,
      "--format",
      `{{.Name}}\t{{.Label "${CONTAINER_KIND_LABEL}"}}\t{{.Label "${CONTAINER_JOB_LABEL}"}}\t` +
      `{{.Label "${CONTAINER_ATTEMPT_LABEL}"}}`
    ])
    if (
      !successful(listedContainers) ||
      !successful(listedVolumes)
    ) {
      return yield* sessionError("sandbox-unavailable")
    }
    const containerText = yield* decodeUtf8(
      listedContainers.stdout,
      "sandbox-unavailable"
    )
    const volumeText = yield* decodeUtf8(
      listedVolumes.stdout,
      "sandbox-unavailable"
    )
    const liveSessions = new Array<PrReviewSandboxLiveContainer>()
    const initializerContainers = new Array<LabeledResource>()
    const nonRunningSessionContainers = new Array<LabeledContainerResource>()
    const protectedVolumeKeys = new Set<string>()
    for (const line of containerText.split("\n")) {
      if (line.length === 0) continue
      const resource = labeledContainerResource(line)
      if (resource === null) continue
      if (resource.kind === "session") {
        if (
          resource.name === containerName(
            resource.jobId,
            resource.attemptId
          )
        ) {
          if (resource.state === "running") {
            protectedVolumeKeys.add(
              resourceKey(resource.jobId, resource.attemptId)
            )
            liveSessions.push({
              attemptId: resource.attemptId,
              containerName: resource.name,
              jobId: resource.jobId
            })
          } else {
            nonRunningSessionContainers.push(resource)
          }
        }
      } else if (
        resource.kind === "initializer" &&
        resource.name === initializerName(
            resource.jobId,
            resource.attemptId
          )
      ) {
        initializerContainers.push(resource)
      }
    }

    const orphanVolumes = new Array<LabeledResource>()
    for (const line of volumeText.split("\n")) {
      if (line.length === 0) continue
      const resource = labeledResource(line)
      if (
        resource !== null &&
        resource.kind === "volume" &&
        resource.name === volumeName(
            resource.jobId,
            resource.attemptId
          ) &&
        !protectedVolumeKeys.has(
          resourceKey(resource.jobId, resource.attemptId)
        )
      ) {
        orphanVolumes.push(resource)
      }
    }

    for (const initializer of initializerContainers) {
      yield* removeContainer(spawner, initializer.name)
    }
    for (const session of nonRunningSessionContainers) {
      yield* removeContainer(spawner, session.name)
    }
    for (const volume of orphanVolumes) {
      yield* removeVolume(spawner, volume.name)
    }

    liveSessions.sort((left, right) => left.containerName.localeCompare(right.containerName))
    const removedInitializerContainers = initializerContainers
      .map(({ name }) => name)
      .sort()
    const removedNonRunningSessionContainers = nonRunningSessionContainers
      .map(({ name }) => name)
      .sort()
    const removedOrphanVolumes = orphanVolumes
      .map(({ name }) => name)
      .sort()
    return {
      liveSessions,
      removedInitializerContainers,
      removedNonRunningSessionContainers,
      removedOrphanVolumes
    } satisfies PrReviewSandboxReconciliation
  })

  return PrReviewSandboxSessions.of({ reconcile, withSession })
})

/** Production layer for scoped writable Review Sandbox sessions. */
export const prReviewSandboxSessionsLayer = (
  options: PrReviewSandboxSessionOptions
): Layer.Layer<
  PrReviewSandboxSessions,
  PrReviewSandboxSessionError,
  | FileSystem.FileSystem
  | PrReviewSourceWorkspace
  | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(PrReviewSandboxSessions, makeSessions(options))

const ToolOutput = Schema.Struct({
  artifactId: Schema.NullOr(PrReviewCommandArtifactId),
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
  parameters: Schema.Struct({
    path: Schema.optionalKey(RelativeSandboxPath)
  }),
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
  parameters: Schema.Struct({
    patch: PatchText
  }),
  success: ToolCommandResult
})

/** Read the complete temporary Git diff, with artifact retention when large. */
export const ReviewReadDiff = Tool.make("ReviewReadDiff", {
  description: "Read the current temporary workspace Git diff.",
  failure: PrReviewSandboxSessionError,
  success: ToolCommandResult
})

/** Page retained command output by opaque session-local artifact ID. */
export const ReviewPageArtifact = Tool.make("ReviewPageArtifact", {
  description: "Read a bounded page from complete command output retained by this session.",
  failure: PrReviewSandboxSessionError,
  parameters: Schema.Struct({
    artifactId: PrReviewCommandArtifactId,
    offset: PositiveOffset,
    limit: PositiveLimit
  }),
  success: Schema.Struct({ page: Schema.String })
})

/** Search retained command output without returning the complete artifact. */
export const ReviewSearchArtifact = Tool.make("ReviewSearchArtifact", {
  description: "Find text offsets in complete command output retained by this session.",
  failure: PrReviewSandboxSessionError,
  parameters: Schema.Struct({
    artifactId: PrReviewCommandArtifactId,
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
    ReviewPageArtifact: ({ artifactId, limit, offset }) =>
      session.pageArtifact(artifactId, offset, limit).pipe(
        Effect.map((page) => ({ page }))
      ),
    ReviewSearchArtifact: ({ artifactId, query }) =>
      session.searchArtifact(artifactId, query).pipe(
        Effect.map((offsets) => ({ offsets }))
      )
  })
