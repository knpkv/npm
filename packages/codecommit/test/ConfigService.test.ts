import { CacheService, ConfigService } from "@knpkv/codecommit-core"
import { Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { describe, expect, it } from "vitest"

const MockPath = Path.layer

const makeMockFileSystem = (partial: Partial<FileSystem.FileSystem>) =>
  Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.FileSystem.of(partial as FileSystem.FileSystem)
  )

const runWithConfig = <A>(
  program: Effect.Effect<A, unknown, ConfigService.ConfigService>,
  fileSystem: Layer.Layer<FileSystem.FileSystem>
) =>
  Effect.runPromise(
    Effect.provide(
      program,
      ConfigService.ConfigServiceLive.pipe(
        Layer.provide(Layer.mergeAll(fileSystem, MockPath, CacheService.EventsHub.Default))
      )
    ) as Effect.Effect<A, unknown>
  )

describe("ConfigService", () => {
  it("should return empty accounts if config file does not exist", async () => {
    const MockFileSystem = makeMockFileSystem({
      exists: () => Effect.succeed(false),
      readFileString: () => Effect.succeed("")
    })

    const program = Effect.gen(function*() {
      const configService = yield* ConfigService.ConfigService
      const config = yield* configService.load
      return config
    })

    const result = await runWithConfig(program, MockFileSystem)

    expect(result.accounts).toEqual([])
  })

  it("should load and parse valid config", async () => {
    const mockContent = JSON.stringify({
      accounts: [
        { profile: "work", regions: ["us-west-2"], enabled: true }
      ]
    })

    const MockFileSystem = makeMockFileSystem({
      exists: () => Effect.succeed(true),
      readFileString: () => Effect.succeed(mockContent)
    })

    const program = Effect.gen(function*() {
      const configService = yield* ConfigService.ConfigService
      const config = yield* configService.load
      return config
    })

    const result = await runWithConfig(program, MockFileSystem)

    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]!.profile).toBe("work")
  })
})
