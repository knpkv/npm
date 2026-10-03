import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { JiraApi } from "../src/index.js"

const decodeChange = Schema.decodeUnknownSync(JiraApi.ChangeDetails)

describe("ownOptionalKey", () => {
  // Effect reads declared keys with `in`; JSON omitting `toString` must not decode Object.prototype.toString.
  it("decodes an omitted toString as an absent key", () => {
    const change = decodeChange(JSON.parse(`{"field":"Comment","fromString":"Previous comment"}`))
    assert.isFalse(Object.hasOwn(change, "toString"))
    assert.deepStrictEqual({ ...change }, { field: "Comment", fromString: "Previous comment" })
  })

  it("keeps an own toString value", () => {
    const change = decodeChange(JSON.parse(`{"field":"status","toString":"Done"}`))
    assert.isTrue(Object.hasOwn(change, "toString"))
    assert.strictEqual(change.toString, "Done")
  })

  it("rejects an own non-string toString", () => {
    assert.throws(() => decodeChange(JSON.parse(`{"field":"status","toString":42}`)))
  })
})
