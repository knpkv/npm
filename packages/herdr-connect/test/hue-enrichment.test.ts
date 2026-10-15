import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, FileSystem, Logger, Option, Path, Ref, Scope } from "effect"
import { TestClock } from "effect/testing"
import { existsSync } from "node:fs"
import { AgentActivityStore } from "../src/activity-store.js"
import { makeConnectHueEnrichment } from "../src/hue-enrichment.js"
import { ConnectAgent } from "../src/model.js"

const agent = ConnectAgent.make({
  id: "agent-worker",
  host: "atlas",
  name: "worker",
  kind: "worker",
  state: "working",
  work: "project",
  lastActivityAt: 0
})

const heldOwner = Effect.fn("HueOwnerTest.held")(function*(uninterruptible: boolean) {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const path = paths.join(yield* fs.makeTempDirectoryScoped({ prefix: "connect-hue-owner-" }), "state.sqlite")
  const scope = yield* Effect.acquireRelease(Scope.make(), (owned) => Scope.close(owned, Exit.void))
  const armed = yield* Ref.make(false)
  const securing = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const finished = yield* Deferred.make<void>()
  const delegated = FileSystem.FileSystem.of({
    ...fs,
    chmod: (file, mode) =>
      Effect.gen(function*() {
        yield* fs.chmod(file, mode)
        if (file === path && (yield* Ref.getAndSet(armed, false))) {
          const wait = Effect.gen(function*() {
            yield* Deferred.succeed(securing, undefined)
            yield* Deferred.await(release)
          })
          yield* (uninterruptible ? Effect.uninterruptible(wait) : wait).pipe(
            Effect.ensuring(Deferred.succeed(finished, undefined))
          )
        }
      })
  })
  const messages: Array<unknown> = []
  const connectionOpenAtWarning: Array<boolean> = []
  const logger = Logger.make<unknown, void>((entry) => {
    messages.push(entry.message)
    connectionOpenAtWarning.push(existsSync(`${path}-wal`))
  })
  const owner = yield* makeConnectHueEnrichment(path).pipe(
    Effect.provideService(FileSystem.FileSystem, delegated),
    Effect.provideService(Scope.Scope, scope),
    Effect.withLogger(logger)
  )
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
  yield* Ref.set(armed, true)
  const waiting = yield* Effect.forkScoped(owner.assign("atlas", [agent], 1, true))
  yield* Deferred.await(securing)
  return { fs, path, scope, owner, waiting, release, finished, messages, connectionOpenAtWarning }
})

describe("owned hue enrichment", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("bounds shutdown after two seconds, warns, then closes a held finalizer's connection", () =>
      Effect.gen(function*() {
        const fixture = yield* heldOwner(true)
        expect(yield* fixture.fs.exists(`${fixture.path}-wal`)).toBe(true)
        const closing = yield* Effect.forkScoped(Scope.close(fixture.scope, Exit.void))
        yield* Effect.addFinalizer(() => Deferred.succeed(fixture.release, undefined))
        yield* TestClock.adjust(1_999)
        expect(closing.pollUnsafe()).toBeUndefined()
        expect(yield* fixture.fs.exists(`${fixture.path}-wal`)).toBe(true)
        yield* TestClock.adjust(1)
        expect(closing.pollUnsafe()).toBeDefined()
        yield* Fiber.join(closing)
        expect(fixture.messages).toMatchObject([[{ _tag: "HueFinalizerShutdownTimeout", timeoutMillis: 2_000 }]])
        expect(fixture.connectionOpenAtWarning).toEqual([true])
        expect(yield* fixture.fs.exists(`${fixture.path}-wal`)).toBe(false)
        expect(Option.isNone(yield* fixture.owner.assign("atlas", [agent], 2, true))).toBe(true)
        yield* Deferred.succeed(fixture.release, undefined)
        yield* Deferred.await(fixture.finished)
      }).pipe(Effect.scoped))

    it.effect("joins finalization released within the shutdown bound before closing its connection", () =>
      Effect.gen(function*() {
        const fixture = yield* heldOwner(true)
        const closing = yield* Effect.forkScoped(Scope.close(fixture.scope, Exit.void))
        yield* Effect.addFinalizer(() => Deferred.succeed(fixture.release, undefined))
        yield* TestClock.adjust(1_000)
        expect(closing.pollUnsafe()).toBeUndefined()
        expect(yield* fixture.fs.exists(`${fixture.path}-wal`)).toBe(true)
        yield* Deferred.succeed(fixture.release, undefined)
        yield* Fiber.join(closing)
        expect(yield* fixture.fs.exists(`${fixture.path}-wal`)).toBe(false)
        expect(fixture.messages).toEqual([])
      }).pipe(Effect.scoped))

    it.effect("skips repeated allocations while finalizing without blocking mandatory activity writes", () =>
      Effect.gen(function*() {
        const fixture = yield* heldOwner(false)
        const activity = yield* Effect.acquireRelease(
          AgentActivityStore.open(fixture.path),
          (opened) => Effect.sync(() => opened.close())
        )
        for (const observedAt of [2, 3, 4]) {
          expect(Option.isNone(yield* fixture.owner.assign("atlas", [agent], observedAt, true))).toBe(true)
        }
        expect(yield* activity.observe("atlas", agent.id, 2, 5)).toBe(5)
        expect(yield* Deferred.isDone(fixture.finished)).toBe(false)
        yield* Deferred.succeed(fixture.release, undefined)
        const result = yield* Fiber.join(fixture.waiting)
        expect(Option.isSome(result)).toBe(true)
        const paths = yield* Path.Path
        if (paths.sep === "/") {
          for (const file of [fixture.path, `${fixture.path}-wal`, `${fixture.path}-shm`]) {
            expect((yield* fixture.fs.stat(file)).mode & 0o777).toBe(0o600)
          }
        }
      }).pipe(Effect.scoped))

    it.effect("request cancellation leaves the admitted hue worker owned until shutdown", () =>
      Effect.gen(function*() {
        const fixture = yield* heldOwner(false)
        yield* Fiber.interrupt(fixture.waiting)
        expect(yield* Deferred.isDone(fixture.finished)).toBe(false)
        expect(Option.isNone(yield* fixture.owner.assign("atlas", [agent], 2, true))).toBe(true)
        yield* Scope.close(fixture.scope, Exit.void)
        yield* Deferred.await(fixture.finished)
        expect(yield* fixture.fs.exists(`${fixture.path}-wal`)).toBe(false)
      }).pipe(Effect.scoped))

    it.effect("logs permission failure once, returns fallback and admits a later successful allocation", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const paths = yield* Path.Path
        const path = paths.join(yield* fs.makeTempDirectoryScoped({ prefix: "connect-hue-failure-" }), "state.sqlite")
        const armed = yield* Ref.make(false)
        const delegated = FileSystem.FileSystem.of({
          ...fs,
          chmod: (file, mode) =>
            Effect.gen(function*() {
              const fail = file === path && (yield* Ref.getAndSet(armed, false))
              yield* fs.chmod(fail ? `${file}/missing` : file, mode)
            })
        })
        const messages: Array<unknown> = []
        const logger = Logger.make<unknown, void>((entry) => {
          messages.push(entry.message)
        })
        const owner = yield* makeConnectHueEnrichment(path).pipe(
          Effect.provideService(FileSystem.FileSystem, delegated)
        )
        yield* Ref.set(armed, true)
        const failed = yield* owner.assign("atlas", [agent], 1, true).pipe(Effect.withLogger(logger))
        expect(Option.isNone(failed)).toBe(true)
        expect(messages).toEqual([["ConnectHueAssignmentFailed", { host: "atlas", cause: "TerminalTransportError" }]])
        expect(JSON.stringify(messages)).not.toContain(path)
        expect(Option.isSome(yield* owner.assign("atlas", [agent], 2, true))).toBe(true)
      }).pipe(Effect.scoped))

    it.effect("interrupts cooperative hue finalization before closing, without a timeout warning", () =>
      Effect.gen(function*() {
        const fixture = yield* heldOwner(false)
        yield* Scope.close(fixture.scope, Exit.void)
        yield* Deferred.await(fixture.finished)
        expect(yield* fixture.fs.exists(`${fixture.path}-wal`)).toBe(false)
        expect(fixture.messages).toEqual([])
        expect(Option.isNone(yield* fixture.owner.assign("atlas", [agent], 2, true))).toBe(true)
      }).pipe(Effect.scoped))
  })
})
