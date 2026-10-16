import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"

import { baseCaptureMode, isReferenceOnlyChange } from "../scripts/product.js"
import { coverageFailures, shotKey } from "../src/compare.js"
import type { Manifest } from "../src/schema.js"
import { identity, manifest, state } from "./models.js"

it.effect("existing product package moves cannot discard previously captured deleted states", () =>
  Effect.gen(function*() {
    const moved = { ...manifest, live: { package: "@knpkv/moved", adapter: "packages/moved/scripts/adapter.ts" } }
    const deleted = { ...identity, state: "removed" }
    const base = { ...manifest, states: [...manifest.states, { ...state, state: deleted.state }] }
    const inventory = { routes: [state.route], states: [state] }
    const captured = new Set([shotKey(identity)])
    expect(coverageFailures(moved, inventory, captured, [])).toEqual([])
    expect(coverageFailures(moved, inventory, captured, [identity, deleted])).toMatchObject([{
      ...deleted,
      rule: "coverage",
      detail: "Previously captured live state was removed"
    }])
    for (const packageExists of [true, false]) {
      expect(yield* baseCaptureMode(moved, [base], packageExists).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "RunnerFailure",
          detail:
            "Existing product toy changed live.package from @knpkv/design-conformance to @knpkv/moved; package migrations must preserve the previous live inventory"
        }
      })
    }
  }))

it.effect("an existing product with its unchanged package missing on base cannot become new", () =>
  Effect.gen(function*() {
    expect(yield* baseCaptureMode(manifest, [manifest], false).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "RunnerFailure",
        detail:
          "Existing product toy has no merge-base package @knpkv/design-conformance; cannot discard its previous live inventory"
      }
    })
  }))

it.effect("new products may lack a base package while available legacy apps still get captured", () =>
  Effect.gen(function*() {
    expect(yield* baseCaptureMode(manifest, [], false)).toBe("new")
    expect(yield* baseCaptureMode(manifest, [{ ...manifest, product: "other" }], false)).toBe("new")
    expect(yield* baseCaptureMode(manifest, [], true)).toBe("capture")
    expect(yield* baseCaptureMode(manifest, [manifest], true)).toBe("capture")
  }))

it.effect("the first implementation after a refs-only base is a new product, even before its package existed", () =>
  Effect.gen(function*() {
    const refsOnly: Manifest = {
      ...manifest,
      states: manifest.states.map((designed) => ({ ...designed, status: "designed" }))
    }
    expect(yield* baseCaptureMode(manifest, [refsOnly], false)).toBe("new")
    expect(yield* baseCaptureMode(manifest, [refsOnly], true)).toBe("capture")
    // A previously implemented product still keeps its inventory.
    expect((yield* baseCaptureMode(manifest, [manifest], false).pipe(Effect.result))._tag).toBe("Failure")
  }))

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
