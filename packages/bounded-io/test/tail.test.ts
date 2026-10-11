/**
 * Tail collection keeps a stream's last bytes for output whose end matters,
 * reads the stream to its end whatever its size, and never cuts a character.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref, Stream } from "effect"
import { collectTail, collectTailText } from "../src/index.js"

const bytes = (...values: ReadonlyArray<number>) => new Uint8Array(values)
const text = (value: string) => new TextEncoder().encode(value)

describe("collectTail", () => {
  it.effect("keeps everything under the limit", () =>
    Effect.gen(function*() {
      const tail = yield* collectTail(Stream.make(bytes(1, 2), bytes(3)), 3)
      expect(tail).toEqual({ bytes: bytes(1, 2, 3), omittedBytes: 0 })
    }))

  it.effect("keeps the last bytes across chunk boundaries and counts the rest", () =>
    Effect.gen(function*() {
      const tail = yield* collectTail(Stream.make(bytes(1, 2, 3), bytes(4, 5), bytes(6, 7, 8)), 4)
      expect(tail).toEqual({ bytes: bytes(5, 6, 7, 8), omittedBytes: 4 })
    }))

  it.effect("keeps nothing at a zero limit and still reads to the end", () =>
    Effect.gen(function*() {
      const pulled = yield* Ref.make(0)
      const stream = Stream.make(bytes(1), bytes(2), bytes(3)).pipe(
        Stream.tap(() => Ref.update(pulled, (count) => count + 1))
      )
      const tail = yield* collectTail(stream, 0)
      expect(tail).toEqual({ bytes: bytes(), omittedBytes: 3 })
      expect(yield* Ref.get(pulled)).toBe(3)
    }))

  it.effect("dies on an invalid limit", () =>
    Effect.gen(function*() {
      const exit = yield* collectTail(Stream.make(bytes(1)), Number.NaN).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }))
})

describe("collectTailText", () => {
  it.effect("decodes a tail that fits whole", () =>
    Effect.gen(function*() {
      expect(yield* collectTailText(Stream.make(text("done\n")), 64)).toEqual({ text: "done\n", omittedBytes: 0 })
    }))

  it.effect("starts on a character boundary when the cut lands inside one", () =>
    Effect.gen(function*() {
      // "xé!" is four bytes ("é" takes two); its last two start inside "é".
      const tail = yield* collectTailText(Stream.make(text("xé"), text("!")), 2)
      expect(tail).toEqual({ text: "!", omittedBytes: 3 })
    }))
})
