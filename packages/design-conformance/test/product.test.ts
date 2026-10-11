import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"

import { isReferenceOnlyChange } from "../scripts/product.js"

it.effect("only a nonempty refs-only diff exempts states from touched enforcement", () =>
  Effect.sync(() => {
    expect(isReferenceOnlyChange(["design-refs/toy/manifest.json", "design-refs/toy/fixture.json"])).toBe(true)
    expect(isReferenceOnlyChange(["design-refs/toy/manifest.json", "packages/toy/src/app.ts"])).toBe(false)
    expect(isReferenceOnlyChange(["design-refs/toy/manifest.json", "packages/toy/scripts/adapter.ts"])).toBe(false)
    expect(isReferenceOnlyChange(["design-refs-old/toy/manifest.json"])).toBe(false)
    expect(isReferenceOnlyChange([])).toBe(false)
  }))
