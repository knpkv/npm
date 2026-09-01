/** @effect-diagnostics strictEffectProvide:skip-file */

import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { Cause, ConfigProvider, Crypto, Deferred, Effect, Exit, Fiber, Layer, Option, Predicate, Ref } from "effect"
import * as FileSystem from "effect/FileSystem"
import { ChildProcessSpawner } from "effect/unstable/process"
import { SandboxRepo, type SandboxRow } from "../src/CacheService/repos/SandboxRepo.js"
import * as ChildEnv from "../src/ChildEnv.js"
import { ConfigService, defaultSandboxConfig } from "../src/ConfigService/index.js"
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
  createdAt: "2026-08-10T00:00:00.000Z",
  lastActivityAt: "2026-08-10T00:00:00.000Z"
}

interface FixtureOptions {
  readonly config?: typeof config
  readonly initialRow?: SandboxRow
  readonly existingByPr?: SandboxRow
  readonly insertGate?: {
    readonly inserted: Deferred.Deferred<void>
    readonly release: Deferred.Deferred<void>
  }
  readonly regionlessByPr?: SandboxRow
  readonly regionlessByPrAll?: ReadonlyArray<SandboxRow>
  readonly stopContainer?: Effect.Effect<void, DockerError>
  readonly stopContainerByAttempt?: (attempt: number) => Effect.Effect<void, DockerError>
  readonly inspectContainer?: (containerId: string) => Effect.Effect<ContainerInfo, DockerError>
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
    findByPr: (_awsAccountId, _pullRequestId, _repositoryName, region) => {
      const row = options?.existingByPr ??
        (options?.initialRow?.region === region ? options.initialRow : undefined)
      return Effect.succeed(row === undefined ? Option.none<SandboxRow>() : Option.some(row))
    },
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
    findAll: () => Ref.get(rowRef).pipe(Effect.map((row) => row === undefined ? [] : [row])),
    insert: (input) =>
      Ref.update(insertCalls, (count) => count + 1).pipe(
        Effect.andThen(
          Ref.set(rowRef, {
            ...input,
            containerId: null,
            port: null,
            statusDetail: null,
            logs: null,
            error: null
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
    findById: () =>
      Ref.get(rowRef).pipe(
        Effect.flatMap((row) =>
          row === undefined
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
            error: extra?.error ?? row.error
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
          Effect.as([...(options?.untrackedContainers ?? [])])
        )
    }),
    Layer.mock(PluginService, {}),
    Layer.mock(ConfigService, { load: Effect.succeed(options?.config ?? config) }),
    Layer.succeed(FileSystem.FileSystem, FileSystem.FileSystem.of({ makeDirectory })),
    NodePath.layer,
    Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {}),
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
          fork: (worker) =>
            Effect.forkIn(
              worker.pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? Deferred.succeed(workerCause, exit.cause)
                    : Effect.void
                )
              ),
              scope
            )
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
      expect(yield* Ref.get(fixture.rowRef)).toMatchObject({ status: "running", error: null })
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
})
