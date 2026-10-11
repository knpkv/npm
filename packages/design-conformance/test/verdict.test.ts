import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"

import { verdict, waiverMatches } from "../src/verdict.js"
import { failure, identity, manifest, waiver } from "./models.js"

const shot = { ...identity, touched: false, artifacts: {} }
const before = "2026-10-17T23:59:59.999Z"
const after = "2026-10-18T00:00:00.000Z"

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
