/** @effect-diagnostics strictEffectProvide:skip-file */

import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import {
  Cause,
  ConfigProvider,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Ref,
  Scope,
  Sink,
  Stream
} from "effect"
import * as FileSystem from "effect/FileSystem"
import { ChildProcessSpawner } from "effect/unstable/process"
import { SandboxRepo, type SandboxRow } from "../src/CacheService/repos/SandboxRepo.js"
import * as ChildEnv from "../src/ChildEnv.js"
import { ConfigService, defaultSandboxConfig } from "../src/ConfigService/index.js"
import { SandboxId } from "../src/Domain.js"
import { DockerError } from "../src/Errors.js"
import { type ContainerInfo, DockerService } from "../src/SandboxService/DockerService.js"
import { PluginService } from "../src/SandboxService/PluginService.js"
import { SandboxService } from "../src/SandboxService/SandboxService.js"
import { SandboxWorkerScope } from "../src/SandboxService/SandboxWorkerScope.js"

const createParams = {
  pullRequestId: "42",
  awsAccountId: "123456789012",
  repositoryName: "repository",
  sourceBranch: "refs/heads/feature",
  profile: "test-profile",
  region: "us-east-1"
}

const config = {
  accounts: [],
  autoDetect: false,
  autoRefresh: false,
  refreshIntervalSeconds: 300,
  sandbox: defaultSandboxConfig
}

const legacyRow: SandboxRow = {
  id: "legacy-sandbox",
  pullRequestId: "42",
  awsAccountId: "123456789012",
  repositoryName: "repository",
  region: "",
  sourceBranch: "refs/heads/feature",
  accessPassword: null,
  workspacePath: "/tmp/codecommit-sandbox-worker-test/legacy-sandbox",
  containerId: "legacy-container",
  port: 18080,
  status: "running",
  statusDetail: null,
  logs: null,
  error: null,
  legacyRetiredAt: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  lastActivityAt: "2026-08-10T00:00:00.000Z"
}

interface FixtureOptions {
  readonly config?: typeof config
  readonly initialRow?: SandboxRow
  readonly existingByPr?: SandboxRow
  readonly profileByPr?: SandboxRow
  readonly profileKey?: string
  readonly emptyAccountByPr?: SandboxRow
  readonly emptyAccountByPrAll?: ReadonlyArray<SandboxRow>
  readonly insertGate?: {
    readonly inserted: Deferred.Deferred<void>
    readonly release: Deferred.Deferred<void>
  }
  readonly forkGate?: {
    readonly forked: Deferred.Deferred<void>
    readonly release: Deferred.Deferred<void>
  }
  readonly closedFork?: boolean
  readonly readyGate?: {
    readonly reached: Deferred.Deferred<void>
    readonly release: Deferred.Deferred<void>
  }
  readonly restartGate?: {
    readonly started: Deferred.Deferred<void>
    readonly release: Deferred.Deferred<void>
  }
  readonly retirementGate?: {
    readonly reached: Deferred.Deferred<void>
    readonly release: Deferred.Deferred<void>
  }
  readonly rowsById?: Readonly<Record<string, SandboxRow>>
  readonly regionlessByPr?: SandboxRow
  readonly regionlessByPrAll?: ReadonlyArray<SandboxRow>
  readonly stopContainer?: Effect.Effect<void, DockerError>
  readonly stopContainerByAttempt?: (attempt: number) => Effect.Effect<void, DockerError>
  readonly inspectContainer?: (containerId: string) => Effect.Effect<ContainerInfo, DockerError>
  readonly listContainersByLabel?: () => Effect.Effect<
    ReadonlyArray<{ readonly Id: string; readonly State: string; readonly Labels: Record<string, string> }>,
    DockerError
  >
  readonly untrackedContainers?: ReadonlyArray<{
    readonly Id: string
    readonly State: string
    readonly Labels: Record<string, string>
  }>
}

const makeFixture = Effect.fn("SandboxWorkerScopeTest.makeFixture")(function*(
  makeDirectory: FileSystem.FileSystem["makeDirectory"],
  options?: FixtureOptions
) {
  const rowRef = yield* Ref.make<SandboxRow | undefined>(options?.initialRow)
  const insertCalls = yield* Ref.make(0)
  const containerDiscoveryCalls = yield* Ref.make(0)
  const stopContainerCalls = yield* Ref.make(0)
  const regionUpdates = yield* Ref.make<Array<{ readonly id: string; readonly region: string }>>([])
  const errorTransitioned = yield* Deferred.make<void>()
  const workerCause = yield* Deferred.make<Cause.Cause<unknown>>()

  const repositoryLayer = Layer.mock(SandboxRepo, {
    findByPr: (_awsAccountId, _pullRequestId, _repositoryName, region) =>
      Ref.get(rowRef).pipe(
        Effect.map((current) => {
          const configured = _awsAccountId.length === 0
            ? options?.emptyAccountByPr
            : _awsAccountId === (options?.profileKey ?? createParams.profile)
            ? options?.profileByPr
            : options?.existingByPr
          const row = configured ?? current
          return row !== undefined && row.awsAccountId === _awsAccountId && row.region === region
            ? Option.some(row)
            : Option.none<SandboxRow>()
        })
      ),
    findRegionlessByPr: () =>
      Effect.succeed(
        options?.regionlessByPr === undefined ? Option.none<SandboxRow>() : Option.some(options.regionlessByPr)
      ),
    findRegionlessByPrAll: () =>
      Effect.succeed(
        options?.regionlessByPrAll ?? (options?.regionlessByPr === undefined ? [] : [options.regionlessByPr])
      ),
    findActive: () =>
      Ref.get(rowRef).pipe(
        Effect.map((row) =>
          row !== undefined && ["creating", "cloning", "starting", "running"].includes(row.status) ? [row] : []
        )
      ),
    findAll: () =>
      Ref.get(rowRef).pipe(
        Effect.map((row) => {
          const configured = [options?.emptyAccountByPr, ...(options?.emptyAccountByPrAll ?? [])].filter(
            (candidate): candidate is SandboxRow => candidate !== undefined
          )
          if (options?.profileByPr !== undefined) configured.push(options.profileByPr)
          const rows = row === undefined ? configured : [row, ...configured]
          return Array.from(new Map(rows.map((candidate) => [candidate.id, candidate])).values())
        })
      ),
    insert: (input) =>
      Ref.update(insertCalls, (count) => count + 1).pipe(
        Effect.andThen(
          Ref.set(rowRef, {
            ...input,
            containerId: null,
            port: null,
            statusDetail: null,
            logs: null,
            error: null,
            legacyRetiredAt: null
          })
        ),
        Effect.andThen(
          options?.insertGate === undefined
            ? Effect.void
            : Deferred.succeed(options.insertGate.inserted, undefined).pipe(
              Effect.andThen(Deferred.await(options.insertGate.release))
            )
        )
      ),
    findById: (id) =>
      Ref.get(rowRef).pipe(
        Effect.flatMap((row) =>
          options?.rowsById?.[String(id)] !== undefined
            ? Effect.succeed(options.rowsById[String(id)])
            : row === undefined
            ? Effect.die("Sandbox row was not inserted")
            : Effect.succeed(row)
        )
      ),
    updateStatus: (_id, status, extra) =>
      Ref.update(rowRef, (row) =>
        row === undefined
          ? row
          : {
            ...row,
            status,
            containerId: extra?.containerId ?? row.containerId,
            port: extra?.port ?? row.port,
            error: extra?.error ?? row.error,
            legacyRetiredAt: extra?.legacyRetiredAt ?? row.legacyRetiredAt
          }).pipe(
          Effect.andThen(
            status === "error"
              ? Deferred.succeed(errorTransitioned, undefined)
              : Effect.void
          )
        ),
    updateDetail: (_id, detail) =>
      Ref.update(rowRef, (row) => row === undefined ? row : { ...row, statusDetail: detail }),
    appendLog: (_id, line) =>
      Ref.update(rowRef, (row) => row === undefined ? row : { ...row, logs: `${row.logs ?? ""}${line}\n` }),
    updateRegion: (id, region) => Ref.update(regionUpdates, (updates) => [...updates, { id: String(id), region }])
  })

  const dependencies = Layer.mergeAll(
    repositoryLayer,
    // The clone spawn tombstones the ambient AWS variables it would otherwise inherit.
    ChildEnv.layerHostEnvironment({ PATH: "/usr/bin" }),
    Layer.mock(DockerService, {
      pullImage: () => Effect.void,
      createContainer: () => Effect.succeed("worker-container"),
      startContainer: () =>
        options?.restartGate === undefined
          ? Effect.void
          : Deferred.succeed(options.restartGate.started, undefined).pipe(
            Effect.andThen(Deferred.await(options.restartGate.release))
          ),
      exec: () => Effect.succeed(""),
      stopContainer: () =>
        Ref.getAndUpdate(stopContainerCalls, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            options?.stopContainerByAttempt?.(attempt) ?? options?.stopContainer ?? Effect.void
          )
        ),
      inspectContainer: (containerId) =>
        options?.inspectContainer?.(containerId) ??
          Effect.fail(new DockerError({ operation: "inspectContainer", cause: "not configured" })),
      listContainersByLabel: () =>
        Ref.update(containerDiscoveryCalls, (count) => count + 1).pipe(
          Effect.andThen(
            options?.retirementGate === undefined
              ? Effect.void
              : Deferred.succeed(options.retirementGate.reached, undefined).pipe(
                Effect.andThen(Deferred.await(options.retirementGate.release))
              )
          ),
          Effect.andThen(
            options?.listContainersByLabel?.() ??
              Effect.succeed([...(options?.untrackedContainers ?? [])])
          )
        )
    }),
    Layer.mock(PluginService, {
      executeHook: (hook) =>
        hook === "onSandboxReady" && options?.readyGate !== undefined
          ? Deferred.succeed(options.readyGate.reached, undefined).pipe(
            Effect.andThen(Deferred.await(options.readyGate.release))
          )
          : Effect.void
    }),
    Layer.mock(ConfigService, { load: Effect.succeed(options?.config ?? config) }),
    Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.FileSystem.of({
        makeDirectory,
        stat: () =>
          Effect.succeed({
            type: "Directory",
            mtime: Option.none<Date>(),
            atime: Option.none<Date>(),
            birthtime: Option.none<Date>(),
            dev: 0,
            ino: Option.none<number>(),
            mode: 0o755,
            nlink: Option.none<number>(),
            uid: Option.none<number>(),
            gid: Option.none<number>(),
            rdev: Option.none<number>(),
            size: FileSystem.Size(0),
            blksize: Option.none<FileSystem.Size>(),
            blocks: Option.none<number>()
          })
      })
    ),
    NodePath.layer,
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            all: Stream.empty,
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            pid: ChildProcessSpawner.ProcessId(42),
            stderr: Stream.empty,
            stdin: Sink.drain,
            stdout: Stream.empty,
            unref: Effect.succeed(Effect.void)
          })
        )
      )
    ),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data)
      })
    ),
    Layer.effect(
      SandboxWorkerScope,
      Effect.map(Effect.scope, (scope) =>
        SandboxWorkerScope.of({
          fork: (worker, release) =>
            Effect.gen(function*() {
              const started = yield* Deferred.make<void>()
              const forkScope = options?.closedFork === true ? yield* Scope.make() : scope
              if (options?.closedFork === true) yield* Scope.close(forkScope, Exit.void)
              const fiber = yield* Effect.forkIn(
                Effect.acquireUseRelease(
                  Deferred.succeed(started, undefined),
                  () =>
                    worker.pipe(
                      Effect.onExit((exit) =>
                        Exit.isFailure(exit)
                          ? Deferred.succeed(workerCause, exit.cause)
                          : Effect.void
                      )
                    ),
                  () => release
                ),
                forkScope
              )
              if (options?.forkGate !== undefined) {
                yield* Deferred.succeed(options.forkGate.forked, undefined)
                yield* Deferred.await(options.forkGate.release)
              }
              return { fiber, started: Deferred.await(started) }
            })
        }))
    ),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: "/tmp/codecommit-sandbox-worker-test" } }))
  )

  return {
    containerDiscoveryCalls,
    errorTransitioned,
    insertCalls,
    layer: SandboxService.layer.pipe(Layer.provideMerge(dependencies)),
    rowRef,
    regionUpdates,
    stopContainerCalls,
    workerCause
  }
})

describe("SandboxWorkerScope", () => {
  it.effect("rejects invalid sandbox settings before inserting a row", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(
        () => Effect.void,
        {
          config: {
            ...config,
            sandbox: { ...config.sandbox, image: "codercom/code-server:latest" }
          }
        }
      )

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(createParams)),
          Effect.provide(fixture.layer),
          Effect.result
        )
      )

      expect(result._tag).toBe("Failure")
      expect(yield* Ref.get(fixture.insertCalls)).toBe(0)
      expect(yield* Ref.get(fixture.rowRef)).toBeUndefined()
    }))

  it.effect("inserts exactly once after sandbox settings pass validation", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.never)

      yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(createParams)),
          Effect.provide(fixture.layer)
        )
      )

      expect(yield* Ref.get(fixture.insertCalls)).toBe(1)
    }))

  it.effect("does not retire the exact row when profile and account keys match", () =>
    Effect.gen(function*() {
      const exact = {
        ...legacyRow,
        region: createParams.region,
        accessPassword: "protected",
        status: "running"
      }
      const params = { ...createParams, profile: createParams.awsAccountId }
      const fixture = yield* makeFixture(() => Effect.never, {
        initialRow: exact,
        existingByPr: exact
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(params)),
          Effect.provide(fixture.layer)
        )
      )

      expect(result.id).toBe(exact.id)
      expect(yield* Ref.get(fixture.insertCalls)).toBe(0)
      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(0)
    }))

  it.effect("reports an ordinary stopping sandbox instead of returning it for creation", () =>
    Effect.gen(function*() {
      const stopping: SandboxRow = {
        ...legacyRow,
        region: createParams.region,
        accessPassword: "protected",
        status: "stopping",
        legacyRetiredAt: null
      }
      const fixture = yield* makeFixture(() => Effect.never, {
        initialRow: stopping,
        existingByPr: stopping
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(createParams)),
          Effect.result,
          Effect.provide(fixture.layer)
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("still stopping")
      }
      expect(yield* Ref.get(fixture.insertCalls)).toBe(0)
      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(0)
    }))

  it.effect("skips completed legacy retirement when reusing an exact row", () =>
    Effect.gen(function*() {
      const exact: SandboxRow = { ...legacyRow, region: createParams.region, status: "running" }
      const completed: SandboxRow = {
        ...legacyRow,
        id: "completed-legacy",
        awsAccountId: "",
        region: createParams.region,
        accessPassword: "protected",
        status: "stopped",
        legacyRetiredAt: "2026-08-31T00:00:00.000Z"
      }
      const fixture = yield* makeFixture(() => Effect.never, {
        initialRow: exact,
        existingByPr: exact,
        emptyAccountByPr: completed,
        listContainersByLabel: () =>
          Effect.fail(new DockerError({ operation: "listContainersByLabel", cause: "daemon unavailable" }))
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(createParams)),
          Effect.provide(fixture.layer)
        )
      )

      expect(result.id).toBe(exact.id)
      expect(yield* Ref.get(fixture.containerDiscoveryCalls)).toBe(0)
      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(0)
      expect(yield* Ref.get(fixture.rowRef)).toEqual(exact)
    }))

  it.effect("retries a marked legacy retirement while it is still stopping", () =>
    Effect.gen(function*() {
      const exact: SandboxRow = { ...legacyRow, region: createParams.region, status: "running" }
      const stopping: SandboxRow = {
        ...legacyRow,
        id: "stopping-legacy",
        awsAccountId: "",
        region: createParams.region,
        accessPassword: "protected",
        status: "stopping",
        legacyRetiredAt: "2026-08-31T00:00:00.000Z"
      }
      const fixture = yield* makeFixture(() => Effect.never, {
        initialRow: exact,
        existingByPr: exact,
        emptyAccountByPr: stopping,
        inspectContainer: () =>
          Effect.succeed({
            Id: "legacy-container",
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          })
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(createParams)),
          Effect.provide(fixture.layer)
        )
      )

      expect(result.id).toBe(exact.id)
      expect(yield* Ref.get(fixture.containerDiscoveryCalls)).toBe(1)
      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(1)
    }))

  it.effect("retries a pending profile retirement during account fallback", () =>
    Effect.gen(function*() {
      const pending: SandboxRow = {
        ...legacyRow,
        awsAccountId: createParams.profile,
        region: createParams.region,
        accessPassword: "protected",
        status: "stopping",
        legacyRetiredAt: "2026-08-31T00:00:00.000Z"
      }
      const params = { ...createParams, awsAccountId: createParams.profile }
      const fixture = yield* makeFixture(() => Effect.never, {
        profileByPr: pending,
        inspectContainer: () =>
          Effect.succeed({
            Id: "legacy-container",
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          })
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(params)),
          Effect.provide(fixture.layer)
        )
      )

      expect(result.id).not.toBe(pending.id)
      expect(result.awsAccountId).toBe(params.awsAccountId)
      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(1)
      expect(yield* Ref.get(fixture.insertCalls)).toBe(1)
    }))

  it.effect("skips a completed regionless retirement during creation", () =>
    Effect.gen(function*() {
      const completed: SandboxRow = {
        ...legacyRow,
        status: "stopped",
        accessPassword: "protected",
        legacyRetiredAt: "2026-08-31T00:00:00.000Z"
      }
      const fixture = yield* makeFixture(() => Effect.never, {
        regionlessByPr: completed,
        listContainersByLabel: () =>
          Effect.fail(new DockerError({ operation: "listContainersByLabel", cause: "daemon unavailable" }))
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(createParams)),
          Effect.provide(fixture.layer)
        )
      )

      expect(result.awsAccountId).toBe(createParams.awsAccountId)
      expect(yield* Ref.get(fixture.containerDiscoveryCalls)).toBe(0)
      expect(yield* Ref.get(fixture.insertCalls)).toBe(1)
    }))

  it.effect("skips a completed regionless retirement during reconciliation", () =>
    Effect.gen(function*() {
      const completed: SandboxRow = {
        ...legacyRow,
        status: "stopped",
        accessPassword: "protected",
        legacyRetiredAt: "2026-08-31T00:00:00.000Z"
      }
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: completed,
        listContainersByLabel: () =>
          Effect.fail(new DockerError({ operation: "listContainersByLabel", cause: "daemon unavailable" }))
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.reconcile()),
          Effect.provide(fixture.layer)
        )
      )

      expect(result).toBe(true)
      expect(yield* Ref.get(fixture.containerDiscoveryCalls)).toBe(0)
      expect(yield* Ref.get(fixture.rowRef)).toEqual(completed)
    }))

  it.effect("keeps retirement pending when an explicit stop fails", () =>
    Effect.gen(function*() {
      const pending: SandboxRow = {
        ...legacyRow,
        region: createParams.region,
        accessPassword: "protected",
        status: "stopping",
        legacyRetiredAt: "2026-08-31T00:00:00.000Z"
      }
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: pending,
        stopContainer: Effect.fail(new DockerError({ operation: "stopContainer", cause: "daemon unavailable" }))
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.stop(SandboxId.make(pending.id))),
          Effect.result,
          Effect.provide(fixture.layer)
        )
      )

      expect(result._tag).toBe("Failure")
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: "stopping",
        legacyRetiredAt: pending.legacyRetiredAt
      })
    }))

  it.effect("completes a marked retirement when the container is missing", () =>
    Effect.gen(function*() {
      const pending: SandboxRow = {
        ...legacyRow,
        region: createParams.region,
        accessPassword: "protected",
        status: "stopping",
        legacyRetiredAt: "2026-08-31T00:00:00.000Z"
      }
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: pending,
        stopContainer: Effect.fail(
          new DockerError({ operation: "stopContainer", cause: "Error: No such container: legacy-container" })
        )
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.stop(SandboxId.make(pending.id))),
          Effect.provide(fixture.layer)
        )
      )

      expect(result).toBeUndefined()
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: "stopped",
        legacyRetiredAt: pending.legacyRetiredAt
      })
    }))

  it.effect("completes a marked retirement when the container is already stopped", () =>
    Effect.gen(function*() {
      const pending: SandboxRow = {
        ...legacyRow,
        region: createParams.region,
        accessPassword: "protected",
        status: "stopping",
        legacyRetiredAt: "2026-08-31T00:00:00.000Z"
      }
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: pending,
        stopContainer: Effect.fail(
          new DockerError({ operation: "stopContainer", cause: "container is already stopped" })
        )
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.stop(SandboxId.make(pending.id))),
          Effect.provide(fixture.layer)
        )
      )

      expect(result).toBeUndefined()
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: "stopped",
        legacyRetiredAt: pending.legacyRetiredAt
      })
    }))

  it.effect("converges concurrent creates on one account-keyed row", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.never)

      const results = yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          return yield* Effect.all(
            [sandboxes.create(createParams), sandboxes.create(createParams)],
            { concurrency: 2 }
          )
        }).pipe(Effect.provide(fixture.layer))
      )

      expect(results[0]?.id).toBe(results[1]?.id)
      expect(yield* Ref.get(fixture.insertCalls)).toBe(1)
    }))

  it.effect("does not reuse or relabel a regionless legacy sandbox", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.never, { regionlessByPr: legacyRow })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(createParams)),
          Effect.result,
          Effect.provide(fixture.layer)
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("Regionless legacy sandbox")
      }
      expect(yield* Ref.get(fixture.regionUpdates)).toEqual([])
      expect(yield* Ref.get(fixture.insertCalls)).toBe(0)
    }))

  it.effect("retires an authenticated running regionless sandbox before exact creation", () =>
    Effect.gen(function*() {
      const regionless = { ...legacyRow, accessPassword: "protected" }
      const fixture = yield* makeFixture(() => Effect.never, {
        regionlessByPr: regionless,
        inspectContainer: () =>
          Effect.succeed({
            Id: "legacy-container",
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          })
      })

      yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(createParams)),
          Effect.provide(fixture.layer)
        )
      )

      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(1)
      expect(yield* Ref.get(fixture.insertCalls)).toBe(1)
    }))

  it.effect("does not replace a regionless worker that is still starting", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.never, {
        regionlessByPrAll: [{
          ...legacyRow,
          accessPassword: "protected",
          containerId: null,
          status: "cloning"
        }]
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(createParams)),
          Effect.result,
          Effect.provide(fixture.layer)
        )
      )

      expect(result._tag).toBe("Failure")
      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(0)
      expect(yield* Ref.get(fixture.insertCalls)).toBe(0)
    }))

  it.effect("reconciles an authenticated sandbox with an empty migrated region", () =>
    Effect.gen(function*() {
      const regionless = { ...legacyRow, region: "", accessPassword: "protected" }
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: regionless,
        inspectContainer: () =>
          Effect.succeed({
            Id: "legacy-container",
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          })
      })

      yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.reconcile()),
          Effect.provide(fixture.layer)
        )
      )

      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(1)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({ status: "stopped", region: "" })
    }))

  it.effect("retires every regionless row, including terminal rows, before exact creation", () =>
    Effect.gen(function*() {
      const terminal = { ...legacyRow, id: "legacy-terminal", status: "stopped", containerId: "terminal-container" }
      const fixture = yield* makeFixture(() => Effect.never, {
        regionlessByPrAll: [{ ...legacyRow, accessPassword: "protected" }, {
          ...terminal,
          accessPassword: "protected"
        }],
        inspectContainer: () =>
          Effect.succeed({
            Id: "container",
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          })
      })

      yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(createParams)),
          Effect.provide(fixture.layer)
        )
      )

      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(2)
      expect(yield* Ref.get(fixture.insertCalls)).toBe(1)
    }))

  it.effect("retires regionless rows before reusing an exact sandbox", () =>
    Effect.gen(function*() {
      const exact = { ...legacyRow, id: "exact-sandbox", region: createParams.region, accessPassword: "protected" }
      const regionless = { ...legacyRow, accessPassword: "protected" }
      const fixture = yield* makeFixture(() => Effect.never, {
        existingByPr: exact,
        regionlessByPrAll: [regionless],
        inspectContainer: () =>
          Effect.succeed({
            Id: "legacy-container",
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          })
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(createParams)),
          Effect.provide(fixture.layer)
        )
      )

      expect(result.id).toBe("exact-sandbox")
      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(1)
      expect(yield* Ref.get(fixture.insertCalls)).toBe(0)
    }))

  it.effect("creates a replacement after exact-region worker loss", () =>
    Effect.gen(function*() {
      const statuses: ReadonlyArray<"creating" | "cloning" | "starting"> = ["creating", "cloning", "starting"]
      for (const status of statuses) {
        const fixture = yield* makeFixture(() => Effect.void, {
          initialRow: {
            ...legacyRow,
            region: createParams.region,
            accessPassword: "protected",
            containerId: null,
            status
          }
        })
        yield* Effect.scoped(
          SandboxService.pipe(
            Effect.flatMap((sandboxes) => sandboxes.reconcile()),
            Effect.provide(fixture.layer)
          )
        )
        expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
          status: "error",
          error: "Orphaned (no container)"
        })
      }
    }))

  it.effect("preserves a pre-container row while its worker is active", () =>
    Effect.gen(function*() {
      const workerGate = yield* Deferred.make<void>()
      const fixture = yield* makeFixture(() => Deferred.await(workerGate))

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          yield* sandboxes.create(createParams)
          yield* sandboxes.reconcile()
        }).pipe(Effect.provide(fixture.layer))
      )

      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: expect.any(String),
        containerId: null,
        error: null
      })
    }))

  it.effect("marks exact-region pre-container rows orphaned after worker loss", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.never, {
        initialRow: {
          ...legacyRow,
          region: createParams.region,
          accessPassword: "protected",
          containerId: null,
          status: "cloning"
        }
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(createParams)),
          Effect.provide(fixture.layer),
          Effect.result
        )
      )

      expect(result._tag).toBe("Success")
      expect(yield* Ref.get(fixture.insertCalls)).toBe(1)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({ status: "creating", containerId: null })
    }))

  it.effect("marks exact-region pre-container rows orphaned during reconciliation after worker loss", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: {
          ...legacyRow,
          region: createParams.region,
          accessPassword: "protected",
          containerId: null,
          status: "starting"
        }
      })

      const outcome = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.reconcile()),
          Effect.provide(fixture.layer)
        )
      )

      expect(outcome).toBe(true)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: "error",
        error: "Orphaned (no container)"
      })
    }))

  it.effect("reserves a new worker before reconciliation can inspect its inserted row", () =>
    Effect.gen(function*() {
      const inserted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fixture = yield* makeFixture(() => Effect.never, {
        insertGate: { inserted, release }
      })

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          const createFiber = yield* sandboxes.create(createParams).pipe(Effect.forkChild)
          yield* Deferred.await(inserted)
          yield* sandboxes.reconcile()
          expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
            status: "creating",
            containerId: null,
            error: null
          })
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(createFiber)
        }).pipe(Effect.provide(fixture.layer))
      )
    }))

  it.effect("releases the worker reservation when creation is interrupted after insertion", () =>
    Effect.gen(function*() {
      const inserted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fixture = yield* makeFixture(() => Effect.never, {
        insertGate: { inserted, release }
      })

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          const createFiber = yield* sandboxes.create(createParams).pipe(Effect.forkChild)
          yield* Deferred.await(inserted)
          yield* Fiber.interrupt(createFiber)
          yield* sandboxes.reconcile()
          expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
            status: "error",
            error: "Orphaned (no container)"
          })
        }).pipe(Effect.provide(fixture.layer))
      )
    }))

  it.effect("keeps the reservation when interruption arrives after worker fork", () =>
    Effect.gen(function*() {
      const forked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fixture = yield* makeFixture(() => Effect.never, {
        forkGate: { forked, release }
      })

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          const createFiber = yield* sandboxes.create(createParams).pipe(Effect.forkChild)
          yield* Deferred.await(forked)
          const interruptFiber = yield* Fiber.interrupt(createFiber).pipe(
            Effect.forkChild({ startImmediately: true })
          )
          yield* sandboxes.reconcile()
          expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
            status: "creating",
            containerId: null,
            error: null
          })
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(interruptFiber)
        }).pipe(Effect.provide(fixture.layer))
      )
    }))

  it.effect("releases the reservation when the owner scope is already closed", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.void, { closedFork: true })

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          const result = yield* sandboxes.create(createParams).pipe(Effect.result)
          expect(result._tag).toBe("Success")
          yield* sandboxes.reconcile()
          expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
            status: "error",
            error: "Orphaned (no container)"
          })
        }).pipe(Effect.provide(fixture.layer))
      )
    }))

  it.effect("blocks legacy retirement while a sandbox restart is active", () =>
    Effect.gen(function*() {
      const restartStarted = yield* Deferred.make<void>()
      const restartRelease = yield* Deferred.make<void>()
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: {
          ...legacyRow,
          awsAccountId: "",
          region: createParams.region,
          accessPassword: "protected"
        },
        restartGate: { started: restartStarted, release: restartRelease }
      })

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          const restartFiber = yield* sandboxes.restart(SandboxId.make(legacyRow.id)).pipe(Effect.forkChild())
          yield* Deferred.await(restartStarted)

          const creation = yield* sandboxes.create(createParams).pipe(Effect.result)
          expect(creation._tag).toBe("Failure")
          expect(yield* Ref.get(fixture.rowRef)).toMatchObject({ status: "starting" })

          yield* Deferred.succeed(restartRelease, undefined)
          yield* Fiber.join(restartFiber)
          expect(yield* Ref.get(fixture.rowRef)).toMatchObject({ status: "running" })
        }).pipe(Effect.provide(fixture.layer))
      )
    }))

  it.effect("does not restart a legacy row after retirement wins admission", () =>
    Effect.gen(function*() {
      const retirementReached = yield* Deferred.make<void>()
      const retirementRelease = yield* Deferred.make<void>()
      const restartStarted = yield* Deferred.make<void>()
      const restartRelease = yield* Deferred.make<void>()
      const retired = { ...legacyRow, awsAccountId: "", region: createParams.region, accessPassword: "protected" }
      const fixture = yield* makeFixture(() => Effect.void, {
        emptyAccountByPrAll: [retired],
        rowsById: { [retired.id]: retired },
        retirementGate: { reached: retirementReached, release: retirementRelease },
        restartGate: { started: restartStarted, release: restartRelease },
        inspectContainer: () =>
          Effect.succeed({
            Id: retired.containerId ?? "legacy-container",
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          })
      })

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          const creation = yield* sandboxes.create(createParams).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(retirementReached)

          const restart = yield* sandboxes.restart(SandboxId.make(retired.id)).pipe(Effect.result, Effect.forkChild)
          const reachedStart = yield* Deferred.isDone(restartStarted)
          expect(reachedStart).toBe(false)

          yield* Deferred.succeed(retirementRelease, undefined)
          yield* Fiber.join(creation)
          const restartResult = yield* Fiber.join(restart)
          expect(restartResult._tag).toBe("Failure")
          expect(yield* Ref.get(fixture.insertCalls)).toBe(1)
        }).pipe(Effect.provide(fixture.layer))
      )
    }))

  it.effect("serializes regionless reconciliation with restart", () =>
    Effect.gen(function*() {
      const retirementReached = yield* Deferred.make<void>()
      const retirementRelease = yield* Deferred.make<void>()
      const restartStarted = yield* Deferred.make<void>()
      const restartRelease = yield* Deferred.make<void>()
      const regionless = { ...legacyRow, region: "", accessPassword: "protected" }
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: regionless,
        retirementGate: { reached: retirementReached, release: retirementRelease },
        restartGate: { started: restartStarted, release: restartRelease },
        inspectContainer: () =>
          Effect.succeed({
            Id: regionless.containerId ?? "legacy-container",
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          })
      })

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          const reconciliation = yield* sandboxes.reconcile().pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(retirementReached)

          const restart = yield* sandboxes.restart(SandboxId.make(regionless.id)).pipe(Effect.result, Effect.forkChild)
          expect(yield* Deferred.isDone(restartStarted)).toBe(false)

          yield* Deferred.succeed(retirementRelease, undefined)
          expect(yield* Fiber.join(reconciliation)).toBe(true)
          expect((yield* Fiber.join(restart))._tag).toBe("Failure")
        }).pipe(Effect.provide(fixture.layer))
      )
    }))

  it.effect("skips regionless reconciliation while restart owns the worker", () =>
    Effect.gen(function*() {
      const restartStarted = yield* Deferred.make<void>()
      const restartRelease = yield* Deferred.make<void>()
      const regionless = { ...legacyRow, region: "", accessPassword: "protected" }
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: regionless,
        restartGate: { started: restartStarted, release: restartRelease },
        inspectContainer: () =>
          Effect.succeed({
            Id: regionless.containerId ?? "legacy-container",
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          })
      })

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          const restart = yield* sandboxes.restart(SandboxId.make(regionless.id)).pipe(Effect.forkChild)
          yield* Deferred.await(restartStarted)

          expect(yield* sandboxes.reconcile()).toBe(true)
          expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(0)
          expect(yield* Ref.get(fixture.rowRef)).toMatchObject({ status: "starting", legacyRetiredAt: null })

          yield* Deferred.succeed(restartRelease, undefined)
          yield* Fiber.join(restart)
        }).pipe(Effect.provide(fixture.layer))
      )
    }))

  it.effect("blocks regionless creation while restart owns the worker", () =>
    Effect.gen(function*() {
      const restartStarted = yield* Deferred.make<void>()
      const restartRelease = yield* Deferred.make<void>()
      const regionless = { ...legacyRow, region: "", accessPassword: "protected" }
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: regionless,
        regionlessByPrAll: [regionless],
        restartGate: { started: restartStarted, release: restartRelease },
        inspectContainer: () =>
          Effect.succeed({
            Id: regionless.containerId ?? "legacy-container",
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          })
      })

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          const restart = yield* sandboxes.restart(SandboxId.make(regionless.id)).pipe(Effect.forkChild)
          yield* Deferred.await(restartStarted)

          const creation = yield* sandboxes.create(createParams).pipe(Effect.result)
          expect(creation._tag).toBe("Failure")
          expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(0)
          expect(yield* Ref.get(fixture.insertCalls)).toBe(0)

          yield* Deferred.succeed(restartRelease, undefined)
          yield* Fiber.join(restart)
        }).pipe(Effect.provide(fixture.layer))
      )
    }))

  it.effect("does not restart a durably retired legacy row after service recreation", () =>
    Effect.gen(function*() {
      const restartStarted = yield* Deferred.make<void>()
      const restartRelease = yield* Deferred.make<void>()
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: {
          ...legacyRow,
          region: createParams.region,
          accessPassword: "protected",
          legacyRetiredAt: "2026-08-31T00:00:00.000Z"
        },
        restartGate: { started: restartStarted, release: restartRelease }
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.restart(SandboxId.make(legacyRow.id)).pipe(Effect.result)),
          Effect.provide(fixture.layer)
        )
      )

      expect(result._tag).toBe("Failure")
      expect(yield* Deferred.isDone(restartStarted)).toBe(false)
    }))

  it.effect("retires a profile-keyed legacy row before account-keyed creation", () =>
    Effect.gen(function*() {
      const profileRow = {
        ...legacyRow,
        awsAccountId: createParams.profile,
        region: createParams.region,
        accessPassword: "protected"
      }
      const fixture = yield* makeFixture(() => Effect.never, {
        profileByPr: profileRow,
        inspectContainer: () =>
          Effect.succeed({
            Id: "legacy-container",
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          })
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(createParams)),
          Effect.provide(fixture.layer)
        )
      )

      expect(result.id).not.toBe(profileRow.id)
      expect(yield* Ref.get(fixture.insertCalls)).toBe(1)
      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(1)
    }))

  it.effect("preserves an account row when the configured profile name is numeric", () =>
    Effect.gen(function*() {
      const numericProfile = "111122223333"
      const profileRow = {
        ...legacyRow,
        awsAccountId: numericProfile,
        region: createParams.region,
        accessPassword: "protected"
      }
      const params = { ...createParams, awsAccountId: "999988887777", profile: numericProfile }
      const fixture = yield* makeFixture(() => Effect.never, {
        profileByPr: profileRow,
        profileKey: numericProfile,
        inspectContainer: () =>
          Effect.succeed({
            Id: "legacy-container",
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          })
      })

      const result = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.create(params)),
          Effect.provide(fixture.layer)
        )
      )

      expect(result.awsAccountId).toBe(params.awsAccountId)
      expect(yield* Ref.get(fixture.insertCalls)).toBe(1)
      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(0)
    }))

  it.effect("does not retire an empty-account worker after its container is persisted", () =>
    Effect.gen(function*() {
      const reached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fixture = yield* makeFixture(() => Effect.void, {
        readyGate: { reached, release },
        inspectContainer: () =>
          Effect.succeed({
            Id: "worker-container",
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          })
      })

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          yield* sandboxes.create({ ...createParams, awsAccountId: "" })
          yield* Deferred.await(reached)

          const result = yield* sandboxes.create({ ...createParams, awsAccountId: "profile-account" }).pipe(
            Effect.result
          )
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure.message).toContain("Legacy sandbox is still active")
          }
          expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(0)
          expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
            status: "starting",
            containerId: "worker-container"
          })

          yield* Deferred.succeed(release, undefined)
        }).pipe(Effect.provide(fixture.layer))
      )
    }))

  it.effect("retires an unattributed empty-account sandbox before creating a profile sandbox", () =>
    Effect.gen(function*() {
      const profileParams = { ...createParams, awsAccountId: "profile-account" }
      const fixture = yield* makeFixture(() => Effect.never, {
        emptyAccountByPr: {
          ...legacyRow,
          awsAccountId: "",
          region: createParams.region,
          accessPassword: "protected"
        },
        emptyAccountByPrAll: [{
          ...legacyRow,
          id: "legacy-sandbox-two",
          awsAccountId: "",
          region: createParams.region,
          containerId: "legacy-container-two",
          accessPassword: "protected"
        }, {
          ...legacyRow,
          id: "legacy-sandbox-error",
          awsAccountId: "",
          region: createParams.region,
          containerId: "legacy-container-error",
          accessPassword: "protected",
          status: "error"
        }, {
          ...legacyRow,
          id: "legacy-other-region",
          awsAccountId: "",
          region: "eu-west-1",
          containerId: "legacy-container-other-region",
          accessPassword: "protected"
        }],
        inspectContainer: (containerId) =>
          Effect.succeed({
            Id: containerId,
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          })
      })

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          const sandbox = yield* sandboxes.create(profileParams)
          expect(sandbox.awsAccountId).toBe(profileParams.awsAccountId)
          expect(yield* Ref.get(fixture.insertCalls)).toBe(1)
          expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(3)
          expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
            awsAccountId: "profile-account",
            status: "creating"
          })
        }).pipe(Effect.provide(fixture.layer))
      )
    }))

  it.effect("marks a regionless pre-container row orphaned after worker loss", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: {
          ...legacyRow,
          accessPassword: "protected",
          containerId: null,
          status: "cloning"
        }
      })

      const outcome = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.reconcile()),
          Effect.provide(fixture.layer)
        )
      )

      expect(outcome).toBe(true)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: "error",
        error: "Orphaned (no container)"
      })
    }))

  it.effect("requires Docker admission for a terminal regionless row", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: { ...legacyRow, accessPassword: "protected", containerId: null, status: "error" }
      })

      const outcome = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.reconcile()),
          Effect.provide(fixture.layer)
        )
      )

      expect(outcome).toBe(true)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({ status: "stopped", region: "" })
    }))

  it.effect("marks an authenticated row stopped only for a confirmed missing container", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: { ...legacyRow, accessPassword: "protected" },
        inspectContainer: () =>
          Effect.fail(
            new DockerError({
              operation: "inspectContainer",
              cause: "Error: No such object: missing-container"
            })
          )
      })
      const outcome = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.reconcile()),
          Effect.provide(fixture.layer)
        )
      )
      expect(outcome).toBe(true)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({ status: "stopped" })
    }))

  it.effect("treats a confirmed missing stop target as already reconciled", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: legacyRow,
        stopContainer: Effect.fail(
          new DockerError({
            operation: "stopContainer",
            cause: "Error response from daemon: No such container: missing-container"
          })
        )
      })
      const outcome = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.reconcile()),
          Effect.provide(fixture.layer)
        )
      )
      expect(outcome).toBe(true)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: "error",
        error: "Legacy unauthenticated sandbox stopped; delete and recreate it"
      })
    }))

  it.effect("treats an already-stopped legacy container as retired", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: legacyRow,
        stopContainer: Effect.fail(
          new DockerError({
            operation: "stopContainer",
            cause: "Error response from daemon: cannot stop container: legacy-container: container is not running"
          })
        )
      })
      const outcome = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.reconcile()),
          Effect.provide(fixture.layer)
        )
      )
      expect(outcome).toBe(true)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: "error",
        error: "Legacy unauthenticated sandbox stopped; delete and recreate it"
      })
    }))

  it.effect("treats the current already-stopped Docker wording as retired", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: legacyRow,
        stopContainer: Effect.fail(
          new DockerError({
            operation: "stopContainer",
            cause: "Error response from daemon: container is already stopped"
          })
        )
      })
      const outcome = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.reconcile()),
          Effect.provide(fixture.layer)
        )
      )
      expect(outcome).toBe(true)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: "error",
        error: "Legacy unauthenticated sandbox stopped; delete and recreate it"
      })
    }))

  it.effect("retains authenticated rows when container inspection fails for infrastructure", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: { ...legacyRow, accessPassword: "protected" },
        inspectContainer: () =>
          Effect.fail(new DockerError({ operation: "inspectContainer", cause: "Docker daemon unavailable" }))
      })
      const outcome = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.reconcile()),
          Effect.provide(fixture.layer)
        )
      )
      expect(outcome).toBe(false)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: "stopping",
        error: null,
        legacyRetiredAt: expect.any(String)
      })
    }))

  it.effect("treats an authenticated container exiting after inspection as stopped", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: { ...legacyRow, accessPassword: "protected" },
        inspectContainer: () =>
          Effect.succeed({
            Id: legacyRow.containerId ?? "legacy-container",
            State: { Status: "running", Running: true },
            NetworkSettings: { Ports: {} }
          }),
        stopContainer: Effect.fail(
          new DockerError({
            operation: "stopContainer",
            cause: "Error response from daemon: cannot stop container: legacy-container: container is not running"
          })
        )
      })
      const outcome = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.reconcile()),
          Effect.provide(fixture.layer)
        )
      )
      expect(outcome).toBe(true)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({ status: "stopped", error: null })
    }))

  it.effect("records a production sandbox worker defect as an error", () =>
    Effect.gen(function*() {
      const defect = new Error("sandbox worker defect")
      const fixture = yield* makeFixture(() => Effect.die(defect))

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          yield* sandboxes.create(createParams)
          yield* Deferred.await(fixture.errorTransitioned)
        }).pipe(Effect.provide(fixture.layer))
      )

      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: "error",
        error: "sandbox worker defect"
      })
    }))

  it.effect("preserves an unprintable worker defect and records a safe fallback error", () =>
    Effect.gen(function*() {
      const defect = {
        toString(): string {
          throw new Error("formatter defect")
        }
      }
      const fixture = yield* makeFixture(() => Effect.die(defect))

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          yield* sandboxes.create(createParams)
          yield* Deferred.await(fixture.errorTransitioned)
          const cause = yield* Deferred.await(fixture.workerCause)
          const [reason] = cause.reasons
          expect(reason && Cause.isDieReason(reason)).toBe(true)
          if (reason !== undefined && Cause.isDieReason(reason)) {
            expect(reason.defect).toBe(defect)
          }
        }).pipe(Effect.provide(fixture.layer))
      )

      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: "error",
        error: "Unknown error"
      })
    }))

  it.effect("preserves a worker defect with a Symbol message and records its string representation", () =>
    Effect.gen(function*() {
      const defect = new Error("original message")
      Object.defineProperty(defect, "message", { value: Symbol("hostile message") })
      const fixture = yield* makeFixture(() => Effect.die(defect))

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          yield* sandboxes.create(createParams)
          yield* Deferred.await(fixture.errorTransitioned)
          const cause = yield* Deferred.await(fixture.workerCause)
          const [reason] = cause.reasons
          expect(reason && Cause.isDieReason(reason)).toBe(true)
          if (reason !== undefined && Cause.isDieReason(reason)) {
            expect(reason.defect).toBe(defect)
          }
        }).pipe(Effect.provide(fixture.layer))
      )

      const row = yield* Ref.get(fixture.rowRef)
      expect(row).toMatchObject({
        status: "error",
        error: "Symbol(hostile message)"
      })
      expect(Predicate.isString(row?.error)).toBe(true)
    }))

  it.effect("interrupts the production sandbox worker when its service layer closes", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const finalized = yield* Deferred.make<void>()
      const fixture = yield* makeFixture(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(finalized, undefined))
        )
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          yield* sandboxes.create(createParams)
          yield* Deferred.await(started)
        }).pipe(Effect.provide(fixture.layer))
      )

      yield* Deferred.await(finalized)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: "cloning",
        error: null
      })
    }))

  it.effect("keeps a legacy sandbox retryable until its container shutdown succeeds", () =>
    Effect.gen(function*() {
      const stopFailure = new DockerError({ operation: "stopContainer", cause: "daemon unavailable" })
      const fixture = yield* makeFixture(
        () => Effect.void,
        { initialRow: legacyRow, stopContainer: Effect.fail(stopFailure) }
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          yield* sandboxes.reconcile()
          yield* sandboxes.reconcile()
        }).pipe(Effect.provide(fixture.layer))
      )

      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(2)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({ status: "running", error: null })
    }))

  it.effect("marks a legacy sandbox terminal only after confirmed container shutdown", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(
        () => Effect.void,
        { initialRow: legacyRow, stopContainer: Effect.void }
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          yield* sandboxes.reconcile()
        }).pipe(Effect.provide(fixture.layer))
      )

      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(1)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: "error",
        error: "Legacy unauthenticated sandbox stopped; delete and recreate it"
      })
    }))

  it.effect("discovers an untracked legacy container and retries until shutdown succeeds", () =>
    Effect.gen(function*() {
      const stopFailure = new DockerError({ operation: "stopContainer", cause: "daemon unavailable" })
      const fixture = yield* makeFixture(
        () => Effect.void,
        {
          initialRow: { ...legacyRow, containerId: null, status: "starting" },
          stopContainerByAttempt: (attempt) => attempt === 0 ? Effect.fail(stopFailure) : Effect.void,
          untrackedContainers: [{
            Id: "untracked-legacy-container",
            State: "running",
            Labels: { "codecommit.sandbox.id": legacyRow.id }
          }]
        }
      )

      const outcomes = yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          return [yield* sandboxes.reconcile(), yield* sandboxes.reconcile()]
        }).pipe(Effect.provide(fixture.layer))
      )

      expect(outcomes).toEqual([false, true])
      expect(yield* Ref.get(fixture.containerDiscoveryCalls)).toBe(2)
      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(2)
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({
        status: "error",
        error: "Legacy unauthenticated sandbox stopped; delete and recreate it"
      })
    }))

  it.effect("discovers and stops a labeled container for a terminal legacy row", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(
        () => Effect.void,
        {
          initialRow: { ...legacyRow, containerId: null, status: "error" },
          untrackedContainers: [{
            Id: "terminal-legacy-container",
            State: "running",
            Labels: { "codecommit.sandbox.id": legacyRow.id }
          }]
        }
      )

      yield* Effect.scoped(
        Effect.gen(function*() {
          const sandboxes = yield* SandboxService
          expect(yield* sandboxes.hasLegacyUnauthenticated()).toBe(true)
          expect(yield* sandboxes.reconcile()).toBe(true)
        }).pipe(Effect.provide(fixture.layer))
      )

      expect(yield* Ref.get(fixture.containerDiscoveryCalls)).toBe(1)
      expect(yield* Ref.get(fixture.stopContainerCalls)).toBe(1)
    }))

  it.effect("does not require Docker admission for a terminal exact-region row", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture(
        () => Effect.void,
        { initialRow: { ...legacyRow, region: createParams.region, accessPassword: "protected", status: "error" } }
      )

      const hasLegacy = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.hasLegacyUnauthenticated()),
          Effect.provide(fixture.layer)
        )
      )

      expect(hasLegacy).toBe(false)
      expect(yield* Ref.get(fixture.containerDiscoveryCalls)).toBe(0)
    }))

  it.effect("does not require Docker admission for a completed regionless retirement", () =>
    Effect.gen(function*() {
      const completed: SandboxRow = {
        ...legacyRow,
        accessPassword: "protected",
        status: "stopped",
        legacyRetiredAt: "2026-08-31T00:00:00.000Z"
      }
      const fixture = yield* makeFixture(() => Effect.void, {
        initialRow: completed,
        listContainersByLabel: () =>
          Effect.fail(new DockerError({ operation: "listContainersByLabel", cause: "daemon unavailable" }))
      })

      const hasLegacy = yield* Effect.scoped(
        SandboxService.pipe(
          Effect.flatMap((sandboxes) => sandboxes.hasLegacyUnauthenticated()),
          Effect.provide(fixture.layer)
        )
      )

      expect(hasLegacy).toBe(false)
      expect(yield* Ref.get(fixture.containerDiscoveryCalls)).toBe(0)
    }))
})
