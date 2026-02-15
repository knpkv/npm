import { FileSystem, Path } from "@effect/platform"
import { CacheService, ConfigService } from "@knpkv/codecommit-core"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"

const MockPath = Path.layer

describe("ConfigService", () => {
  it("should return empty accounts if config file does not exist", async () => {
    const MockFileSystem = Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.FileSystem.of({
        exists: () => Effect.succeed(false),
        readFileString: () => Effect.succeed("")
      } as any)
    )

    const program = Effect.gen(function*() {
      const configService = yield* ConfigService.ConfigService
      const config = yield* configService.load
      return config
    })

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          ConfigService.ConfigServiceLive.pipe(
            Layer.provide(Layer.mergeAll(MockFileSystem, MockPath, CacheService.EventsHub.Default))
          )
        )
      )
    )

    expect(result.accounts).toEqual([])
  })

  it("should load and parse valid config", async () => {
    const mockContent = JSON.stringify({
      accounts: [
        { profile: "work", regions: ["us-west-2"], enabled: true }
      ]
    })

    const MockFileSystem = Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.FileSystem.of({
        exists: () => Effect.succeed(true),
        readFileString: () => Effect.succeed(mockContent)
      } as any)
    )

    const program = Effect.gen(function*() {
      const configService = yield* ConfigService.ConfigService
      const config = yield* configService.load
      return config
    })

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          ConfigService.ConfigServiceLive.pipe(
            Layer.provide(Layer.mergeAll(MockFileSystem, MockPath, CacheService.EventsHub.Default))
          )
        )
      )
    )

    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]!.profile).toBe("work")
  })
})
