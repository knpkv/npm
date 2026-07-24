/** Hardened, server-owned execution boundary for immutable pull-request review. @module */
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { JobId } from "../../../domain/identifiers.js"
import { PrReviewPath } from "../../../domain/prReview.js"

const OCI_EXECUTABLE = "docker"
const GIT_EXECUTABLE = "git"
const CONTAINER_SOURCE = "/workspace"
const CONTAINER_UID_GID = "65532:65532"
const MAXIMUM_STDERR_BYTES = 8_192
const MAXIMUM_CONTROL_STDOUT_BYTES = 4_096
const MAXIMUM_GIT_STDOUT_BYTES = 128
const MAXIMUM_GIT_TREE_STDOUT_BYTES = 16 * 1_024 * 1_024
const MAXIMUM_REVIEW_TREE_ARCHIVE_BYTES = 64 * 1_024 * 1_024
const DEFAULT_MAXIMUM_DURATION_MILLIS = 120_000
const MAXIMUM_DURATION_MILLIS = 300_000
const CONTROL_COMMAND_TIMEOUT_MILLIS = 30_000

/** Maximum UTF-8 JSON size accepted from the contained static analyzer. */
export const MAXIMUM_PR_REVIEW_SANDBOX_EVIDENCE_BYTES = 32_768

const DigestPinnedImage = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(512),
  Schema.isPattern(
    /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?@sha256:[a-f0-9]{64}$/u,
    { expected: "an OCI image reference pinned by a sha256 digest" }
  )
).pipe(Schema.brand("PrReviewSandboxImage"))

const hasNoControlCharacters = (value: string, allowMultiline: boolean): boolean =>
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined &&
      (
        (allowMultiline && (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d)) ||
        !((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
      )
  })

const TrustedCommandArgument = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
  Schema.makeFilter((value) => hasNoControlCharacters(value, false), {
    expected: "a command argument without control characters"
  })
)

const TrustedAnalyzerCommand = Schema.Array(TrustedCommandArgument).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32),
  Schema.makeFilter(
    (command) =>
      command.slice(1).every((argument) =>
        argument !== "--" &&
        argument !== "--head-revision" &&
        !argument.startsWith("--head-revision=")
      ),
    { expected: "an analyzer command whose revision argument is owned by the runner" }
  )
)

const MaximumDurationMillis = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAXIMUM_DURATION_MILLIS })
)

const GitHeadRevision = Schema.String.check(
  Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, {
    expected: "a full lowercase Git object identifier"
  })
)

const SandboxAttemptId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{12}$/u, {
    expected: "a 12-character lowercase hexadecimal attempt identifier"
  })
)

const BoundedEvidenceText = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(2_000),
  Schema.makeFilter((value) => hasNoControlCharacters(value, true), {
    expected: "bounded evidence text without unsafe control characters"
  })
)

const BoundedToolToken = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+:/-]*$/u, {
    expected: "a bounded analyzer token"
  })
)

const EvidenceLine = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
)

const PrReviewSandboxEvidenceItem = Schema.Struct({
  ruleId: BoundedToolToken,
  severity: Schema.Literals(["error", "warning", "info"]),
  path: PrReviewPath,
  startLine: EvidenceLine,
  endLine: EvidenceLine,
  message: BoundedEvidenceText
}).check(
  Schema.makeFilter(({ endLine, startLine }) => startLine <= endLine, {
    expected: "an evidence end line at or after its start line"
  })
)

const jsonEncoder = new TextEncoder()

/** Bounded static-analysis evidence. Host-side A12 model execution consumes this internal envelope. */
export const PrReviewSandboxEvidence = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  headRevision: GitHeadRevision,
  tool: Schema.Struct({
    name: BoundedToolToken,
    version: BoundedToolToken
  }),
  findings: Schema.Array(PrReviewSandboxEvidenceItem).check(Schema.isMaxLength(100))
}).check(
  Schema.makeFilter((value) => {
    const json = JSON.stringify(value)
    return json !== undefined &&
      jsonEncoder.encode(json).byteLength <= MAXIMUM_PR_REVIEW_SANDBOX_EVIDENCE_BYTES
  }, {
    expected: `JSON encoded as at most ${MAXIMUM_PR_REVIEW_SANDBOX_EVIDENCE_BYTES} UTF-8 bytes`
  })
)

/** Decoded static-analysis evidence emitted by the immutable sandbox. */
export type PrReviewSandboxEvidence = typeof PrReviewSandboxEvidence.Type

const SandboxRequest = Schema.Struct({
  attemptId: SandboxAttemptId,
  jobId: JobId,
  headRevision: GitHeadRevision
})

const SandboxOptions = Schema.Struct({
  workspaceRoot: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(4_096),
    Schema.makeFilter((value) => !value.includes(","), {
      expected: "a workspace root compatible with Docker bind-mount field syntax"
    })
  ),
  image: DigestPinnedImage,
  analyzerCommand: TrustedAnalyzerCommand,
  maximumDurationMillis: Schema.optionalKey(MaximumDurationMillis)
})

/** Trusted construction material; none of these values may originate in a review request or model output. */
export interface PrReviewSandboxRunnerOptions {
  readonly workspaceRoot: string
  readonly image: string
  readonly analyzerCommand: ReadonlyArray<string>
  readonly maximumDurationMillis?: number
}

/** Durable immutable identity presented to the sandbox boundary. */
export interface PrReviewSandboxRequest {
  readonly attemptId: string
  readonly jobId: JobId
  readonly headRevision: string
}

/** Stable redacted reasons which never retain paths, command lines, daemon output, or credentials. */
export class PrReviewSandboxError extends Schema.TaggedErrorClass<PrReviewSandboxError>()(
  "PrReviewSandboxError",
  {
    reason: Schema.Literals([
      "invalid-configuration",
      "invalid-request",
      "source-unavailable",
      "source-rejected",
      "revision-mismatch",
      "sandbox-unavailable",
      "sandbox-failed",
      "sandbox-timeout",
      "output-rejected",
      "cleanup-failed"
    ])
  }
) {}

interface ProcessResult {
  readonly exitCode: ChildProcessSpawner.ExitCode
  readonly stderr: Uint8Array
  readonly stdout: Uint8Array
}

interface ByteAccumulator {
  readonly chunks: Array<Uint8Array>
  readonly length: number
}

const sandboxError = (reason: PrReviewSandboxError["reason"]): PrReviewSandboxError =>
  new PrReviewSandboxError({ reason })

const isContainedPath = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
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
  stream: Stream.Stream<Uint8Array, unknown, never>,
  maximumBytes: number
): Effect.Effect<Uint8Array, PrReviewSandboxError> =>
  stream.pipe(
    Stream.runFoldEffect(
      (): ByteAccumulator => ({ chunks: [], length: 0 }),
      (accumulator, chunk) => {
        const length = accumulator.length + chunk.byteLength
        return length > maximumBytes
          ? Effect.fail(sandboxError("output-rejected"))
          : Effect.succeed({
            chunks: [...accumulator.chunks, Uint8Array.from(chunk)],
            length
          })
      }
    ),
    Effect.map(concatenate),
    Effect.mapError((error) =>
      Predicate.isTagged(error, "PrReviewSandboxError") &&
        Predicate.hasProperty(error, "reason") &&
        error.reason === "output-rejected"
        ? sandboxError("output-rejected")
        : sandboxError("sandbox-unavailable")
    )
  )

const processEnvironment: Readonly<Record<string, string>> = {
  DOCKER_CONFIG: "/nonexistent",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: "/nonexistent",
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin"
}

const command = (executable: string, args: ReadonlyArray<string>): ChildProcess.StandardCommand =>
  ChildProcess.make(executable, args, {
    env: processEnvironment,
    extendEnv: false,
    forceKillAfter: Duration.seconds(5),
    shell: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  })

const execute = Effect.fn("PrReviewSandboxRunner.execute")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  executable: string,
  args: ReadonlyArray<string>,
  maximumStdoutBytes: number
): Effect.fn.Return<ProcessResult, PrReviewSandboxError> {
  return yield* Effect.scoped(
    Effect.gen(function*() {
      const handle = yield* spawner.spawn(command(executable, args)).pipe(
        Effect.mapError(() => sandboxError("sandbox-unavailable"))
      )
      const [exitCode, stderr, stdout] = yield* Effect.all([
        handle.exitCode.pipe(Effect.mapError(() => sandboxError("sandbox-unavailable"))),
        collectBounded(handle.stderr, MAXIMUM_STDERR_BYTES),
        collectBounded(handle.stdout, maximumStdoutBytes)
      ], { concurrency: "unbounded" })
      return { exitCode, stderr, stdout }
    })
  )
})

const executeControl = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  executable: string,
  args: ReadonlyArray<string>,
  maximumStdoutBytes: number
): Effect.Effect<ProcessResult, PrReviewSandboxError> =>
  execute(spawner, executable, args, maximumStdoutBytes).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(CONTROL_COMMAND_TIMEOUT_MILLIS),
      orElse: () => Effect.fail(sandboxError("sandbox-timeout"))
    })
  )

const decodeUtf8 = (
  bytes: Uint8Array,
  reason: PrReviewSandboxError["reason"]
): Effect.Effect<string, PrReviewSandboxError> =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => sandboxError(reason)
  })

const exactGitHead = (text: string): string | undefined => {
  if (text.endsWith("\n") && !text.endsWith("\n\n")) return text.slice(0, -1)
  return text.includes("\n") || text.includes("\r") ? undefined : text
}

const hasNoGitlinks = (bytes: Uint8Array): boolean => {
  const gitlink = new TextEncoder().encode("160000 commit ")
  let recordStart = 0
  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] !== 0) continue
    let isGitlink = index - recordStart >= gitlink.byteLength
    for (let offset = 0; isGitlink && offset < gitlink.byteLength; offset++) {
      isGitlink = bytes[recordStart + offset] === gitlink[offset]
    }
    if (isGitlink) return false
    recordStart = index + 1
  }
  return recordStart === bytes.byteLength
}

const decodeEvidence = Effect.fn("PrReviewSandboxRunner.decodeEvidence")(function*(
  bytes: Uint8Array,
  headRevision: string
) {
  const text = yield* decodeUtf8(bytes, "output-rejected")
  const evidence = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(PrReviewSandboxEvidence),
    { onExcessProperty: "error" }
  )(text).pipe(
    Effect.mapError(() => sandboxError("output-rejected"))
  )
  if (evidence.headRevision !== headRevision) {
    return yield* sandboxError("output-rejected")
  }
  return evidence
})

const containerName = (jobId: JobId, attemptId: string): string => `cc-pr-review-${jobId}-${attemptId}`

const sourceGitArguments = (
  checkout: string,
  args: ReadonlyArray<string>
): ReadonlyArray<string> => [
  "--no-replace-objects",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-C",
  checkout,
  ...args
]

const missingContainerStderr = (container: string): ReadonlyArray<string> => [
  `Error response from daemon: No such container: ${container}\n`,
  `Error: No such container: ${container}\n`
]

const createArguments = (
  source: string,
  name: string,
  image: string,
  analyzerEntrypoint: string,
  analyzerArguments: ReadonlyArray<string>,
  headRevision: string
): ReadonlyArray<string> => [
  "container",
  "create",
  "--name",
  name,
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
  "512m",
  "--memory-swap",
  "512m",
  "--tmpfs",
  "/tmp:rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=0700",
  "--mount",
  `type=bind,src=${source},dst=${CONTAINER_SOURCE},readonly`,
  "--workdir",
  CONTAINER_SOURCE,
  "--entrypoint",
  analyzerEntrypoint,
  image,
  ...analyzerArguments,
  "--head-revision",
  headRevision
]

const prepareReviewTree = Effect.fn("PrReviewSandboxRunner.prepareReviewTree")(function*(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  workspaceRoot: string,
  checkout: string,
  headRevision: string
) {
  const archive = yield* fileSystem.makeTempFileScoped({
    directory: workspaceRoot,
    prefix: ".pr-review-tree-",
    suffix: ".tar"
  }).pipe(
    Effect.mapError(() => sandboxError("source-unavailable"))
  )
  const reviewTree = yield* fileSystem.makeTempDirectoryScoped({
    directory: workspaceRoot,
    prefix: ".pr-review-tree-"
  }).pipe(
    Effect.mapError(() => sandboxError("source-unavailable"))
  )
  yield* fileSystem.chmod(reviewTree, 0o755).pipe(
    Effect.mapError(() => sandboxError("source-unavailable"))
  )

  const objectFormatResult = yield* executeControl(
    spawner,
    GIT_EXECUTABLE,
    sourceGitArguments(checkout, ["rev-parse", "--show-object-format"]),
    MAXIMUM_GIT_STDOUT_BYTES
  )
  const objectFormat = yield* decodeUtf8(
    objectFormatResult.stdout,
    "source-rejected"
  ).pipe(Effect.map(exactGitHead))
  if (
    objectFormatResult.exitCode !== ChildProcessSpawner.ExitCode(0) ||
    (objectFormat !== "sha1" && objectFormat !== "sha256")
  ) {
    return yield* sandboxError("source-rejected")
  }

  const objectStoreResult = yield* executeControl(
    spawner,
    GIT_EXECUTABLE,
    sourceGitArguments(checkout, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects"
    ]),
    MAXIMUM_CONTROL_STDOUT_BYTES
  )
  const objectStore = yield* decodeUtf8(
    objectStoreResult.stdout,
    "source-rejected"
  ).pipe(Effect.map(exactGitHead))
  if (
    objectStoreResult.exitCode !== ChildProcessSpawner.ExitCode(0) ||
    objectStore === undefined ||
    !path.isAbsolute(objectStore) ||
    !hasNoControlCharacters(objectStore, false)
  ) {
    return yield* sandboxError("source-rejected")
  }

  const treeEntries = yield* executeControl(
    spawner,
    GIT_EXECUTABLE,
    sourceGitArguments(checkout, [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      headRevision
    ]),
    MAXIMUM_GIT_TREE_STDOUT_BYTES
  ).pipe(
    Effect.mapError((error) =>
      error.reason === "output-rejected"
        ? sandboxError("source-rejected")
        : error
    )
  )
  if (
    treeEntries.exitCode !== ChildProcessSpawner.ExitCode(0) ||
    !hasNoGitlinks(treeEntries.stdout)
  ) {
    return yield* sandboxError("source-rejected")
  }

  const archiveGitDirectory = yield* fileSystem.makeTempDirectoryScoped({
    directory: workspaceRoot,
    prefix: ".pr-review-git-"
  }).pipe(
    Effect.mapError(() => sandboxError("source-unavailable"))
  )
  const initialized = yield* executeControl(
    spawner,
    GIT_EXECUTABLE,
    [
      "init",
      "--bare",
      "--quiet",
      `--object-format=${objectFormat}`,
      archiveGitDirectory
    ],
    MAXIMUM_CONTROL_STDOUT_BYTES
  )
  if (initialized.exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* sandboxError("source-unavailable")
  }
  yield* fileSystem.makeDirectory(
    path.join(archiveGitDirectory, "objects", "info"),
    { recursive: true, mode: 0o700 }
  ).pipe(
    Effect.andThen(
      fileSystem.makeDirectory(
        path.join(archiveGitDirectory, "info"),
        { recursive: true, mode: 0o700 }
      )
    ),
    Effect.andThen(
      fileSystem.writeFileString(
        path.join(archiveGitDirectory, "objects", "info", "alternates"),
        `${objectStore}\n`,
        { mode: 0o600 }
      )
    ),
    Effect.andThen(
      fileSystem.writeFileString(
        path.join(archiveGitDirectory, "info", "attributes"),
        "** -export-ignore -export-subst\n",
        { mode: 0o600 }
      )
    ),
    Effect.mapError(() => sandboxError("source-unavailable"))
  )

  const archived = yield* executeControl(
    spawner,
    GIT_EXECUTABLE,
    [
      "--no-replace-objects",
      "--no-optional-locks",
      "--git-dir",
      archiveGitDirectory,
      "-c",
      "core.bare=true",
      "-c",
      "tar.umask=0022",
      "archive",
      "--format=tar",
      headRevision
    ],
    MAXIMUM_REVIEW_TREE_ARCHIVE_BYTES
  ).pipe(
    Effect.mapError((error) =>
      error.reason === "output-rejected"
        ? sandboxError("source-rejected")
        : error
    )
  )
  if (archived.exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* sandboxError("source-unavailable")
  }
  yield* fileSystem.writeFile(archive, archived.stdout, { mode: 0o600 }).pipe(
    Effect.mapError(() => sandboxError("source-unavailable"))
  )

  const extracted = yield* executeControl(
    spawner,
    "tar",
    [
      "--extract",
      "--file",
      archive,
      "--directory",
      reviewTree,
      "--no-same-owner",
      "--same-permissions"
    ],
    MAXIMUM_CONTROL_STDOUT_BYTES
  )
  if (extracted.exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* sandboxError("source-unavailable")
  }
  return reviewTree
})

const cleanupContainer = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  name: string
): Effect.Effect<void, PrReviewSandboxError> =>
  executeControl(
    spawner,
    OCI_EXECUTABLE,
    ["container", "rm", "--force", "--volumes", name],
    MAXIMUM_CONTROL_STDOUT_BYTES
  ).pipe(
    Effect.mapError(() => sandboxError("cleanup-failed")),
    Effect.flatMap(({ exitCode, stderr }) => {
      if (exitCode === ChildProcessSpawner.ExitCode(0)) return Effect.void
      return decodeUtf8(stderr, "cleanup-failed").pipe(
        Effect.flatMap((text) =>
          missingContainerStderr(name).includes(text)
            ? Effect.void
            : Effect.fail(sandboxError("cleanup-failed"))
        )
      )
    })
  )

const runContainedAnalysis = Effect.fn("PrReviewSandboxRunner.runContainedAnalysis")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  request: PrReviewSandboxRequest,
  source: string,
  image: string,
  analyzerEntrypoint: string,
  analyzerArguments: ReadonlyArray<string>,
  maximumDurationMillis: number
) {
  const name = containerName(request.jobId, request.attemptId)
  const inspect = yield* executeControl(
    spawner,
    OCI_EXECUTABLE,
    ["container", "inspect", "--type", "container", "--format", "{{.Id}}", name],
    MAXIMUM_CONTROL_STDOUT_BYTES
  )
  if (inspect.exitCode === ChildProcessSpawner.ExitCode(0)) {
    yield* cleanupContainer(spawner, name)
  } else {
    const inspectStderr = yield* decodeUtf8(inspect.stderr, "sandbox-unavailable")
    if (!missingContainerStderr(name).includes(inspectStderr)) {
      return yield* sandboxError("sandbox-unavailable")
    }
  }

  const createSandbox = executeControl(
    spawner,
    OCI_EXECUTABLE,
    createArguments(
      source,
      name,
      image,
      analyzerEntrypoint,
      analyzerArguments,
      request.headRevision
    ),
    MAXIMUM_CONTROL_STDOUT_BYTES
  ).pipe(
    Effect.flatMap((created) =>
      created.exitCode === ChildProcessSpawner.ExitCode(0)
        ? Effect.void
        : Effect.fail(sandboxError("sandbox-unavailable"))
    )
  )

  const cleanupFailure = yield* Ref.make<PrReviewSandboxError | undefined>(undefined)
  const analysis = yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      createSandbox.pipe(
        Effect.andThen(
          execute(
            spawner,
            OCI_EXECUTABLE,
            ["container", "start", "--attach", name],
            MAXIMUM_PR_REVIEW_SANDBOX_EVIDENCE_BYTES
          ).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(maximumDurationMillis),
              orElse: () => Effect.fail(sandboxError("sandbox-timeout"))
            }),
            Effect.flatMap((result) =>
              result.exitCode === ChildProcessSpawner.ExitCode(0)
                ? Effect.succeed(result)
                : Effect.fail(sandboxError("sandbox-failed"))
            )
          )
        )
      ),
    () =>
      cleanupContainer(spawner, name).pipe(
        Effect.catch((error) => Ref.set(cleanupFailure, error))
      )
  )
  const cleanupError = yield* Ref.get(cleanupFailure)
  if (cleanupError !== undefined) return yield* cleanupError
  return yield* decodeEvidence(analysis.stdout, request.headRevision)
})

/** Internal process-isolated PR-review service. It is intentionally absent from package entry points. */
export interface PrReviewSandboxRunnerService {
  readonly run: (
    request: unknown
  ) => Effect.Effect<PrReviewSandboxEvidence, PrReviewSandboxError>
}

/** Dependency-injection seam for the hardened production runner. */
export class PrReviewSandboxRunner extends Context.Service<
  PrReviewSandboxRunner,
  PrReviewSandboxRunnerService
>()("@knpkv/control-center/server/agent/internal/PrReviewSandboxRunner") {}

const makeRunner = Effect.fn("PrReviewSandboxRunner.make")(function*(
  unknownOptions: PrReviewSandboxRunnerOptions
) {
  const options = yield* Schema.decodeUnknownEffect(SandboxOptions)(unknownOptions).pipe(
    Effect.mapError(() => sandboxError("invalid-configuration"))
  )
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const configuredRoot = path.resolve(options.workspaceRoot)
  if (configuredRoot.includes(",")) {
    return yield* sandboxError("invalid-configuration")
  }
  const canonicalRoot = yield* fileSystem.realPath(configuredRoot).pipe(
    Effect.mapError(() => sandboxError("invalid-configuration"))
  )
  if (canonicalRoot !== configuredRoot || canonicalRoot.includes(",")) {
    return yield* sandboxError("invalid-configuration")
  }
  const rootInfo = yield* fileSystem.stat(canonicalRoot).pipe(
    Effect.mapError(() => sandboxError("invalid-configuration"))
  )
  if (rootInfo.type !== "Directory") {
    return yield* sandboxError("invalid-configuration")
  }
  const analyzerEntrypoint = options.analyzerCommand[0]
  if (analyzerEntrypoint === undefined) {
    return yield* sandboxError("invalid-configuration")
  }
  const analyzerArguments = options.analyzerCommand.slice(1)
  const maximumDurationMillis = options.maximumDurationMillis ?? DEFAULT_MAXIMUM_DURATION_MILLIS

  const run = Effect.fn("PrReviewSandboxRunner.run")(function*(
    unknownRequest: unknown
  ): Effect.fn.Return<PrReviewSandboxEvidence, PrReviewSandboxError> {
    const request = yield* Schema.decodeUnknownEffect(SandboxRequest)(unknownRequest).pipe(
      Effect.mapError(() => sandboxError("invalid-request"))
    )
    const expectedSource = path.resolve(canonicalRoot, request.jobId)
    if (!isContainedPath(path, canonicalRoot, expectedSource)) {
      return yield* sandboxError("source-rejected")
    }
    const canonicalSource = yield* fileSystem.realPath(expectedSource).pipe(
      Effect.mapError(() => sandboxError("source-unavailable"))
    )
    if (!isContainedPath(path, canonicalRoot, canonicalSource)) {
      return yield* sandboxError("source-rejected")
    }
    const sourceInfo = yield* fileSystem.stat(canonicalSource).pipe(
      Effect.mapError(() => sandboxError("source-unavailable"))
    )
    if (sourceInfo.type !== "Directory") {
      return yield* sandboxError("source-rejected")
    }

    const repositoryRoot = yield* executeControl(
      spawner,
      GIT_EXECUTABLE,
      sourceGitArguments(canonicalSource, ["rev-parse", "--show-toplevel"]),
      MAXIMUM_CONTROL_STDOUT_BYTES
    )
    if (repositoryRoot.exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* sandboxError("source-unavailable")
    }
    const repositoryRootText = yield* decodeUtf8(
      repositoryRoot.stdout,
      "source-unavailable"
    )
    if (exactGitHead(repositoryRootText) !== canonicalSource) {
      return yield* sandboxError("source-rejected")
    }

    const head = yield* executeControl(
      spawner,
      GIT_EXECUTABLE,
      sourceGitArguments(canonicalSource, ["rev-parse", "--verify", "HEAD"]),
      MAXIMUM_GIT_STDOUT_BYTES
    )
    if (head.exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* sandboxError("source-unavailable")
    }
    const headText = yield* decodeUtf8(head.stdout, "source-unavailable")
    if (exactGitHead(headText) !== request.headRevision) {
      return yield* sandboxError("revision-mismatch")
    }

    return yield* Effect.scoped(
      Effect.gen(function*() {
        const reviewTree = yield* prepareReviewTree(
          fileSystem,
          path,
          spawner,
          canonicalRoot,
          canonicalSource,
          request.headRevision
        )
        return yield* runContainedAnalysis(
          spawner,
          request,
          reviewTree,
          options.image,
          analyzerEntrypoint,
          analyzerArguments,
          maximumDurationMillis
        )
      })
    )
  })

  return PrReviewSandboxRunner.of({ run })
})

/** Production layer for the internal immutable PR-review sandbox boundary. */
export const prReviewSandboxRunnerLayer = (
  options: PrReviewSandboxRunnerOptions
): Layer.Layer<
  PrReviewSandboxRunner,
  PrReviewSandboxError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(PrReviewSandboxRunner, makeRunner(options))
