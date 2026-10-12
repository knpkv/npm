import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { FrameSize } from "../src/browser.js"

it.effect("capture frames require nonzero bounded physical dimensions", () =>
  Effect.gen(function*() {
    for (const size of [{ width: 390, height: 844 }, { width: 16_384, height: 800 }]) {
      expect(yield* Schema.decodeUnknownEffect(FrameSize)(size)).toEqual(size)
    }
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 16_385]) {
      for (const size of [{ width: invalid, height: 800 }, { width: 1280, height: invalid }]) {
        expect((yield* Schema.decodeUnknownEffect(FrameSize)(size).pipe(Effect.exit))._tag).toBe("Failure")
      }
    }
  }))
