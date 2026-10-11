import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref, Result } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as PlatformError from "effect/PlatformError"
import { makeSavedPermissionCheck } from "../src/PermissionService/index.js"

const path = "/fixture/permissions.json"
const fixture = Effect.fn("SavedPermissionTest.fixture")(function*(content: string | null) {
  const source = yield* Ref.make(content)
  const fs = FileSystem.makeNoop({
    exists: () => Ref.get(source).pipe(Effect.map((value) => value !== null)),
    readFileString: () =>
      Ref.get(source).pipe(
        Effect.flatMap((value) => value === null ? Effect.die("fixture read of missing policy") : Effect.succeed(value))
      )
  })
  const check = yield* makeSavedPermissionCheck(path).pipe(Effect.provideService(FileSystem.FileSystem, fs))
  return { source, check }
})

describe("saved permission policy", () => {
  /** An owner revocation must apply before the next call in another application's runtime. */
  it.effect("rereads standing grants instead of retaining a startup snapshot", () =>
    Effect.gen(function*() {
      const test = yield* fixture("{\"permissions\":{\"getBlob\":\"always_allow\"}}")
      expect(yield* test.check("getBlob")).toBe("always_allow")
      yield* Ref.set(test.source, "{\"permissions\":{\"getBlob\":\"deny\"}}")
      expect(yield* test.check("getBlob")).toBe("deny")
      yield* Ref.set(test.source, "{\"permissions\":{}}")
      expect(yield* test.check("getBlob")).toBe("allow")
    }))

  it.effect("requires an owner grant when the policy is absent", () =>
    Effect.gen(function*() {
      const test = yield* fixture(null)
      expect(yield* test.check("getBlob")).toBe("allow")
    }))

  it.effect("fails with ConfigError for malformed or invalid policy instead of reusing a grant", () =>
    Effect.gen(function*() {
      const test = yield* fixture("{\"permissions\":{\"getBlob\":\"always_allow\"}}")
      expect(yield* test.check("getBlob")).toBe("always_allow")
      for (const content of ["{ broken", "{\"permissions\":{\"getBlob\":\"unexpected\"}}"]) {
        yield* Ref.set(test.source, content)
        const outcome = yield* Effect.result(test.check("getBlob"))
        expect(Result.isFailure(outcome)).toBe(true)
        if (Result.isFailure(outcome)) expect(outcome.failure._tag).toBe("ConfigError")
      }
    }))

  it.effect("fails closed when the persisted policy cannot be read", () =>
    Effect.gen(function*() {
      const fs = FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.fail(
            new PlatformError.PlatformError(
              new PlatformError.SystemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readFileString",
                pathOrDescriptor: path
              })
            )
          )
      })
      const check = yield* makeSavedPermissionCheck(path).pipe(Effect.provideService(FileSystem.FileSystem, fs))
      const outcome = yield* Effect.result(check("getBlob"))
      expect(Result.isFailure(outcome)).toBe(true)
      if (Result.isFailure(outcome)) expect(outcome.failure._tag).toBe("ConfigError")
    }))
})
