import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { makeLocalLogin } from "../src/internal/local-login.js"

describe("local login code", () => {
  it.layer(NodeServices.layer)((it) => {
    // `herdr-hub login` gets one code; the page spends it once.
    it.effect("spends a code once", () =>
      Effect.gen(function*() {
        const login = yield* makeLocalLogin
        const code = Redacted.value(yield* login.mint)
        expect(yield* login.exchange(code)).toBe(true)
        expect(yield* login.exchange(code)).toBe(false)
      }))

    // Two pages racing with the same code: exactly one wins.
    it.effect("lets exactly one of two racing exchanges win", () =>
      Effect.gen(function*() {
        const login = yield* makeLocalLogin
        const code = Redacted.value(yield* login.mint)
        const results = yield* Effect.all([login.exchange(code), login.exchange(code)], { concurrency: 2 })
        expect(results.filter(Boolean)).toHaveLength(1)
      }))

    // Long enough to open the page, short enough to forget.
    it.effect("expires a code after 60 seconds", () =>
      Effect.gen(function*() {
        const login = yield* makeLocalLogin
        const code = Redacted.value(yield* login.mint)
        yield* TestClock.adjust("61 seconds")
        expect(yield* login.exchange(code)).toBe(false)
      }))

    // One live code: a newer one replaces it.
    it.effect("keeps one live code, the newest", () =>
      Effect.gen(function*() {
        const login = yield* makeLocalLogin
        const first = Redacted.value(yield* login.mint)
        const second = Redacted.value(yield* login.mint)
        expect(yield* login.exchange(first)).toBe(false)
        expect(yield* login.exchange(second)).toBe(true)
      }))

    // Guessing closes the exchange: after 5 wrong codes the live one is dropped too.
    it.effect("drops the live code after 5 wrong guesses", () =>
      Effect.gen(function*() {
        const login = yield* makeLocalLogin
        const code = Redacted.value(yield* login.mint)
        for (let guess = 0; guess < 5; guess++) {
          expect(yield* login.exchange("ab".repeat(32))).toBe(false)
        }
        expect(yield* login.exchange(code)).toBe(false)
      }))
  })
})
