import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { Cause, ConfigProvider, Crypto, Deferred, Effect, Exit, Layer, Option, Ref } from "effect"
import * as FileSystem from "effect/FileSystem"
import { ChildProcessSpawner } from "effect/unstable/process"
import { SandboxRepo, type SandboxRow } from "../src/CacheService/repos/SandboxRepo.js"
import { ConfigService, defaultSandboxConfig } from "../src/ConfigService/index.js"
import { DockerService } from "../src/SandboxService/DockerService.js"
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

const makeFixture = Effect.fn("SandboxWorkerScopeTest.makeFixture")(function*(
  makeDirectory: FileSystem.FileSystem["makeDirectory"]
) {
  const rowRef = yield* Ref.make<SandboxRow | undefined>(undefined)
  const errorTransitioned = yield* Deferred.make<void>()
  const workerCause = yield* Deferred.make<Cause.Cause<unknown>>()

  const repositoryLayer = Layer.mock(SandboxRepo, {
    findByPr: () => Effect.succeed(Option.none<SandboxRow>()),
    insert: (input) =>
      Ref.set(rowRef, {
        ...input,
        containerId: null,
        port: null,
        statusDetail: null,
        logs: null,
        error: null
      }),
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
      Ref.update(rowRef, (row) => row === undefined ? row : { ...row, logs: `${row.logs ?? ""}${line}\n` })
  })

  const dependencies = Layer.mergeAll(
    repositoryLayer,
    Layer.mock(DockerService, {}),
    Layer.mock(PluginService, {}),
    Layer.mock(ConfigService, { load: Effect.succeed(config) }),
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
    errorTransitioned,
    layer: SandboxService.layer.pipe(Layer.provideMerge(dependencies)),
    rowRef,
    workerCause
  }
})

describe("SandboxWorkerScope", () => {
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
          if (reason && Cause.isDieReason(reason)) {
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
          if (reason && Cause.isDieReason(reason)) {
            expect(reason.defect).toBe(defect)
          }
        }).pipe(Effect.provide(fixture.layer))
      )

      const row = yield* Ref.get(fixture.rowRef)
      expect(row).toMatchObject({
        status: "error",
        error: "Symbol(hostile message)"
      })
      expect(typeof row?.error).toBe("string")
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
})
