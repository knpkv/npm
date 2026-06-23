import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { AtlaskitTransformers, layer as AtlaskitTransformersLayer } from "../src/AtlaskitTransformers.js"

describe("AtlaskitTransformers", () => {
  it.effect("encodes markdown to ADF JSON", () =>
    Effect.gen(function*() {
      const t = yield* AtlaskitTransformers
      const adf = yield* t.use(({ json, md }) => json.encode(md.parse("# Hello")))
      expect(adf.type).toBe("doc")
      expect(adf.content[0]?.type).toBe("heading")
    }).pipe(Effect.provide(AtlaskitTransformersLayer)))

  it.effect("surfaces synchronous throws as AtlaskitTransformersError", () =>
    Effect.gen(function*() {
      const t = yield* AtlaskitTransformers
      const result = yield* Effect.result(t.use(() => {
        throw new Error("boom")
      }))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("AtlaskitTransformersError")
      }
    }).pipe(Effect.provide(AtlaskitTransformersLayer)))
})
