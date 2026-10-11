import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { Fixture, Manifest, Name, RelativeFile, Waivers } from "../src/schema.js"
import { manifest, state, waiver } from "./models.js"

it.effect("decodes manifest, fixture and review waiver boundaries", () =>
  Effect.gen(function*() {
    expect(yield* Schema.decodeUnknownEffect(Manifest)(manifest)).toEqual(manifest)
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
