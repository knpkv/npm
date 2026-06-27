import { describe, expect, it } from "@effect/vitest"
import {
  canonicalizeFieldValue,
  cascadingFieldValue,
  completeListValue,
  explicitClear,
  fieldValuesEqual,
  isCascadingFieldValue,
  isCompleteListValue,
  isExplicitClear,
  isOptionFieldValue,
  isUserFieldValue,
  optionFieldValue,
  userFieldValue
} from "../src/internal/sync/fieldValues.js"
import type { SyncFieldValue } from "../src/internal/sync/types.js"

describe("Jira Markdown Sync field value helpers", () => {
  it("represents explicit clear as a deliberate null field value", () => {
    const value: SyncFieldValue = explicitClear

    expect(value).toBeNull()
    expect(isExplicitClear(value)).toBe(true)
    expect(isExplicitClear("")).toBe(false)
  })

  it("represents user field values with display name and stable account id", () => {
    const value = userFieldValue("account-123", "Jane Doe")

    expect(value).toEqual({ accountId: "account-123", displayName: "Jane Doe" })
    expect(isUserFieldValue(value)).toBe(true)
    expect(isUserFieldValue({ displayName: "Jane Doe" })).toBe(false)
  })

  it("represents option field values with readable value and optional Jira option id", () => {
    expect(optionFieldValue("High")).toEqual({ value: "High" })
    expect(optionFieldValue("High", "10001")).toEqual({ id: "10001", value: "High" })
    expect(isOptionFieldValue(optionFieldValue("High", "10001"))).toBe(true)
    expect(isOptionFieldValue({ id: "10001" })).toBe(false)
  })

  it("represents cascading field values as parent and optional child options", () => {
    const parentOnly = cascadingFieldValue(optionFieldValue("Security"))
    const parentAndChild = cascadingFieldValue(
      optionFieldValue("Security", "10"),
      optionFieldValue("Customer Data", "11")
    )

    expect(parentOnly).toEqual({ parent: { value: "Security" } })
    expect(parentAndChild).toEqual({
      parent: { id: "10", value: "Security" },
      child: { id: "11", value: "Customer Data" }
    })
    expect(isCascadingFieldValue(parentAndChild)).toBe(true)
    expect(isCascadingFieldValue({ parent: { id: "10" } })).toBe(false)
  })

  it("represents list values as complete field values, not patches", () => {
    const values = completeListValue(["backend", "api", "backend"])

    expect(values).toEqual(["api", "backend", "backend"])
    expect(isCompleteListValue(values)).toBe(true)
    expect(isCompleteListValue([{ parent: optionFieldValue("A") }])).toBe(false)
  })

  it("applies canonical field order to unordered list-like values", () => {
    const first = completeListValue([
      optionFieldValue("Beta", "2"),
      userFieldValue("account-2", "Zoe"),
      optionFieldValue("Alpha", "1"),
      userFieldValue("account-1", "Amy")
    ])

    expect(first).toEqual([
      optionFieldValue("Alpha", "1"),
      optionFieldValue("Beta", "2"),
      userFieldValue("account-1", "Amy"),
      userFieldValue("account-2", "Zoe")
    ])
  })

  it("can preserve configured field order for ordered list-like values", () => {
    const value = completeListValue(["third", "first", "second"], { ordered: true })

    expect(value).toEqual(["third", "first", "second"])
    expect(canonicalizeFieldValue(value, { ordered: true })).toEqual(["third", "first", "second"])
  })

  it("compares unordered complete list values by canonical value", () => {
    const left: SyncFieldValue = ["frontend", "backend"]
    const right: SyncFieldValue = ["backend", "frontend"]

    expect(fieldValuesEqual(left, right)).toBe(true)
    expect(fieldValuesEqual(left, right, { ordered: true })).toBe(false)
  })

  it("compares explicit clears distinctly from empty complete list values", () => {
    expect(fieldValuesEqual(explicitClear, [])).toBe(false)
    expect(fieldValuesEqual([], [])).toBe(true)
  })
})
