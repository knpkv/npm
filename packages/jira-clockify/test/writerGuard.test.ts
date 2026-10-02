import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as TestClock from "effect/testing/TestClock"
import * as WriterGuard from "../src/cli/writerGuard.js"
import { TimerService } from "../src/services/TimerService.js"
import { FAKE_HOME, makeFakeHeadless } from "../src/testing/fakeHeadless.js"

// @effect-diagnostics strictEffectProvide:off

const leasePath = `${FAKE_HOME}/.jcf/watch.lease`
describe("machine writer guard", () => {
  it.effect("blocks a mutation while another process owns the lease", () => {
    const fake = makeFakeHeadless({
      writtenFiles: {
        [leasePath]: JSON.stringify({
          owner: "other-writer",
          heldSinceMs: 1,
          refreshedAtMs: 1,
          intervalSeconds: 300
        })
      }
    })
    let writes = 0
    return WriterGuard.mutate(Effect.sync(() => writes++)).pipe(
      Effect.result,
      Effect.provide(fake.layer),
      Effect.map((result) => {
        expect(result._tag).toBe("Failure")
        expect(writes).toBe(0)
        expect(fake.world.writtenFiles[leasePath]).toBeDefined()
      })
    )
  })

  it.effect("blocks TimerService writes but leaves detection available", () => {
    const fake = makeFakeHeadless({
      writtenFiles: {
        [leasePath]: JSON.stringify({
          owner: "other-writer",
          heldSinceMs: 1,
          refreshedAtMs: 1,
          intervalSeconds: 300
        })
      }
    })
    return Effect.gen(function*() {
      yield* TestClock.setTime(Date.parse("2026-07-01T12:00:00Z"))
      const timer = yield* TimerService
      yield* timer.detectRunning
      const result = yield* timer.logManual({
        key: "PROJ-1",
        summary: "Synthetic task",
        status: "In Progress",
        priority: "Medium",
        assignee: null,
        type: "Task",
        labels: [],
        updated: "2026-07-01T00:00:00Z"
      }, {
        start: new Date("2026-07-01T10:00:00Z"),
        durationSeconds: 3600
      }).pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      expect(fake.world.createdClockifyEntries).toEqual([])
      expect(fake.world.jiraWorklogs).toEqual([])
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("reuses a nested mutation without reacquiring or deadlocking", () => {
    const fake = makeFakeHeadless()
    let writes = 0
    return WriterGuard.withWriterGuard(
      WriterGuard.mutate(
        WriterGuard.mutate(Effect.sync(() => writes++))
      )
    ).pipe(
      Effect.provide(fake.layer),
      Effect.map(() => {
        expect(writes).toBe(1)
        expect(fake.world.writtenFiles[leasePath]).toBeUndefined()
      })
    )
  })

  it.effect("serializes sibling mutations under one live lease", () => {
    const fake = makeFakeHeadless()
    return Effect.gen(function*() {
      const firstEntered = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const secondEntered = yield* Deferred.make<void>()
      yield* WriterGuard.withWriterGuard(Effect.gen(function*() {
        const first = yield* WriterGuard.mutate(
          Deferred.succeed(firstEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
        ).pipe(Effect.forkChild)
        yield* Deferred.await(firstEntered)
        const second = yield* WriterGuard.mutate(Deferred.succeed(secondEntered, undefined)).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(Option.isNone(yield* Deferred.poll(secondEntered))).toBe(true)
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(Option.isSome(yield* Deferred.poll(secondEntered))).toBe(true)
      }))
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("rechecks lease ownership before a queued TimerService write", () => {
    const firstEntered = Deferred.makeUnsafe<void>()
    const releaseFirst = Deferred.makeUnsafe<void>()
    let providerCalls = 0
    const fake = makeFakeHeadless({
      beforeClockifyWrite: () =>
        Effect.gen(function*() {
          providerCalls++
          if (providerCalls !== 1) return
          yield* Deferred.succeed(firstEntered, undefined)
          yield* Deferred.await(releaseFirst)
        })
    })
    return Effect.gen(function*() {
      yield* TestClock.setTime(Date.parse("2026-07-01T12:00:00Z"))
      const timer = yield* TimerService
      const owner = yield* WriterGuard.withWriterGuard(Effect.gen(function*() {
        const first = yield* timer.logManual({
          key: "PROJ-1",
          summary: "First synthetic task",
          status: "In Progress",
          priority: "Medium",
          assignee: null,
          type: "Task",
          labels: [],
          updated: "2026-07-01T00:00:00Z"
        }, {
          start: new Date("2026-07-01T10:00:00Z"),
          durationSeconds: 1800
        }).pipe(Effect.forkChild)
        yield* Deferred.await(firstEntered)
        const second = yield* timer.logManual({
          key: "PROJ-2",
          summary: "Second synthetic task",
          status: "In Progress",
          priority: "Medium",
          assignee: null,
          type: "Task",
          labels: [],
          updated: "2026-07-01T00:00:00Z"
        }, {
          start: new Date("2026-07-01T10:30:00Z"),
          durationSeconds: 1800
        }).pipe(Effect.result, Effect.forkChild)
        yield* Effect.yieldNow
        fake.world.writtenFiles[leasePath] = JSON.stringify({
          owner: "replacement-writer",
          heldSinceMs: 1,
          refreshedAtMs: 1,
          intervalSeconds: 300
        })
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(first)
        const result = yield* Fiber.join(second)
        expect(result._tag).toBe("Failure")
      })).pipe(Effect.result)

      expect(owner._tag).toBe("Success")
      expect(fake.world.createdClockifyEntries).toHaveLength(1)
      expect(providerCalls).toBe(1)
      expect(fake.world.writtenFiles[leasePath]).toContain("replacement-writer")
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("rejects a forked mutation after its owning guard releases", () => {
    const fake = makeFakeHeadless()
    let writes = 0
    return Effect.gen(function*() {
      const start = yield* Deferred.make<void>()
      const fiber = yield* WriterGuard.withWriterGuard(
        Deferred.await(start).pipe(
          Effect.andThen(WriterGuard.mutate(Effect.sync(() => writes++))),
          Effect.forkDetach
        )
      )
      yield* Deferred.succeed(start, undefined)
      const result = yield* Fiber.join(fiber).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(writes).toBe(0)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("keeps the machine lease until an admitted child mutation finishes", () => {
    const fake = makeFakeHeadless()
    let ownerWrites = 0
    let competitorWrites = 0
    return Effect.gen(function*() {
      const admitted = yield* Deferred.make<void>()
      const continueMutation = yield* Deferred.make<void>()
      const owner = yield* WriterGuard.withWriterGuard(Effect.gen(function*() {
        const child = yield* WriterGuard.mutate(
          Deferred.succeed(admitted, undefined).pipe(
            Effect.andThen(Deferred.await(continueMutation)),
            Effect.andThen(WriterGuard.mutate(Effect.sync(() => ownerWrites++)))
          )
        ).pipe(Effect.forkDetach)
        yield* Deferred.await(admitted)
        return child
      })).pipe(Effect.forkChild)

      yield* Deferred.await(admitted)
      yield* Effect.yieldNow
      const ownerBeforeRelease = owner.pollUnsafe()
      const leaseBeforeRelease = fake.world.writtenFiles[leasePath]

      const competitor = yield* WriterGuard.mutate(Effect.sync(() => competitorWrites++)).pipe(Effect.result)

      yield* Deferred.succeed(continueMutation, undefined)
      const child = yield* Fiber.join(owner)
      yield* Fiber.join(child)

      expect(ownerBeforeRelease).toBeUndefined()
      expect(leaseBeforeRelease).toBeDefined()
      expect(competitor._tag).toBe("Failure")
      expect(competitorWrites).toBe(0)
      expect(ownerWrites).toBe(1)
      expect(fake.world.writtenFiles[leasePath]).toBeUndefined()

      yield* WriterGuard.mutate(Effect.sync(() => competitorWrites++))
      expect(competitorWrites).toBe(1)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("holds the lease until an admitted TimerService write finishes after outer return", () => {
    const admitted = Deferred.makeUnsafe<void>()
    const continueWrite = Deferred.makeUnsafe<void>()
    const fake = makeFakeHeadless({
      beforeClockifyWrite: () =>
        Deferred.succeed(admitted, undefined).pipe(Effect.andThen(Deferred.await(continueWrite)))
    })
    return Effect.gen(function*() {
      yield* TestClock.setTime(Date.parse("2026-07-01T12:00:00Z"))
      const owner = yield* WriterGuard.withWriterGuard(Effect.gen(function*() {
        const timer = yield* TimerService
        yield* timer.logManual({
          key: "PROJ-1",
          summary: "Synthetic task",
          status: "In Progress",
          priority: "Medium",
          assignee: null,
          type: "Task",
          labels: [],
          updated: "2026-07-01T00:00:00Z"
        }, {
          start: new Date("2026-07-01T10:00:00Z"),
          durationSeconds: 3600
        }).pipe(Effect.forkDetach)
        yield* Deferred.await(admitted)
      })).pipe(Effect.forkChild)

      yield* Deferred.await(admitted)
      yield* Effect.yieldNow
      const competitor = yield* WriterGuard.mutate(Effect.void).pipe(Effect.result)
      expect(owner.pollUnsafe()).toBeUndefined()
      expect(fake.world.writtenFiles[leasePath]).toBeDefined()
      expect(competitor._tag).toBe("Failure")

      yield* Deferred.succeed(continueWrite, undefined)
      expect((yield* Fiber.await(owner))._tag).toBe("Success")
      expect(fake.world.createdClockifyEntries).toHaveLength(1)
      expect(fake.world.writtenFiles[leasePath]).toBeUndefined()
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("cancels an admitted TimerService write when interrupted during successful drain", () => {
    const admitted = Deferred.makeUnsafe<void>()
    const continueWrite = Deferred.makeUnsafe<void>()
    const useSucceeded = Deferred.makeUnsafe<void>()
    const writeInterrupted = Deferred.makeUnsafe<void>()
    const writeFinalized = Deferred.makeUnsafe<void>()
    const fake = makeFakeHeadless({
      beforeClockifyWrite: () =>
        Deferred.succeed(admitted, undefined).pipe(
          Effect.andThen(Deferred.await(continueWrite)),
          Effect.onInterrupt(() => Deferred.succeed(writeInterrupted, undefined)),
          Effect.ensuring(Deferred.succeed(writeFinalized, undefined))
        )
    })
    return Effect.gen(function*() {
      yield* TestClock.setTime(Date.parse("2026-07-01T12:00:00Z"))
      const owner = yield* WriterGuard.withWriterGuard(Effect.gen(function*() {
        const timer = yield* TimerService
        yield* timer.logManual({
          key: "PROJ-1",
          summary: "Synthetic task",
          status: "In Progress",
          priority: "Medium",
          assignee: null,
          type: "Task",
          labels: [],
          updated: "2026-07-01T00:00:00Z"
        }, {
          start: new Date("2026-07-01T10:00:00Z"),
          durationSeconds: 3600
        }).pipe(Effect.forkDetach)
        yield* Deferred.await(admitted)
        yield* Deferred.succeed(useSucceeded, undefined)
      })).pipe(Effect.forkChild)

      yield* Deferred.await(useSucceeded)
      yield* Effect.yieldNow
      const interrupt = yield* Fiber.interrupt(owner).pipe(Effect.forkChild)
      yield* Deferred.await(writeInterrupted)
      yield* Deferred.await(writeFinalized)
      yield* Fiber.join(interrupt)

      expect(fake.world.createdClockifyEntries).toEqual([])
      expect(fake.world.writtenFiles[leasePath]).toBeUndefined()
      yield* WriterGuard.mutate(Effect.void).pipe(Effect.provide(fake.layer))
      expect(fake.world.writtenFiles[leasePath]).toBeUndefined()
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("interrupts an admitted TimerService write after outer failure", () => {
    const admitted = Deferred.makeUnsafe<void>()
    const continueWrite = Deferred.makeUnsafe<void>()
    const writeInterrupted = Deferred.makeUnsafe<void>()
    const fake = makeFakeHeadless({
      beforeClockifyWrite: () =>
        Deferred.succeed(admitted, undefined).pipe(
          Effect.andThen(Deferred.await(continueWrite)),
          Effect.onInterrupt(() => Deferred.succeed(writeInterrupted, undefined))
        )
    })
    return Effect.gen(function*() {
      yield* TestClock.setTime(Date.parse("2026-07-01T12:00:00Z"))
      const owner = yield* WriterGuard.withWriterGuard(Effect.gen(function*() {
        const timer = yield* TimerService
        yield* timer.logManual({
          key: "PROJ-1",
          summary: "Synthetic task",
          status: "In Progress",
          priority: "Medium",
          assignee: null,
          type: "Task",
          labels: [],
          updated: "2026-07-01T00:00:00Z"
        }, {
          start: new Date("2026-07-01T10:00:00Z"),
          durationSeconds: 3600
        }).pipe(Effect.forkDetach)
        yield* Deferred.await(admitted)
        return yield* Effect.fail("outer failure")
      })).pipe(Effect.forkChild)

      yield* Deferred.await(writeInterrupted)
      expect((yield* Fiber.await(owner))._tag).toBe("Failure")
      expect(fake.world.createdClockifyEntries).toEqual([])
      expect(fake.world.writtenFiles[leasePath]).toBeUndefined()
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("interrupts and joins an admitted TimerService write before releasing the lease", () => {
    return Effect.gen(function*() {
      const admitted = yield* Deferred.make<void>()
      const continueWrite = yield* Deferred.make<void>()
      const writeInterrupted = yield* Deferred.make<void>()
      const guarded = makeFakeHeadless({
        beforeClockifyWrite: () =>
          Deferred.succeed(admitted, undefined).pipe(
            Effect.andThen(Deferred.await(continueWrite)),
            Effect.onInterrupt(() => Deferred.succeed(writeInterrupted, undefined))
          )
      })
      yield* TestClock.setTime(Date.parse("2026-07-01T12:00:00Z"))

      const owner = yield* WriterGuard.withWriterGuard(Effect.gen(function*() {
        const timer = yield* TimerService
        yield* timer.logManual({
          key: "PROJ-1",
          summary: "Synthetic task",
          status: "In Progress",
          priority: "Medium",
          assignee: null,
          type: "Task",
          labels: [],
          updated: "2026-07-01T00:00:00Z"
        }, {
          start: new Date("2026-07-01T10:00:00Z"),
          durationSeconds: 3600
        }).pipe(Effect.forkChild)
        yield* Deferred.await(admitted)
        return yield* Effect.never
      })).pipe(
        Effect.provide(guarded.layer),
        Effect.forkChild
      )

      yield* Deferred.await(admitted)
      const interrupt = yield* Fiber.interrupt(owner).pipe(Effect.forkChild)
      yield* Deferred.await(writeInterrupted)
      yield* Fiber.join(interrupt)

      expect(guarded.world.createdClockifyEntries).toEqual([])
      expect(guarded.world.writtenFiles[leasePath]).toBeUndefined()
      yield* WriterGuard.mutate(Effect.void).pipe(Effect.provide(guarded.layer))
      expect(guarded.world.writtenFiles[leasePath]).toBeUndefined()
    })
  })
})
