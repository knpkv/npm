/** @effect-diagnostics strictEffectProvide:skip-file */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Result, Schema, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { JobId, PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  codeCommitPrReviewSourceResolverLayer,
  codeCommitPrReviewSourceResolverLayerWithFixture,
  drainPrReviewProcessDiagnostics,
  PrReviewSourceResolver,
  PrReviewSourceWorkspace,
  prReviewSourceWorkspaceLayer,
  PrReviewWorkspaceLeaseGuard
} from "../../src/server/agent/internal/PrReviewSourceWorkspace.js"
import { isPrReviewAuthorityConfigKey } from "../../src/server/agent/internal/PrReviewWorkspaceProtocol.js"
import { databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { StoredPluginConfigurationKey } from "../../src/server/persistence/repositories/pluginConfigurationModels.js"
import { makeSecretStore, SecretRoot, SecretStore } from "../../src/server/secrets/SecretStore.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000021")
const JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000051")
const CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000061")
const CREATED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-24T10:00:00.000Z")
const STALE_JOB_ID = JobId.make("01890f6f-6d6a-7cc0-98d2-000000000052")

const inactiveLeaseGuard = Layer.succeed(
  PrReviewWorkspaceLeaseGuard,
  PrReviewWorkspaceLeaseGuard.of({ isActive: () => Effect.succeed(false) })
)

const gitEnvironment = {
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
} satisfies Readonly<Record<string, string>>

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
  it.effect("drains noisy successful Git diagnostics without retaining them", () =>
    drainPrReviewProcessDiagnostics(
      Stream.make(new Uint8Array(16_384))
    ))

  it("classifies authority-bearing Git configuration without rejecting inert local keys", () => {
    for (
      const invalid of [
        "credential.helper",
        "http.extraHeader",
        "http.https://example.invalid.extraHeader",
        "remote.origin.url",
        "url.ssh://example.invalid/.insteadOf",
        "url.ssh://example.invalid/.pushInsteadOf",
        "core.sshCommand",
        "include.path",
        "includeIf.gitdir:~/work/.path"
      ]
    ) {
      assert.isTrue(isPrReviewAuthorityConfigKey(invalid), invalid)
    }
    for (
      const valid of [
        "branch.main.merge",
        "core.repositoryformatversion",
        "user.name"
      ]
    ) {
      assert.isFalse(isPrReviewAuthorityConfigKey(valid), valid)
    }
  })

  it.effect("resolves exactly one enabled CodeCommit connection without exposing configuration publicly", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("pr-review-source-resolver-")
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provideMerge(database))
      const fileSystem = yield* FileSystem.FileSystem
      const secretRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pr-review-source-secrets-" })
      const secretStore = yield* makeSecretStore({ secretRoot: SecretRoot.make(secretRoot) })
      const secrets = Layer.succeed(SecretStore, secretStore)
      const profileRef = yield* secretStore.create(new TextEncoder().encode("review-profile"))
      const resolver = codeCommitPrReviewSourceResolverLayer.pipe(
        Layer.provide(persistence),
        Layer.provide(secrets)
      )
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
              _tag: "secret-reference",
              key: StoredPluginConfigurationKey.make("profile"),
              ref: profileRef
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
        const sourceResolver = yield* PrReviewSourceResolver
        const location = yield* sourceResolver.resolve({
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
        const fixtureResolver = codeCommitPrReviewSourceResolverLayerWithFixture({
          repositoryName: "control-center",
          repositoryUrl: "file:///tmp/codecommit-mock/control-center.git"
        }).pipe(
          Layer.provide(persistence),
          Layer.provide(secrets)
        )
        const fixtureLocation = yield* Effect.gen(function*() {
          const sourceResolver = yield* PrReviewSourceResolver
          return yield* sourceResolver.resolve({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            repository: "control-center",
            baseRevision: "1".repeat(40),
            headRevision: "2".repeat(40)
          })
        }).pipe(Effect.provide(fixtureResolver))
        assert.deepStrictEqual(fixtureLocation, {
          repositoryUrl: "file:///tmp/codecommit-mock/control-center.git",
          profile: "review-profile",
          region: "eu-central-1"
        })
        const mismatchedFixture = codeCommitPrReviewSourceResolverLayerWithFixture({
          repositoryName: "other-repository",
          repositoryUrl: "file:///tmp/codecommit-mock/other-repository.git"
        }).pipe(
          Layer.provide(persistence),
          Layer.provide(secrets)
        )
        const mismatch = yield* Effect.gen(function*() {
          const sourceResolver = yield* PrReviewSourceResolver
          return yield* sourceResolver.resolve({
            workspaceId: WORKSPACE_ID,
            jobId: JOB_ID,
            repository: "control-center",
            baseRevision: "1".repeat(40),
            headRevision: "2".repeat(40)
          })
        }).pipe(Effect.provide(mismatchedFixture), Effect.result)
        assert.isTrue(Result.isFailure(mismatch))
        if (Result.isFailure(mismatch)) {
          assert.strictEqual(mismatch.failure._tag, "PrReviewSourceError")
          if (mismatch.failure._tag === "PrReviewSourceError") {
            assert.strictEqual(mismatch.failure.reason, "connection-unavailable")
          }
        }
      }).pipe(Effect.provide(Layer.mergeAll(persistence, resolver, secrets)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("materializes an exact local Git head for the callback and removes it afterwards", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const fixture = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pr-review-source-fixture-" })
        const canonicalFixture = yield* fileSystem.realPath(fixture)
        const repository = path.join(canonicalFixture, "repository")
        const workspaceRoot = path.join(canonicalFixture, "workspaces")
        yield* fileSystem.makeDirectory(repository)
        yield* fileSystem.makeDirectory(workspaceRoot)
        yield* runGit(["-C", repository, "init", "--quiet"])
        yield* fileSystem.makeDirectory(path.join(repository, ".opencode"))
        yield* fileSystem.symlink("../.agents/skills", path.join(repository, ".opencode", "skills"))
        yield* fileSystem.writeFileString(path.join(repository, "review.ts"), "export const value = 1\n")
        yield* runGit(["-C", repository, "add", "--", ".opencode/skills", "review.ts"])
        yield* runGit(["-C", repository, "commit", "--quiet", "-m", "base"])
        const baseRevision = yield* runGit(["-C", repository, "rev-parse", "HEAD"])
        yield* fileSystem.writeFileString(path.join(repository, "review.ts"), "export const value = 2\n")
        yield* runGit(["-C", repository, "add", "--", "review.ts"])
        yield* runGit(["-C", repository, "commit", "--quiet", "-m", "head"])
        const headRevision = yield* runGit(["-C", repository, "rev-parse", "HEAD"])
        yield* fileSystem.writeFileString(path.join(repository, "review.ts"), "export const value = 3\n")
        yield* runGit(["-C", repository, "add", "--", "review.ts"])
        yield* runGit(["-C", repository, "commit", "--quiet", "-m", "branch moved after enqueue"])

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
          Layer.provide(resolver),
          Layer.provide(inactiveLeaseGuard)
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
                assert.strictEqual(
                  yield* fileSystem.readLink(path.join(sourceRoot, ".opencode", "skills")),
                  "../.agents/skills"
                )
                const remotes = yield* runGit(["-C", sourceRoot, "remote"])
                assert.strictEqual(remotes, "")
                const configuration = yield* fileSystem.readFileString(
                  path.join(sourceRoot, ".git", "config")
                )
                assert.notInclude(configuration, repository)
                assert.notInclude(configuration.toLowerCase(), "credential")
                return {
                  content: yield* fileSystem.readFileString(path.join(sourceRoot, "review.ts")),
                  revision: yield* runGit(["-C", sourceRoot, "rev-parse", "HEAD"])
                }
              })
          )
        }).pipe(Effect.provide(sources))

        assert.strictEqual(
          Schema.decodeSync(Schema.String.check(Schema.isNonEmpty()))(observed.revision),
          headRevision
        )
        assert.strictEqual(observed.content, "export const value = 2\n")
        assert.isFalse(yield* fileSystem.exists(materializedRoot))
      })
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects a source symlink that escapes the immutable checkout", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const fixture = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pr-review-source-symlink-" })
        const canonicalFixture = yield* fileSystem.realPath(fixture)
        const repository = path.join(canonicalFixture, "repository")
        const workspaceRoot = path.join(canonicalFixture, "workspaces")
        yield* fileSystem.makeDirectory(repository)
        yield* fileSystem.makeDirectory(workspaceRoot)
        yield* fileSystem.makeDirectory(path.join(repository, ".opencode"))
        yield* runGit(["-C", repository, "init", "--quiet"])
        yield* fileSystem.symlink("../../outside", path.join(repository, ".opencode", "skills"))
        yield* runGit(["-C", repository, "add", "--", ".opencode/skills"])
        yield* runGit(["-C", repository, "commit", "--quiet", "-m", "escaping symlink"])
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
            prReviewSourceWorkspaceLayer({ workspaceRoot }).pipe(
              Layer.provide(resolver),
              Layer.provide(inactiveLeaseGuard)
            )
          ),
          Effect.result
        )

        assert.isTrue(Result.isFailure(observed))
        if (Result.isFailure(observed)) {
          assert.strictEqual(observed.failure.reason, "source-rejected")
        }
        assert.isFalse(callbackCalled)
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
            }).pipe(
              Layer.provide(resolver),
              Layer.provide(inactiveLeaseGuard)
            )
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

  it.effect("repairs an existing workspace root to private permissions before use", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const fixture = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pr-review-source-mode-" })
        const workspaceRoot = path.join(fixture, "workspaces")
        yield* fileSystem.chmod(fixture, 0o755)
        yield* fileSystem.makeDirectory(workspaceRoot, { mode: 0o755 })
        assert.strictEqual((yield* fileSystem.stat(workspaceRoot)).mode & 0o777, 0o755)
        const resolver = Layer.succeed(
          PrReviewSourceResolver,
          PrReviewSourceResolver.of({
            resolve: () => Effect.die("workspace mode test must not resolve a source")
          })
        )

        yield* PrReviewSourceWorkspace.pipe(
          Effect.provide(
            prReviewSourceWorkspaceLayer({ workspaceRoot }).pipe(
              Layer.provide(resolver),
              Layer.provide(inactiveLeaseGuard)
            )
          )
        )

        assert.strictEqual((yield* fileSystem.stat(workspaceRoot)).mode & 0o777, 0o700)
      })
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reclaims expired artifacts without crossing a live worker lease", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const fixture = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pr-review-source-reconcile-" })
        const repository = path.join(fixture, "repository")
        const workspaceRoot = path.join(fixture, "workspaces")
        yield* fileSystem.makeDirectory(repository)
        yield* fileSystem.makeDirectory(workspaceRoot)
        yield* runGit(["-C", repository, "init", "--quiet"])
        yield* fileSystem.writeFileString(path.join(repository, "review.ts"), "export const live = true\n")
        yield* runGit(["-C", repository, "add", "--", "review.ts"])
        yield* runGit(["-C", repository, "commit", "--quiet", "-m", "live"])
        const revision = yield* runGit(["-C", repository, "rev-parse", "HEAD"])

        const activeStaging = path.join(workspaceRoot, `.review-staging-${JOB_ID}-live`)
        const activeTree = path.join(workspaceRoot, `.pr-review-tree-${JOB_ID}-live`)
        const activeGit = path.join(workspaceRoot, `.pr-review-git-${JOB_ID}-live`)
        const staleStaging = path.join(workspaceRoot, `.review-staging-${STALE_JOB_ID}-crash`)
        const staleTree = path.join(workspaceRoot, `.pr-review-tree-${STALE_JOB_ID}-crash`)
        const staleGit = path.join(workspaceRoot, `.pr-review-git-${STALE_JOB_ID}-crash`)
        const staleJob = path.join(workspaceRoot, STALE_JOB_ID)
        const unrelated = path.join(workspaceRoot, "operator-owned")
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
        const leaseGuard = Layer.succeed(
          PrReviewWorkspaceLeaseGuard,
          PrReviewWorkspaceLeaseGuard.of({
            isActive: (jobId) => Effect.succeed(jobId === JOB_ID)
          })
        )
        const workspaceLayer = prReviewSourceWorkspaceLayer({ workspaceRoot }).pipe(
          Layer.provide(resolver),
          Layer.provide(leaseGuard)
        )
        const ready = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const liveWorker = yield* Effect.gen(function*() {
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
              Effect.gen(function*() {
                yield* fileSystem.makeDirectory(activeStaging)
                yield* fileSystem.makeDirectory(activeTree)
                yield* fileSystem.makeDirectory(activeGit)
                yield* Deferred.succeed(ready, undefined)
                yield* Deferred.await(release)
              })
          )
        }).pipe(
          Effect.provide(workspaceLayer),
          Effect.forkScoped
        )
        yield* Deferred.await(ready)

        yield* fileSystem.makeDirectory(staleStaging)
        yield* fileSystem.makeDirectory(staleTree)
        yield* fileSystem.makeDirectory(staleGit)
        yield* fileSystem.makeDirectory(staleJob)
        yield* fileSystem.makeDirectory(unrelated)
        yield* PrReviewSourceWorkspace.pipe(Effect.provide(workspaceLayer))

        assert.isTrue(yield* fileSystem.exists(path.join(workspaceRoot, JOB_ID)))
        assert.isTrue(yield* fileSystem.exists(activeStaging))
        assert.isTrue(yield* fileSystem.exists(activeTree))
        assert.isTrue(yield* fileSystem.exists(activeGit))
        assert.isFalse(yield* fileSystem.exists(staleStaging))
        assert.isFalse(yield* fileSystem.exists(staleTree))
        assert.isFalse(yield* fileSystem.exists(staleGit))
        assert.isFalse(yield* fileSystem.exists(staleJob))
        assert.isTrue(yield* fileSystem.exists(unrelated))
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(liveWorker)
      })
    ).pipe(Effect.provide(NodeServices.layer)))
})
