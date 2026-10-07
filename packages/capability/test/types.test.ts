/** @effect-diagnostics missingEffectError:skip-file -- this file asserts rejected types; each @ts-expect-error carries the check */
/**
 * Compile-time guarantees: a handler cannot fail with an error its contract does not declare, and
 * only gated contracts have a pending action to describe.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { defineContract, describeCall, implement } from "../src/index.js"

class Declared extends Schema.TaggedError<Declared>()("Declared", { fix: Schema.String }) {}
class Undeclared extends Schema.TaggedError<Undeclared>()("Undeclared", { fix: Schema.String }) {}

const readContract = defineContract({
  name: "read_thing",
  description: "Read a thing.",
  access: "read",
  input: Schema.Struct({ id: Schema.String }),
  output: Schema.String,
  failure: Declared
})

describe("contract types", () => {
  it("accepts a handler that fails only with the declared failure", () => {
    const capability = implement(readContract, () => Effect.fail(new Declared({ fix: "Retry." })))
    expect(capability._tag).toBe("Capability")
  })

  it("rejects a handler that fails with an undeclared error", () => {
    const failsUndeclared = () => Effect.fail(new Undeclared({ fix: "Retry." }))
    // @ts-expect-error -- the contract declares only Declared, so Undeclared must not typecheck
    const capability = implement(readContract, failsUndeclared)
    expect(capability._tag).toBe("Capability")
  })

  it("has no pending action to describe for a read contract", () => {
    // @ts-expect-error -- describeCall accepts gated (write or host) contracts only
    const describe = () => describeCall(readContract, { id: "1" })
    expect(describe).toBeInstanceOf(Function)
  })

  it("requires a gated contract to describe its action", () => {
    const define = () =>
      // @ts-expect-error -- a write contract without describe and reversible must not typecheck
      defineContract({
        name: "write_thing",
        description: "Write a thing.",
        access: "write",
        input: Schema.Struct({ id: Schema.String }),
        output: Schema.String,
        failure: Schema.Never
      })
    expect(define).toBeInstanceOf(Function)
  })
})
