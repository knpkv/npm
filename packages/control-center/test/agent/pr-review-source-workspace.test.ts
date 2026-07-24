import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Result, Schema, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { JobId, PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  codeCommitPrReviewSourceResolverLayer,
  PrReviewSourceResolver,
  PrReviewSourceWorkspace,
  prReviewSourceWorkspaceLayer
} from "../../src/server/agent/internal/PrReviewSourceWorkspace.js"
import { databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { StoredPluginConfigurationKey } from "../../src/server/persistence/repositories/pluginConfigurationModels.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000021")
const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000051")
const CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000061")
const CREATED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-24T10:00:00.000Z")

const gitEnvironment: Readonly<Record<string, string>> = {
  GIT_AUTHOR_EMAIL: "review-fixture@example.invalid",
  GIT_AUTHOR_NAME: "Review Fixture",
  GIT_COMMITTER_EMAIL: "review-fixture@example.invalid",
  GIT_COMMITTER_NAME: "Review Fixture",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: "/nonexistent",
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin"
}

const runGit = (args: ReadonlyArray<string>): Effect.Effect<
  string,
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function*() {
      const handle = yield* ChildProcess.make("git", args, {
        env: gitEnvironment,
        extendEnv: false,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe"
      })
      const [exitCode, stderr, stdout] = yield* Effect.all([
        handle.exitCode,
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString)
      ])
      assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(0), stderr)
      return stdout.trim()
    })
  )

describe("PR review source workspace", () => {
  it.effect("resolves exactly one enabled CodeCommit connection without exposing configuration publicly", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("pr-review-source-resolver-")
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provideMerge(database))
      const resolver = codeCommitPrReviewSourceResolverLayer.pipe(Layer.provide(persistence))
      return yield* Effect.gen(function*() {
        const durable = yield* Persistence
        yield* durable.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Review workspace"),
          createdAt: CREATED_AT
        })
        yield* durable.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: CONNECTION_ID,
          providerId: "codecommit",
          displayName: PluginConnectionDisplayName.make("Review repository"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        yield* durable.pluginConfigurations.update(
          WORKSPACE_ID,
          CONNECTION_ID,
          [
            {
              _tag: "text",
              key: StoredPluginConfigurationKey.make("profile"),
              value: "review-profile"
            },
            {
              _tag: "text",
              key: StoredPluginConfigurationKey.make("region"),
              value: "eu-central-1"
            },
            {
              _tag: "text",
              key: StoredPluginConfigurationKey.make("repositoryName"),
              value: "control-center"
            }
          ],
          0,
          CREATED_AT
        )
        const location = yield* (yield* PrReviewSourceResolver).resolve({
          workspaceId: WORKSPACE_ID,
          jobId: JOB_ID,
          repository: "control-center",
          baseRevision: "1".repeat(40),
          headRevision: "2".repeat(40)
        })
        assert.deepStrictEqual(location, {
          repositoryUrl: "https://git-codecommit.eu-central-1.amazonaws.com/v1/repos/control-center",
          profile: "review-profile",
          region: "eu-central-1"
        })
      }).pipe(Effect.provide(Layer.merge(persistence, resolver)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("materializes an exact local Git head for the callback and removes it afterwards", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const fixture = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pr-review-source-fixture-" })
        const repository = path.join(fixture, "repository")
        const workspaceRoot = path.join(fixture, "workspaces")
        yield* fileSystem.makeDirectory(repository)
        yield* fileSystem.makeDirectory(workspaceRoot)
        yield* runGit(["-C", repository, "init", "--quiet"])
        yield* fileSystem.writeFileString(path.join(repository, "review.ts"), "export const value = 1\n")
        yield* runGit(["-C", repository, "add", "--", "review.ts"])
        yield* runGit(["-C", repository, "commit", "--quiet", "-m", "base"])
        const baseRevision = yield* runGit(["-C", repository, "rev-parse", "HEAD"])
        yield* fileSystem.writeFileString(path.join(repository, "review.ts"), "export const value = 2\n")
        yield* runGit(["-C", repository, "add", "--", "review.ts"])
        yield* runGit(["-C", repository, "commit", "--quiet", "-m", "head"])
        const headRevision = yield* runGit(["-C", repository, "rev-parse", "HEAD"])

        const resolver = Layer.succeed(
          PrReviewSourceResolver,
          PrReviewSourceResolver.of({
            resolve: () =>
              Effect.succeed({
                repositoryUrl: repository,
                profile: "unused-test-profile",
                region: "eu-central-1"
              })
          })
        )
        const sources = prReviewSourceWorkspaceLayer({ workspaceRoot }).pipe(
          Layer.provide(resolver)
        )
        const materializedRoot = path.join(workspaceRoot, JOB_ID)
        const observed = yield* Effect.gen(function*() {
          const workspace = yield* PrReviewSourceWorkspace
          return yield* workspace.withSource(
            {
              workspaceId: WORKSPACE_ID,
              jobId: JOB_ID,
              repository: "control-center",
              baseRevision,
              headRevision
            },
            (sourceRoot) =>
              Effect.gen(function*() {
                assert.strictEqual(sourceRoot, materializedRoot)
                assert.isTrue(yield* fileSystem.exists(path.join(sourceRoot, "review.ts")))
                return yield* runGit(["-C", sourceRoot, "rev-parse", "HEAD"])
              })
          )
        }).pipe(Effect.provide(sources))

        assert.strictEqual(
          Schema.decodeSync(Schema.String.check(Schema.isNonEmpty()))(observed),
          headRevision
        )
        assert.isFalse(yield* fileSystem.exists(materializedRoot))
      })
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects an over-quota source before the callback and removes owned staging", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const fixture = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pr-review-source-quota-" })
        const repository = path.join(fixture, "repository")
        const workspaceRoot = path.join(fixture, "workspaces")
        yield* fileSystem.makeDirectory(repository)
        yield* fileSystem.makeDirectory(workspaceRoot)
        yield* runGit(["-C", repository, "init", "--quiet"])
        yield* fileSystem.writeFileString(path.join(repository, "large.txt"), "x".repeat(4_096))
        yield* runGit(["-C", repository, "add", "--", "large.txt"])
        yield* runGit(["-C", repository, "commit", "--quiet", "-m", "large"])
        const revision = yield* runGit(["-C", repository, "rev-parse", "HEAD"])
        const resolver = Layer.succeed(
          PrReviewSourceResolver,
          PrReviewSourceResolver.of({
            resolve: () =>
              Effect.succeed({
                repositoryUrl: repository,
                profile: "unused-test-profile",
                region: "eu-central-1"
              })
          })
        )
        let callbackCalled = false
        const observed = yield* Effect.gen(function*() {
          const workspace = yield* PrReviewSourceWorkspace
          return yield* workspace.withSource(
            {
              workspaceId: WORKSPACE_ID,
              jobId: JOB_ID,
              repository: "control-center",
              baseRevision: revision,
              headRevision: revision
            },
            () =>
              Effect.sync(() => {
                callbackCalled = true
              })
          )
        }).pipe(
          Effect.provide(
            prReviewSourceWorkspaceLayer({
              workspaceRoot,
              maximumSourceBytes: 1_024,
              maximumSourceEntries: 100
            }).pipe(Layer.provide(resolver))
          ),
          Effect.result
        )

        assert.isTrue(Result.isFailure(observed))
        if (Result.isFailure(observed)) {
          assert.strictEqual(observed.failure.reason, "source-rejected")
        }
        assert.isFalse(callbackCalled)
        assert.deepStrictEqual(yield* fileSystem.readDirectory(workspaceRoot), [])
      })
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reconciles owned crash leftovers without deleting unrelated directories", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const fixture = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pr-review-source-reconcile-" })
        const workspaceRoot = path.join(fixture, "workspaces")
        const staging = path.join(workspaceRoot, ".review-staging-crash")
        const job = path.join(workspaceRoot, JOB_ID)
        const unrelated = path.join(workspaceRoot, "operator-owned")
        yield* fileSystem.makeDirectory(staging, { recursive: true })
        yield* fileSystem.makeDirectory(job)
        yield* fileSystem.makeDirectory(unrelated)
        const resolver = Layer.succeed(
          PrReviewSourceResolver,
          PrReviewSourceResolver.of({
            resolve: () => Effect.die("reconciliation must not resolve a source")
          })
        )
        yield* Effect.gen(function*() {
          yield* PrReviewSourceWorkspace
        }).pipe(
          Effect.provide(prReviewSourceWorkspaceLayer({ workspaceRoot }).pipe(Layer.provide(resolver)))
        )

        assert.isFalse(yield* fileSystem.exists(staging))
        assert.isFalse(yield* fileSystem.exists(job))
        assert.isTrue(yield* fileSystem.exists(unrelated))
      })
    ).pipe(Effect.provide(NodeServices.layer)))
})
