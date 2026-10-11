import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { decodeOutputs } from "../src/outputs.js"

it.effect("returns output keys with Hidden values, never traversing or transporting plaintext or nested marker siblings", () =>
  Effect.gen(function*() {
    const outputs = yield* decodeOutputs(JSON.stringify({
      Endpoint: "fixture-private-value",
      Nested: { __redacted__: "fixture-encrypted-value", sibling: "fixture-private-value" },
      Count: 7,
      Structure: { nested: ["fixture-private-value"] }
    }))
    expect(outputs.map((output) => output.key)).toEqual(["Count", "Endpoint", "Nested", "Structure"])
    expect(outputs.every((output) => output.value._tag === "Hidden" && output.description === null)).toBe(true)
    expect(JSON.stringify(outputs)).not.toContain("fixture-private-value")
    expect(JSON.stringify(outputs)).not.toContain("fixture-encrypted-value")
    expect(yield* decodeOutputs("{}")).toEqual([])
  }))

it.effect("rejects root encoding envelopes with siblings and non-dictionary or malformed state without retaining contents", () =>
  Effect.gen(function*() {
    for (const marker of ["__redacted__", "__date__", "__duration__"]) {
      const error = yield* Effect.flip(decodeOutputs(JSON.stringify({ [marker]: "fixture-private-value", Safe: 1 })))
      expect(error.reason).toBe("invalid-state")
      expect(JSON.stringify(error)).not.toContain("fixture-private-value")
    }
    for (const text of ["null", "[]", "7", "\"fixture-private-value\"", "{", ""]) {
      expect(yield* Effect.flip(decodeOutputs(text))).toMatchObject({ reason: "invalid-state" })
    }
  }))

it.effect("bounds output names and count without reading their values", () =>
  Effect.gen(function*() {
    for (
      const value of [
        { "": 1 },
        { ["x".repeat(257)]: 1 },
        { "control\u0000name": 1 },
        Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`Output${index}`, "fixture-private-value"]))
      ]
    ) {
      expect(yield* Effect.flip(decodeOutputs(JSON.stringify(value)))).toMatchObject({ reason: "invalid-state" })
    }
  }))
