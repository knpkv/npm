import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"

import { isReferenceOnlyChange } from "../scripts/product.js"
import { manifest } from "./models.js"

it.effect("only a nonempty refs-only diff exempts states from touched enforcement", () =>
  Effect.sync(() => {
    const manifests = [manifest]
    expect(isReferenceOnlyChange(["design-refs/toy/manifest.json", "design-refs/toy/fixture.json"], manifests)).toBe(
      true
    )
    expect(isReferenceOnlyChange(["design-refs/toy/manifest.json", "packages/toy/src/app.ts"], manifests)).toBe(false)
    expect(isReferenceOnlyChange(["design-refs/toy/manifest.json", "packages/toy/scripts/adapter.ts"], manifests)).toBe(
      false
    )
    expect(isReferenceOnlyChange(["design-refs-old/toy/manifest.json"], manifests)).toBe(false)
    expect(isReferenceOnlyChange([], manifests)).toBe(false)
  }))

it.effect("live adapter and inventory changes never qualify as reference-only", () =>
  Effect.sync(() => {
    const adapter = "design-refs/toy/adapter.ts"
    const refs = {
      ...manifest,
      live: { ...manifest.live, adapter },
      files: { ...manifest.files, "adapter.ts": "c".repeat(64), "screens/screen.css": "d".repeat(64) }
    }
    expect(isReferenceOnlyChange([adapter], [refs])).toBe(false)
    expect(isReferenceOnlyChange(["design-refs/toy/inventory.json"], [refs])).toBe(false)
    expect(isReferenceOnlyChange(["packages/toy/inventory.json"], [refs])).toBe(false)
    expect(isReferenceOnlyChange(["design-refs/toy/screens/screen.html", "design-refs/toy/screens/screen.css"], [refs]))
      .toBe(true)
    expect(isReferenceOnlyChange(["design-refs/toy/manifest.json"], [manifest, refs])).toBe(false)
    expect(
      isReferenceOnlyChange(["design-refs/toy/manifest.json"], [manifest, {
        ...manifest,
        live: { ...manifest.live, package: "@knpkv/toy" }
      }])
    ).toBe(false)
  }))
