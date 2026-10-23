import { expect, it } from "@effect/vitest"
import { Result } from "effect"
import { canonicalUsageSelection } from "../src/selection.js"

it("keeps a Usage link's range, named zone and host, with explicit defaults for a bare page", () => {
  const selected = canonicalUsageSelection(
    new URLSearchParams("range=30d&timeZone=Europe%2FAmsterdam&host=ALPHA"),
    "UTC"
  )
  if (Result.isFailure(selected)) return expect.unreachable()
  expect(selected.success.selection).toEqual({ range: "30d", timeZone: "Europe/Amsterdam", host: "ALPHA" })
  expect(selected.success.search.toString()).toBe("range=30d&timeZone=Europe%2FAmsterdam&host=ALPHA")
  expect(selected.success.repaired).toBe(false)
  const bare = canonicalUsageSelection(new URLSearchParams(), "Europe/Amsterdam")
  if (Result.isFailure(bare)) return expect.unreachable()
  expect(bare.success.selection).toEqual({ range: "7d", timeZone: "Europe/Amsterdam", host: null })
  expect(bare.success.search.toString()).toBe("range=7d&timeZone=Europe%2FAmsterdam")
})

it.each([
  ["range=90d", "7d"],
  ["range=24h&range=30d", "7d"],
  ["range=24h&timeZone=Not/AZone", "24h"],
  ["timeZone=UTC%20limits", "7d"],
  ["timeZone=UTC&timeZone=Europe%2FAmsterdam", "7d"],
  ["host=ALPHA&host=cedar", "7d"],
  ["host=%2Fprivate%2Fstore", "7d"],
  ["range=30d&unexpected=selector", "30d"]
])("repairs invalid or ambiguous fields while keeping valid ones: %s", (query, range) => {
  const result = canonicalUsageSelection(new URLSearchParams(query), "Europe/Amsterdam")
  if (Result.isFailure(result)) return expect.unreachable()
  expect(result.success).toMatchObject({
    selection: { range, timeZone: "Europe/Amsterdam", host: null },
    repaired: true
  })
  expect(result.success.search.toString()).toBe(`range=${range}&timeZone=Europe%2FAmsterdam`)
})

it("refuses an invalid caller-supplied default zone rather than silently changing the calendar", () => {
  expect(canonicalUsageSelection(new URLSearchParams(), "Not/AZone")).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "UsageSelectionError", reason: "invalid_default_time_zone" }
  })
})

it("keeps valid selectors when repairing one invalid field or dropping another module's selectors", () => {
  for (
    const query of [
      "range=30d&timeZone=Europe%2FAmsterdam&host=%2Fprivate%2Fstore",
      "range=30d&timeZone=Europe%2FAmsterdam&approvalHost=ALPHA&approvalJob=job-1"
    ]
  ) {
    const result = canonicalUsageSelection(new URLSearchParams(query), "UTC")
    if (Result.isFailure(result)) return expect.unreachable()
    expect(result.success.selection).toEqual({ range: "30d", timeZone: "Europe/Amsterdam", host: null })
    expect(result.success.repaired).toBe(true)
    expect(result.success.search.toString()).toBe("range=30d&timeZone=Europe%2FAmsterdam")
  }
})
