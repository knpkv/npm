import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { ClockifyApi } from "../src/index.js"

// The spec declares custom-field values as objects, but Clockify sends and accepts scalars and arrays.
describe("custom field values", () => {
  it("decode the scalar values Clockify returns", () => {
    for (const value of ["new value", 42, true, ["a", "b"]]) {
      const decoded = Schema.decodeUnknownSync(ClockifyApi.CustomFieldValueDtoV1)({ customFieldId: "cf", value })
      assert.deepStrictEqual(decoded.value, value)
    }
  })

  it("encode a scalar update value", () => {
    const encoded = Schema.encodeSync(ClockifyApi.UpdateCustomFieldRequest)({ customFieldId: "cf", value: "new value" })
    assert.strictEqual(encoded.value, "new value")
  })
})
