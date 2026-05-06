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
      const result = yield* Effect.either(v.check(doc, "incoming"))
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("AdfSchemaError")
        expect(result.left.direction).toBe("incoming")
        expect(result.left.issues.length).toBeGreaterThan(0)
      }
    }).pipe(Effect.provide(AdfSchemaValidatorLayer)))
})
