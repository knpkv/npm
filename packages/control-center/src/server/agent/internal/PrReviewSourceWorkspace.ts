/** Materialize one immutable CodeCommit review source into a private, scoped workspace. @module */
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { JobId, WorkspaceId } from "../../../domain/identifiers.js"
import { Persistence } from "../../persistence/Persistence.js"
import type { StoredPluginConfiguration } from "../../persistence/repositories/pluginConfigurationModels.js"
import { CodeCommitPluginConfiguration } from "../../plugins/codecommit/CodeCommitPluginDefinition.js"

const GIT_EXECUTABLE = "git"
const STAGING_PREFIX = ".review-staging-"
const MAXIMUM_PROCESS_OUTPUT_BYTES = 8_192
const DEFAULT_MAXIMUM_DURATION = Duration.minutes(2)

const GitRevision = Schema.String.check(
  Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, {
    expected: "a full lowercase Git object identifier"
  })
)

const SourceProfile = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.makeFilter(
    (value) =>
      Array.from(value).every((character) => {
        const codePoint = character.codePointAt(0)
        return codePoint !== undefined &&
          !((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
      }),
    { expected: "an AWS profile without control characters" }
  )
)

const SourceRegion = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u, {
    expected: "an AWS region that is one DNS label"
  })
)

const SourceRequest = Schema.Struct({
  workspaceId: WorkspaceId,
  jobId: JobId,
  repository: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9._-]{1,100}$/u, {
      expected: "a CodeCommit repository name"
    })
  ),
  baseRevision: GitRevision,
  headRevision: GitRevision
})

/** Immutable source identity needed before the sandbox can inspect a review. */
export interface PrReviewSourceRequest {
  readonly workspaceId: WorkspaceId
  readonly jobId: JobId
  readonly repository: string
  readonly baseRevision: string
  readonly headRevision: string
}

/** Server-owned clone location. Credentials stay in the child-process environment. */
export interface PrReviewSourceLocation {
  readonly repositoryUrl: string
  readonly environment: Readonly<Record<string, string>>
}

/** Stable source failures that retain neither paths nor provider diagnostics. */
export class PrReviewSourceError extends Schema.TaggedErrorClass<PrReviewSourceError>()(
  "PrReviewSourceError",
  {
    reason: Schema.Literals([
      "invalid-configuration",
      "invalid-request",
      "connection-unavailable",
      "source-unavailable",
      "revision-mismatch",
      "cleanup-failed"
    ])
  }
) {}

const sourceError = (reason: PrReviewSourceError["reason"]): PrReviewSourceError => new PrReviewSourceError({ reason })

/** Resolve an immutable review subject to one credentialed, server-only repository location. */
export class PrReviewSourceResolver extends Context.Service<
  PrReviewSourceResolver,
  {
    readonly resolve: (
      request: PrReviewSourceRequest
    ) => Effect.Effect<PrReviewSourceLocation, PrReviewSourceError>
  }
>()("@knpkv/control-center/server/agent/internal/PrReviewSourceResolver") {}

const configuredText = (
  values: StoredPluginConfiguration,
  key: string
): string | undefined => {
  const value = values.find((candidate) => candidate.key === key)
  return value?._tag === "text" ? value.value : undefined
}

const makeCodeCommitResolver = Effect.gen(function*() {
  const persistence = yield* Persistence
  return PrReviewSourceResolver.of({
    resolve: Effect.fn("PrReviewSourceResolver.resolve")(function*(unknownRequest) {
      const request = yield* Schema.decodeUnknownEffect(SourceRequest)(unknownRequest).pipe(
        Effect.mapError(() => sourceError("invalid-request"))
      )
      const connections = yield* persistence.pluginConnections.list(request.workspaceId).pipe(
        Effect.mapError(() => sourceError("connection-unavailable"))
      )
      const matches = new Array<typeof CodeCommitPluginConfiguration.Type>()
      for (const connection of connections) {
        if (!connection.isEnabled || connection.providerId !== "codecommit") continue
        const stored = yield* persistence.pluginConfigurations.get(
          request.workspaceId,
          connection.pluginConnectionId
        ).pipe(Effect.mapError(() => sourceError("connection-unavailable")))
        if (Option.isNone(stored)) continue
        const candidate = Schema.decodeUnknownResult(CodeCommitPluginConfiguration)({
          profile: configuredText(stored.value.values, "profile"),
          region: configuredText(stored.value.values, "region"),
          repositoryName: configuredText(stored.value.values, "repositoryName")
        })
        if (
          Result.isSuccess(candidate) &&
          Schema.is(SourceProfile)(candidate.success.profile) &&
          Schema.is(SourceRegion)(candidate.success.region) &&
          candidate.success.repositoryName === request.repository
        ) {
          matches.push(candidate.success)
        }
      }
      if (matches.length !== 1) return yield* sourceError("connection-unavailable")
      const [configuration] = matches
      if (configuration === undefined) return yield* sourceError("connection-unavailable")
      return {
        repositoryUrl:
          `https://git-codecommit.${configuration.region}.amazonaws.com/v1/repos/${configuration.repositoryName}`,
        environment: {
          AWS_DEFAULT_REGION: configuration.region,
          AWS_PROFILE: configuration.profile
        }
      } satisfies PrReviewSourceLocation
    })
  })
})

/** Production resolver for enabled CodeCommit connections in the review workspace. */
export const codeCommitPrReviewSourceResolverLayer: Layer.Layer<
  PrReviewSourceResolver,
  never,
  Persistence
> = Layer.effect(PrReviewSourceResolver, makeCodeCommitResolver)

interface ProcessResult {
  readonly exitCode: ChildProcessSpawner.ExitCode
  readonly stdout: Uint8Array
}

const collectBounded = (
  stream: Stream.Stream<Uint8Array, unknown>,
  maximumBytes: number
): Effect.Effect<Uint8Array, PrReviewSourceError> =>
  stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: new Array<Uint8Array>(), length: 0 }),
      (state, chunk) => {
        const length = state.length + chunk.byteLength
        if (length > maximumBytes) return Effect.fail(sourceError("source-unavailable"))
        state.chunks.push(chunk)
        return Effect.succeed({ chunks: state.chunks, length })
      }
    ),
    Effect.map(({ chunks, length }) => {
      const output = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        output.set(chunk, offset)
        offset += chunk.byteLength
      }
      return output
    }),
    Effect.mapError(() => sourceError("source-unavailable"))
  )

const command = (
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>>,
  platformEnvironment: Readonly<Record<string, string>>
): ChildProcess.StandardCommand =>
  ChildProcess.make(GIT_EXECUTABLE, args, {
    env: {
      ...platformEnvironment,
      ...environment,
      GCM_INTERACTIVE: "Never",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C"
    },
    extendEnv: false,
    forceKillAfter: Duration.seconds(5),
    shell: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  })

const execute = Effect.fn("PrReviewSourceWorkspace.execute")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>>,
  platformEnvironment: Readonly<Record<string, string>>,
  maximumDuration: Duration.Duration
) {
  return yield* Effect.scoped(
    Effect.gen(function*() {
      const handle = yield* spawner.spawn(command(args, environment, platformEnvironment)).pipe(
        Effect.mapError(() => sourceError("source-unavailable"))
      )
      const { exitCode, stdout } = yield* Effect.all({
        exitCode: handle.exitCode.pipe(Effect.mapError(() => sourceError("source-unavailable"))),
        stdout: collectBounded(handle.stdout, MAXIMUM_PROCESS_OUTPUT_BYTES),
        stderr: collectBounded(handle.stderr, MAXIMUM_PROCESS_OUTPUT_BYTES)
      }, { concurrency: "unbounded" })
      return { exitCode, stdout } satisfies ProcessResult
    })
  ).pipe(
    Effect.timeoutOrElse({
      duration: maximumDuration,
      orElse: () => Effect.fail(sourceError("source-unavailable"))
    })
  )
})

const decodedLine = (bytes: Uint8Array): string | undefined => {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return value.endsWith("\n") && !value.endsWith("\n\n")
      ? value.slice(0, -1)
      : value.includes("\n") || value.includes("\r")
      ? undefined
      : value
  } catch {
    return undefined
  }
}

const successful = (result: ProcessResult): boolean => result.exitCode === ChildProcessSpawner.ExitCode(0)

/** Private root and timeout used for bounded source materialization. */
export interface PrReviewSourceWorkspaceOptions {
  readonly workspaceRoot: string
  readonly maximumDuration?: Duration.Input
}

/** Scoped source owner: the callback runs only while the exact checkout exists. */
export class PrReviewSourceWorkspace extends Context.Service<
  PrReviewSourceWorkspace,
  {
    readonly withSource: <Success, Failure, Requirements>(
      request: PrReviewSourceRequest,
      use: (sourceRoot: string) => Effect.Effect<Success, Failure, Requirements>
    ) => Effect.Effect<Success, Failure | PrReviewSourceError, Requirements>
  }
>()("@knpkv/control-center/server/agent/internal/PrReviewSourceWorkspace") {}

const makeWorkspace = Effect.fn("PrReviewSourceWorkspace.make")(function*(
  options: PrReviewSourceWorkspaceOptions
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const resolver = yield* PrReviewSourceResolver
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const home = yield* Config.string("HOME").pipe(
    Effect.mapError(() => sourceError("invalid-configuration"))
  )
  const executablePath = yield* Config.string("PATH").pipe(
    Effect.mapError(() => sourceError("invalid-configuration"))
  )
  const platformEnvironment = { HOME: home, PATH: executablePath }
  const configuredRoot = path.resolve(options.workspaceRoot)
  yield* fileSystem.makeDirectory(configuredRoot, { recursive: true, mode: 0o700 }).pipe(
    Effect.mapError(() => sourceError("invalid-configuration"))
  )
  const canonicalRoot = yield* fileSystem.realPath(configuredRoot).pipe(
    Effect.mapError(() => sourceError("invalid-configuration"))
  )
  if (canonicalRoot !== configuredRoot) return yield* sourceError("invalid-configuration")
  const maximumDuration = Duration.fromInputUnsafe(options.maximumDuration ?? DEFAULT_MAXIMUM_DURATION)

  const removeSource = (sourceRoot: string) =>
    fileSystem.remove(sourceRoot, { force: true, recursive: true }).pipe(
      Effect.mapError(() => sourceError("cleanup-failed"))
    )

  return PrReviewSourceWorkspace.of({
    withSource: (unknownRequest, use) =>
      Effect.gen(function*() {
        const request = yield* Schema.decodeUnknownEffect(SourceRequest)(unknownRequest).pipe(
          Effect.mapError(() => sourceError("invalid-request"))
        )
        const sourceRoot = path.join(canonicalRoot, request.jobId)
        if (
          path.dirname(sourceRoot) !== canonicalRoot ||
          path.basename(sourceRoot) !== request.jobId
        ) {
          return yield* sourceError("invalid-request")
        }
        const location = yield* resolver.resolve(request)
        const existing = yield* fileSystem.exists(sourceRoot).pipe(
          Effect.mapError(() => sourceError("source-unavailable"))
        )
        if (existing) yield* removeSource(sourceRoot)

        return yield* Effect.acquireUseRelease(
          fileSystem.makeTempDirectory({
            directory: canonicalRoot,
            prefix: STAGING_PREFIX
          }).pipe(
            Effect.mapError(() => sourceError("source-unavailable")),
            Effect.flatMap((stagingRoot) =>
              Effect.acquireUseRelease(
                Effect.succeed(stagingRoot),
                (stagingRoot) =>
                  Effect.gen(function*() {
                    const stagedSource = path.join(stagingRoot, "source")
                    const cloned = yield* execute(
                      spawner,
                      [
                        "-c",
                        "credential.helper=!aws codecommit credential-helper $@",
                        "-c",
                        "credential.UseHttpPath=true",
                        "clone",
                        "--quiet",
                        "--no-checkout",
                        "--no-tags",
                        "--",
                        location.repositoryUrl,
                        stagedSource
                      ],
                      location.environment,
                      platformEnvironment,
                      maximumDuration
                    )
                    if (!successful(cloned)) return yield* sourceError("source-unavailable")

                    const base = yield* execute(
                      spawner,
                      ["-C", stagedSource, "cat-file", "-e", `${request.baseRevision}^{commit}`],
                      location.environment,
                      platformEnvironment,
                      maximumDuration
                    )
                    const head = yield* execute(
                      spawner,
                      ["-C", stagedSource, "cat-file", "-e", `${request.headRevision}^{commit}`],
                      location.environment,
                      platformEnvironment,
                      maximumDuration
                    )
                    if (!successful(base) || !successful(head)) {
                      return yield* sourceError("source-unavailable")
                    }
                    const checkedOut = yield* execute(
                      spawner,
                      ["-C", stagedSource, "checkout", "--quiet", "--detach", "--force", request.headRevision],
                      location.environment,
                      platformEnvironment,
                      maximumDuration
                    )
                    if (!successful(checkedOut)) return yield* sourceError("source-unavailable")
                    const actualHead = yield* execute(
                      spawner,
                      ["-C", stagedSource, "rev-parse", "--verify", "HEAD"],
                      location.environment,
                      platformEnvironment,
                      maximumDuration
                    )
                    if (!successful(actualHead) || decodedLine(actualHead.stdout) !== request.headRevision) {
                      return yield* sourceError("revision-mismatch")
                    }
                    yield* fileSystem.rename(stagedSource, sourceRoot).pipe(
                      Effect.mapError(() => sourceError("source-unavailable"))
                    )
                    return sourceRoot
                  }),
                (stagingRoot) =>
                  fileSystem.remove(stagingRoot, { force: true, recursive: true }).pipe(
                    Effect.mapError(() => sourceError("cleanup-failed"))
                  )
              )
            )
          ),
          (materialized) => use(materialized),
          removeSource
        )
      })
  })
})

/** Production source-workspace layer; resolver choice stays independently injectable in tests. */
export const prReviewSourceWorkspaceLayer = (
  options: PrReviewSourceWorkspaceOptions
): Layer.Layer<
  PrReviewSourceWorkspace,
  PrReviewSourceError,
  | FileSystem.FileSystem
  | Path.Path
  | PrReviewSourceResolver
  | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(PrReviewSourceWorkspace, makeWorkspace(options))
