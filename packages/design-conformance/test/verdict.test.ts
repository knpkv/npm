import { expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { Manifest } from "../src/schema.js"
import { verdict, waiverMatches } from "../src/verdict.js"
import { failure, identity, manifest, manifestInput, waiver } from "./models.js"

const shot = { ...identity, touched: false, artifacts: {} }
const before = DateTime.makeUnsafe("2026-10-17T23:59:59.999Z")
const after = DateTime.makeUnsafe("2026-10-18T00:00:00.000Z")

it.effect("unchanged legacy drift is reported before expiry and required at expiry", () =>
  Effect.sync(() => {
    const report = verdict(manifest, [failure], [], [shot], before)
    expect(report.passed).toBe(true)
    expect(report.findings[0]?.disposition).toBe("report-only")
    expect(verdict(manifest, [failure], [], [shot], after).passed).toBe(false)
  }))

it.effect("a change in one shot makes every shot in that state required", () =>
  Effect.sync(() => {
    const result = verdict(manifest, [failure], [], [shot, { ...shot, viewport: 1280, touched: true }], before)
    expect(result.passed).toBe(false)
    expect(result.shots.every((shot) => shot.touched)).toBe(true)
  }))

it.effect("waivers match exact failures and retain optional viewport/theme scope", () =>
  Effect.sync(() => {
    expect(waiverMatches(waiver, failure)).toBe(true)
    expect(waiverMatches({ ...waiver, viewport: 1280 }, failure)).toBe(false)
    expect(waiverMatches({ ...waiver, theme: "dark" }, failure)).toBe(false)
    expect(waiverMatches({ ...waiver, region: "*" }, failure)).toBe(false)
    const result = verdict(manifest, [failure], [waiver], [{ ...shot, touched: true }], after)
    expect(result.passed).toBe(true)
    expect(result.findings[0]).toMatchObject({ disposition: "waived", waiver: 0 })
  }))

it.effect("stale waivers and coverage fail during grace", () =>
  Effect.sync(() => {
    expect(verdict(manifest, [], [waiver], [shot], before).findings[0]).toMatchObject({
      rule: "stale-waiver",
      disposition: "required"
    })
    expect(verdict(manifest, [{ ...failure, rule: "coverage" }], [], [shot], before).passed).toBe(false)
    expect(
      verdict({ ...manifest, enforcement: { touched: "required", legacy: "required" } }, [failure], [], [shot], before)
        .passed
    ).toBe(false)
  }))

// The offset sorts after UTC strings but represents an earlier instant.
it.effect("offset grace expires at its UTC instant, not its lexical position", () =>
  Effect.gen(function*() {
    const offset = yield* Schema.decodeUnknownEffect(Manifest)({
      ...manifestInput,
      enforcement: { touched: "required", legacy: { mode: "report-only", until: "2026-10-18T02:00:00.000+02:00" } }
    })
    expect(verdict(offset, [failure], [], [shot], before).findings[0]?.disposition).toBe("report-only")
    expect(verdict(offset, [failure], [], [shot], after).findings[0]?.disposition).toBe("required")
    const encoded = yield* Schema.encodeEffect(Manifest)(offset)
    expect(encoded.enforcement.legacy).toEqual({ mode: "report-only", until: "2026-10-18T00:00:00.000Z" })
  }))

it.effect("date-only grace decodes to UTC midnight and expires there", () =>
  Effect.gen(function*() {
    const date = yield* Schema.decodeUnknownEffect(Manifest)({
      ...manifestInput,
      enforcement: { touched: "required", legacy: { mode: "report-only", until: "2026-10-18" } }
    })
    expect(verdict(date, [failure], [], [shot], before).passed).toBe(true)
    expect(verdict(date, [failure], [], [shot], after).passed).toBe(false)
  }))
