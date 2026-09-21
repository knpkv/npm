import { expect, it } from "@effect/vitest"
import { resolveLocalDateTime } from "../src/client/localDateTime.js"

it("rejects a nonexistent spring time and a repeated autumn time", () => {
  expect(resolveLocalDateTime("2026-03-29T02:30:00", "Europe/Amsterdam")).toEqual({
    _tag: "Invalid",
    reason: "nonexistent"
  })
  expect(resolveLocalDateTime("2026-10-25T02:30:00", "Europe/Amsterdam")).toEqual({
    _tag: "Invalid",
    reason: "ambiguous"
  })
})

it("keeps valid instants across both transitions and in UTC", () => {
  expect(resolveLocalDateTime("2026-03-29T03:30:00", "Europe/Amsterdam")).toEqual({
    _tag: "Valid",
    instantMs: Date.parse("2026-03-29T03:30:00+02:00")
  })
  expect(resolveLocalDateTime("2026-10-25T03:30:00", "Europe/Amsterdam")).toEqual({
    _tag: "Valid",
    instantMs: Date.parse("2026-10-25T03:30:00+01:00")
  })
  expect(resolveLocalDateTime("2026-10-25T02:30:00", "UTC")).toEqual({
    _tag: "Valid",
    instantMs: Date.parse("2026-10-25T02:30:00Z")
  })
})
