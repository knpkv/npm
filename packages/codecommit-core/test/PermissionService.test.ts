import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Result, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import { EventsHub, RepoChange } from "../src/CacheService/EventsHub.js"
import { PermissionService } from "../src/PermissionService/index.js"
import { PermissionGateLiveTag } from "../src/PermissionService/PermissionGateLive.js"

const TEST_HOME = "/tmp/codecommit-permissions-test"
const permissionPath = `${TEST_HOME}/.codecommit/permissions.json`

const permissionLayer = (content: string) => {
  const fileSystem = FileSystem.FileSystem.of({
    readFileString: (path) =>
      path === permissionPath
        ? Effect.succeed(content)
        : Effect.die(`Unexpected permissions path: ${path}`)
  })
  return PermissionService.Default.pipe(
    Layer.provide(Layer.succeed(FileSystem.FileSystem, fileSystem)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { HOME: TEST_HOME } })
      )
    )
  )
}

const readDefaultPermission = (content: string) =>
  Effect.gen(function*() {
    const permissions = yield* PermissionService
    return yield* permissions.check("getPullRequests")
  }).pipe(Effect.provide(permissionLayer(content)))

describe("PermissionService", () => {
  it.effect("falls back to prompt-by-default permissions for malformed JSON", () =>
    Effect.gen(function*() {
      expect(yield* readDefaultPermission("{ malformed")).toBe("allow")
    }))

  it.effect("falls back to prompt-by-default permissions for schema-invalid JSON", () =>
    Effect.gen(function*() {
      expect(
        yield* readDefaultPermission(JSON.stringify({
          permissions: { getPullRequests: "unexpected" }
        }))
      ).toBe("allow")
    }))

  it.effect("removes interrupted sibling prompts after one concurrent request is denied", () =>
    Effect.gen(function*() {
      const gate = yield* PermissionGateLiveTag
      const first = yield* gate.request({
        id: "prompt-1",
        operation: "getBlob",
        category: "read",
        context: "before blob"
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const second = yield* gate.request({
        id: "prompt-2",
        operation: "getBlob",
        category: "read",
        context: "after blob"
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect((yield* gate.getFirstPending())?.id).toBe("prompt-1")
      yield* gate.resolve("prompt-1", "deny")
      expect(Result.isFailure(yield* Effect.result(Fiber.join(first)))).toBe(true)
      expect((yield* gate.getFirstPending())?.id).toBe("prompt-2")

      yield* Fiber.interrupt(second)
      expect(yield* gate.getFirstPending()).toBeUndefined()
    }).pipe(Effect.provide(PermissionGateLiveTag.Default)))

  it.effect("removes a prompt interrupted while its required event is still publishing", () =>
    Effect.gen(function*() {
      const publishing = yield* Deferred.make<void>()
      const releasePublish = yield* Deferred.make<void>()
      const events = EventsHub.of({
        publish: (change) =>
          change._tag === "PermissionRequired"
            ? Deferred.succeed(publishing, undefined).pipe(Effect.andThen(Deferred.await(releasePublish)))
            : Effect.void,
        batch: (effect) => effect,
        subscribe: Stream.empty
      })
      yield* Effect.gen(function*() {
        const gate = yield* PermissionGateLiveTag
        const request = yield* gate.request({
          id: "prompt-publishing",
          operation: "getBlob",
          category: "read",
          context: "interrupted publish"
        }).pipe(Effect.forkChild)

        yield* Deferred.await(publishing)
        expect((yield* gate.getFirstPending())?.id).toBe("prompt-publishing")
        yield* Fiber.interrupt(request)
        expect(yield* gate.getFirstPending()).toBeUndefined()

        yield* events.publish(RepoChange.PermissionResolved())
      }).pipe(
        Effect.provide(PermissionGateLiveTag.layer),
        Effect.provideService(EventsHub, events)
      )
    }))

  it.effect("drains both concurrent prompts when both receive responses", () =>
    Effect.gen(function*() {
      const gate = yield* PermissionGateLiveTag
      const first = yield* gate.request({
        id: "prompt-1",
        operation: "getBlob",
        category: "read",
        context: "before blob"
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const second = yield* gate.request({
        id: "prompt-2",
        operation: "getBlob",
        category: "read",
        context: "after blob"
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      yield* gate.resolve("prompt-1", "allow_once")
      expect(yield* Fiber.join(first)).toBe("allow_once")
      expect((yield* gate.getFirstPending())?.id).toBe("prompt-2")
      yield* gate.resolve("prompt-2", "allow_once")
      expect(yield* Fiber.join(second)).toBe("allow_once")
      expect(yield* gate.getFirstPending()).toBeUndefined()
    }).pipe(Effect.provide(PermissionGateLiveTag.Default)))
})
