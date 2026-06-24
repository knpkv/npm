import { it as effectIt } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { ContentHash } from "../src/Brand.js"
import { hashBuffer, hashContent, hashEquals } from "../src/Hash.js"

const byteSequenceDigest = Uint8Array.from({ length: 32 }, (_, index) => index)
const byteSequenceHash = ContentHash("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")

describe("Hash", () => {
  effectIt.effect("delegates SHA-256 hashing to the provided Crypto service", () =>
    Effect.gen(function*() {
      const hash = yield* hashContent("hello")
      expect(hash).toBe(byteSequenceHash)
    }).pipe(
      Effect.provideService(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (algorithm, data) => {
            expect(algorithm).toBe("SHA-256")
            expect(Array.from(data)).toEqual([104, 101, 108, 108, 111])
            return Effect.succeed(byteSequenceDigest)
          }
        })
      )
    ))

  effectIt.effect("hashes binary content through the provided Crypto service", () =>
    Effect.gen(function*() {
      const hash = yield* hashBuffer(Uint8Array.of(1, 2, 3))
      expect(hash).toBe(byteSequenceHash)
    }).pipe(
      Effect.provideService(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (algorithm, data) => {
            expect(algorithm).toBe("SHA-256")
            expect(Array.from(data)).toEqual([1, 2, 3])
            return Effect.succeed(byteSequenceDigest)
          }
        })
      )
    ))

  it("compares content hashes by value", () => {
    expect(hashEquals(byteSequenceHash, byteSequenceHash)).toBe(true)
    expect(hashEquals(byteSequenceHash, ContentHash("f".repeat(64)))).toBe(false)
  })
})
