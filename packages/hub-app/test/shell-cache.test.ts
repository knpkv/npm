/** The standalone shell's stylesheet cache: read until a read succeeds, and kept for good only under its own hash. */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import { cacheSuccess, shellCssCacheControl } from "../src/shell-cache.js"

describe("cacheSuccess", () => {
  it.effect("retries a failed read, then keeps the first success", () =>
    Effect.gen(function*() {
      const reads = yield* Ref.make(0)
      const read = Ref.updateAndGet(reads, (count) => count + 1).pipe(
        Effect.flatMap((count) => count === 1 ? Effect.fail("missing build") : Effect.succeed(`css ${count}`))
      )
      const cached = yield* cacheSuccess(read)
      expect(yield* Effect.flip(cached)).toBe("missing build")
      expect([yield* cached, yield* cached, yield* Ref.get(reads)]).toEqual(["css 2", "css 2", 2])
    }))
})

describe("shellCssCacheControl", () => {
  it("lets browsers keep the stylesheet only under its current hash", () => {
    expect(shellCssCacheControl("0123456789abcdef", "0123456789abcdef")).toBe("public, max-age=31536000, immutable")
    expect(shellCssCacheControl("fedcba9876543210", "0123456789abcdef")).toBe("no-cache")
    expect(shellCssCacheControl(undefined, "0123456789abcdef")).toBe("no-cache")
  })
})
