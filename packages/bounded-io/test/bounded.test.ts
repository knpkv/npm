/**
 * The byte budget every bounded reader in the repo relies on: chunks pass
 * through untouched under the limit, the chunk that crosses it fails the stream
 * with the limit and the running total, and nothing after it is pulled.
 */
import { describe, expect, it } from "@effect/vitest"
import { Data, Effect, Ref, Stream } from "effect"
import { collectBounded, collectBoundedText, limitBytes } from "../src/index.js"

const bytes = (...values: ReadonlyArray<number>) => new Uint8Array(values)
const chunks = (...sizes: ReadonlyArray<number>) => Stream.fromIterable(sizes.map((size) => new Uint8Array(size)))

class UpstreamError extends Data.TaggedError("UpstreamError")<{ readonly reason: string }> {}

describe("limitBytes", () => {
  it.effect("passes chunks through unchanged under the limit", () =>
    Effect.gen(function*() {
      const out = yield* limitBytes(Stream.make(bytes(1, 2), bytes(3)), 3).pipe(Stream.runCollect)
      expect(out).toEqual([bytes(1, 2), bytes(3)])
    }))

  it.effect("fails on the chunk that crosses the limit with the running total", () =>
    Effect.gen(function*() {
      const error = yield* limitBytes(chunks(2, 2, 2), 3).pipe(Stream.runDrain, Effect.flip)
      expect(error).toMatchObject({ _tag: "ByteLimitExceeded", limit: 3, observedBytes: 4 })
    }))

  it.effect("accepts exactly the limit", () =>
    Effect.gen(function*() {
      const out = yield* limitBytes(chunks(2, 1), 3).pipe(Stream.runCollect)
      expect(out).toHaveLength(2)
    }))

  it.effect("passes an upstream failure through unchanged", () =>
    Effect.gen(function*() {
      const error = yield* limitBytes(Stream.fail(new UpstreamError({ reason: "eof" })), 3).pipe(
        Stream.runDrain,
        Effect.flip
      )
      expect(error).toEqual(new UpstreamError({ reason: "eof" }))
    }))
})

describe("collectBounded", () => {
  it.effect("joins chunks in order", () =>
    Effect.gen(function*() {
      expect(yield* collectBounded(Stream.make(bytes(1, 2), bytes(), bytes(3)), 10)).toEqual(bytes(1, 2, 3))
      expect(yield* collectBounded(Stream.empty, 10)).toEqual(bytes())
    }))

  it.effect("stops pulling once the limit is crossed", () =>
    Effect.gen(function*() {
      const pulled = yield* Ref.make(0)
      const endless = Stream.iterate(0, (n) => n + 1).pipe(
        Stream.mapEffect(() => Ref.update(pulled, (n) => n + 1).pipe(Effect.as(new Uint8Array(4))))
      )
      const error = yield* collectBounded(endless, 10).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "ByteLimitExceeded", limit: 10, observedBytes: 12 })
      expect(yield* Ref.get(pulled)).toBe(3)
    }))
})

describe("collectBoundedText", () => {
  it.effect("decodes a multi-byte character split across chunks", () =>
    Effect.gen(function*() {
      // "é" is C3 A9; "😀" is F0 9F 98 80.
      const text = yield* collectBoundedText(
        Stream.make(bytes(0x61, 0xc3), bytes(0xa9, 0xf0, 0x9f), bytes(0x98, 0x80)),
        16
      )
      expect(text).toBe("aé😀")
    }))
})
