import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Hello from "../src/index.js"

describe("Hello", () => {
  describe("greet", () => {
    it.effect("should create a greeting message", () =>
      Effect.gen(function*() {
        const result = yield* Hello.greet("World")
        assert.strictEqual(result, "Hello, World!")
      }))

    it.effect("should handle different names", () =>
      Effect.gen(function*() {
        const result = yield* Hello.greet("Alice")
        assert.strictEqual(result, "Hello, Alice!")
      }))
  })

  describe("greetWithPrefix", () => {
    it.effect("should create a greeting with custom prefix", () =>
      Effect.gen(function*() {
        const result = yield* Hello.greetWithPrefix("Welcome", "Bob")
        assert.strictEqual(result, "Welcome, Bob!")
      }))

    it.effect("should handle different prefixes", () =>
      Effect.gen(function*() {
        const result = yield* Hello.greetWithPrefix("Hi", "Charlie")
        assert.strictEqual(result, "Hi, Charlie!")
      }))
  })
})
