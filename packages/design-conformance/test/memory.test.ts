import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"

import { checkBaseMemory } from "../scripts/memory.js"

it.effect("hosts without proc memory information skip the local Linux policy", () =>
  Effect.gen(function*() {
    let reads = 0
    const fs = FileSystem.makeNoop({
      exists: () => Effect.succeed(false),
      readFileString: () =>
        Effect.sync(() => {
          reads += 1
          return ""
        })
    })
    yield* checkBaseMemory().pipe(Effect.provideService(FileSystem.FileSystem, fs))
    expect(reads).toBe(0)
  }))

it.effect("present memory information still enforces the floor and rejects malformed data", () =>
  Effect.gen(function*() {
    for (const memory of ["MemAvailable: 3145727 kB", "MemTotal: 10000000 kB"]) {
      const fs = FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () => Effect.succeed(memory)
      })
      expect(yield* checkBaseMemory().pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.flip))
        .toMatchObject({ _tag: "RunnerFailure", detail: "Base capture needs at least 3 GiB MemAvailable" })
    }
    const sufficient = FileSystem.makeNoop({
      exists: () => Effect.succeed(true),
      readFileString: () => Effect.succeed("MemAvailable: 3145728 kB")
    })
    yield* checkBaseMemory().pipe(Effect.provideService(FileSystem.FileSystem, sufficient))
    const unreadable = FileSystem.makeNoop({ exists: () => Effect.succeed(true) })
    expect(yield* checkBaseMemory().pipe(Effect.provideService(FileSystem.FileSystem, unreadable), Effect.flip))
      .toMatchObject({ _tag: "PlatformError" })
  }))
