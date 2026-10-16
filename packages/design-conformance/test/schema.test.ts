import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import {
  declaredRegions,
  Fixture,
  Inventory,
  Manifest,
  Name,
  RelativeFile,
  viewportSize,
  Waivers
} from "../src/schema.js"
import { manifest as decodedManifest, manifestInput as manifest, state, waiver } from "./models.js"

it.effect("manifest and live routes preserve query and fragment while rejecting external URLs", () =>
  Effect.gen(function*() {
    const inputs = (route: string) => ({
      manifest: { ...manifest, states: [{ ...state, route }] },
      inventory: { routes: [route], states: [{ ...state, route }] }
    })
    for (const route of ["/?range=7d&timeZone=UTC#usage/limits", "/screen.html?range=7d&timeZone=UTC#usage/limits"]) {
      const input = inputs(route)
      expect((yield* Schema.decodeUnknownEffect(Manifest)(input.manifest)).states[0]?.route).toBe(route)
      expect((yield* Schema.decodeUnknownEffect(Inventory)(input.inventory)).routes).toEqual([route])
    }
    for (
      const route of ["https://example.test/app#usage/limits", "//example.test/app", "/\\example.test/app", "/a b"]
    ) {
      const input = inputs(route)
      expect((yield* Schema.decodeUnknownEffect(Manifest)(input.manifest).pipe(Effect.exit))._tag).toBe("Failure")
      expect((yield* Schema.decodeUnknownEffect(Inventory)(input.inventory).pipe(Effect.exit))._tag).toBe("Failure")
    }
  }))

it.effect("live adapters belong to the named product package rather than reference inputs", () =>
  Effect.gen(function*() {
    expect((yield* Schema.decodeUnknownEffect(Manifest)(manifest)).live).toEqual(manifest.live)
    for (
      const adapter of ["design-refs/_fixture/adapter.ts", "packages/toy/scripts/adapter.ts", "scripts/adapter.ts"]
    ) {
      expect(
        (yield* Schema.decodeUnknownEffect(Manifest)({ ...manifest, live: { ...manifest.live, adapter } }).pipe(
          Effect.exit
        ))._tag
      ).toBe("Failure")
    }
  }))

it.effect("decodes manifest, fixture and review waiver boundaries", () =>
  Effect.gen(function*() {
    expect(yield* Schema.decodeUnknownEffect(Manifest)(manifest)).toEqual(decodedManifest)
    expect(
      yield* Schema.decodeUnknownEffect(Fixture)({ version: 1, data: { role: "reviewer", account: "123456789012" } })
    ).toEqual({ version: 1, data: { role: "reviewer", account: "123456789012" } })
    expect(yield* Schema.decodeUnknownEffect(Waivers)([waiver])).toEqual([waiver])
    expect(yield* Schema.decodeUnknownEffect(RelativeFile)("screens/workspace.dc.html")).toBe(
      "screens/workspace.dc.html"
    )
    expect((yield* Schema.decodeUnknownEffect(Name)("ambiguous--identity").pipe(Effect.exit))._tag).toBe("Failure")
  }))

it.effect("rejects path traversal, duplicate states, missing hashes and malformed grace dates", () =>
  Effect.gen(function*() {
    for (
      const invalid of [
        { ...manifest, fixture: "../fixture.json" },
        { ...manifest, states: [state, state] },
        { ...manifest, files: {} },
        {
          ...manifest,
          enforcement: { touched: "required", legacy: { mode: "report-only", until: "2026-02-30T00:00:00.000Z" } }
        },
        { ...manifest, enforcement: { touched: "report-only", legacy: "required" } }
      ]
    ) expect((yield* Schema.decodeUnknownEffect(Manifest)(invalid).pipe(Effect.exit))._tag).toBe("Failure")
  }))

it.effect("PNG states require hashed metadata for every viewport and theme", () =>
  Effect.gen(function*() {
    const png = {
      ...state,
      source: "png",
      refs: [{ viewport: 390, theme: "light", image: "shots/mobile.png", metadata: "shots/mobile.json" }],
      pixelMaxDiffRatio: 0.02
    }
    const files = {
      "fixture.json": "a".repeat(64),
      "shots/mobile.png": "b".repeat(64),
      "shots/mobile.json": "c".repeat(64)
    }
    expect((yield* Schema.decodeUnknownEffect(Manifest)({ ...manifest, states: [png], files }).pipe(Effect.exit))._tag)
      .toBe("Success")
    for (
      const invalid of [
        {
          ...manifest,
          states: [{ ...png, refs: [{ viewport: 390, theme: "light", image: "shots/mobile.png" }] }],
          files
        },
        { ...manifest, states: [{ ...png, themes: ["light", "dark"] }], files },
        { ...manifest, states: [{ ...png, pixelMaxDiffRatio: 1.01 }], files },
        { ...manifest, states: [{ ...png, refs: [...png.refs, ...png.refs] }], files }
      ]
    ) expect((yield* Schema.decodeUnknownEffect(Manifest)(invalid).pipe(Effect.exit))._tag).toBe("Failure")
  }))

it.effect("coverage and integrity cannot be waived", () =>
  Effect.gen(function*() {
    for (const rule of ["coverage", "integrity", "stale-waiver"]) {
      expect((yield* Schema.decodeUnknownEffect(Waivers)([{ ...waiver, rule }]).pipe(Effect.exit))._tag).toBe("Failure")
    }
  }))

/** The manifest boundary rejects the one region name that overwrites whole-frame artifacts. */
it.effect("region names cannot collide with reserved whole-frame artifact names", () =>
  Effect.gen(function*() {
    for (const region of ["content", "frame-content", "diff-frame", "ref", "live"]) {
      expect(
        (yield* Schema.decodeUnknownEffect(Manifest)({ ...manifest, states: [{ ...state, regions: [region] }] }))
          .states[0]?.regions
      ).toEqual([region])
    }
    for (const region of ["frame", "*", "../frame", "content/frame"]) {
      const result = yield* Schema.decodeUnknownEffect(Manifest)({
        ...manifest,
        states: [{ ...state, regions: [region] }]
      }).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (region === "frame" && result._tag === "Failure") {
        expect(result.failure._tag).toBe("SchemaError")
        expect(result.failure.message).toContain("Region name frame is reserved for whole-frame artifacts")
      }
    }
  }))

/** PNG tolerance stays useful without permitting the pixel comparison to be disabled. */
it.effect("PNG tolerance rejects fully permissive thresholds and accepts the documented starting value", () =>
  Effect.gen(function*() {
    const png = {
      ...state,
      source: "png",
      refs: [{ viewport: 390, theme: "light", image: "shots/mobile.png", metadata: "shots/mobile.json" }],
      pixelMaxDiffRatio: 0.02
    }
    const files = {
      "fixture.json": "a".repeat(64),
      "shots/mobile.png": "b".repeat(64),
      "shots/mobile.json": "c".repeat(64)
    }
    for (const pixelMaxDiffRatio of [0, 0.02, 0.05]) {
      expect(
        (yield* Schema.decodeUnknownEffect(Manifest)({ ...manifest, states: [{ ...png, pixelMaxDiffRatio }], files }))
          .states[0]
      ).toMatchObject({ pixelMaxDiffRatio })
    }
    for (const pixelMaxDiffRatio of [1, 0.050001, -0.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = yield* Schema.decodeUnknownEffect(Manifest)({
        ...manifest,
        states: [{ ...png, pixelMaxDiffRatio }],
        files
      }).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure._tag).toBe("SchemaError")
    }
    const reserved = yield* Schema.decodeUnknownEffect(Manifest)({
      ...manifest,
      states: [{ ...png, regions: ["frame"] }],
      files
    }).pipe(Effect.result)
    expect(reserved._tag).toBe("Failure")
  }))

it.effect("states may capture at phone 360 and 390 and desktop 1280, and no other width", () =>
  Effect.gen(function*() {
    const decoded = yield* Schema.decodeUnknownEffect(Manifest)({
      ...manifest,
      states: [{ ...state, viewports: [360, 390, 1280] }]
    })
    expect(decoded.states[0]?.viewports).toEqual([360, 390, 1280])
    const rejected = yield* Schema.decodeUnknownEffect(Manifest)({
      ...manifest,
      states: [{ ...state, viewports: [375] }]
    })
      .pipe(Effect.exit)
    expect(rejected._tag).toBe("Failure")
  }))

it.effect("each viewport captures at a fixed phone or desktop size", () =>
  Effect.sync(() => {
    expect(viewportSize(360)).toEqual({ width: 360, height: 780 })
    expect(viewportSize(390)).toEqual({ width: 390, height: 844 })
    expect(viewportSize(1280)).toEqual({ width: 1280, height: 800 })
  }))

it.effect("a state may declare its regions per viewport class when the phone layout differs", () =>
  Effect.gen(function*() {
    const decoded = yield* Schema.decodeUnknownEffect(Manifest)({
      ...manifest,
      states: [{ ...state, viewports: [360, 390, 1280], regions: { phone: ["list"], desktop: ["canvas", "legend"] } }]
    })
    const declared = decoded.states[0]
    if (declared === undefined) return expect.unreachable()
    expect(declaredRegions(declared, 360)).toEqual(["list"])
    expect(declaredRegions(declared, 390)).toEqual(["list"])
    expect(declaredRegions(declared, 1280)).toEqual(["canvas", "legend"])
    expect(declaredRegions(state, 1280)).toEqual(["content"])
    const empty = yield* Schema.decodeUnknownEffect(Manifest)({
      ...manifest,
      states: [{ ...state, regions: { phone: [], desktop: ["canvas"] } }]
    }).pipe(Effect.exit)
    expect(empty._tag).toBe("Failure")
  }))
