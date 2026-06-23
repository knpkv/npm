import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { AdfSchemaValidator, layer as AdfSchemaValidatorLayer } from "../src/AdfSchemaValidator.js"

describe("AdfSchemaValidator", () => {
  it.effect("accepts a valid minimal doc and narrows the type", () =>
    Effect.gen(function*() {
      const v = yield* AdfSchemaValidator
      const doc = {
        version: 1,
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }]
      }
      const result = yield* v.check(doc, "incoming")
      expect(result.type).toBe("doc")
    }).pipe(Effect.provide(AdfSchemaValidatorLayer)))

  it.effect("fails with structured issues on a structurally invalid doc", () =>
    Effect.gen(function*() {
      const v = yield* AdfSchemaValidator
      const doc = {
        version: 1,
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: 42 }] }]
      }
      const result = yield* Effect.result(v.check(doc, "incoming"))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("AdfSchemaError")
        expect(result.failure.direction).toBe("incoming")
        expect(result.failure.issues.length).toBeGreaterThan(0)
      }
    }).pipe(Effect.provide(AdfSchemaValidatorLayer)))
})
