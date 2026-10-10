import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { authorizeLoopbackPeer } from "../src/auth.js"

describe("authorizeLoopbackPeer", () => {
  it.effect("admits any loopback peer of the Work listener", () =>
    Effect.gen(function*() {
      for (const remoteAddress of ["127.0.0.1", "127.0.0.2", "::ffff:127.0.0.2"]) {
        expect(yield* authorizeLoopbackPeer({ login: undefined, remoteAddress })).toBe("local")
      }
    }))

  it.effect("refuses non-loopback, unknown, and identity-bearing peers", () =>
    Effect.gen(function*() {
      for (
        const identity of [
          { login: undefined, remoteAddress: "192.168.1.24" },
          { login: undefined, remoteAddress: "::ffff:10.0.0.1" },
          { login: undefined, remoteAddress: "1127.0.0.1" },
          { login: undefined, remoteAddress: undefined },
          { login: "someone@example.test", remoteAddress: "127.0.0.1" }
        ]
      ) {
        const result = yield* Effect.result(authorizeLoopbackPeer(identity))
        expect(Result.isFailure(result)).toBe(true)
      }
    }))
})
