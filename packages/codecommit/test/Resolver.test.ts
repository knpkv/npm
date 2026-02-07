/**
 * Resolver pure-helper unit tests.
 *
 * The Resolver module converts theme JSON files into resolved Theme
 * objects. We test the pure functions (rgbaToHex, isThemeJson)
 * independently — no @opentui/core parseColor needed.
 *
 * Uses `@effect/vitest` for consistency with the rest of the codebase.
 */
import { describe, expect, it } from "vitest"
import { isThemeJson, rgbaToHex } from "../src/tui/theme/resolver-utils.js"

describe("rgbaToHex", () => {
  // Pure black (all channels 0) must produce #000000.
  it("converts black (0,0,0)", () => {
    expect(rgbaToHex({ r: 0, g: 0, b: 0 })).toBe("#000000")
  })

  // Pure white (all channels 1.0) must produce #ffffff.
  it("converts white (1,1,1)", () => {
    expect(rgbaToHex({ r: 1, g: 1, b: 1 })).toBe("#ffffff")
  })

  // Pure red channel isolates the R component.
  it("converts pure red", () => {
    expect(rgbaToHex({ r: 1, g: 0, b: 0 })).toBe("#ff0000")
  })

  // Pure green channel isolates the G component.
  it("converts pure green", () => {
    expect(rgbaToHex({ r: 0, g: 1, b: 0 })).toBe("#00ff00")
  })

  // Pure blue channel isolates the B component.
  it("converts pure blue", () => {
    expect(rgbaToHex({ r: 0, g: 0, b: 1 })).toBe("#0000ff")
  })

  // Fractional values must round correctly (0.5 * 255 = 127.5 → 128 = 0x80).
  it("handles fractional values with rounding", () => {
    expect(rgbaToHex({ r: 0.5, g: 0.5, b: 0.5 })).toBe("#808080")
  })

  // Single-digit hex values must be zero-padded (e.g., 1 → "01").
  it("zero-pads single-digit hex values", () => {
    // 1/255 ≈ 0.00392, round(0.00392 * 255) = 1 → "01"
    expect(rgbaToHex({ r: 1 / 255, g: 0, b: 0 })).toBe("#010000")
  })

  // Known theme color: Dracula purple (#bd93f9 ≈ r=0.741, g=0.576, b=0.976).
  it("converts a known Dracula purple", () => {
    const hex = rgbaToHex({ r: 189 / 255, g: 147 / 255, b: 249 / 255 })
    expect(hex).toBe("#bd93f9")
  })
})

describe("isThemeJson", () => {
  // Valid theme JSON must have a "theme" key at the top level.
  it("returns true for valid theme object", () => {
    expect(isThemeJson({ theme: { primary: "#ff0000" } })).toBe(true)
  })

  // A theme with defs section is also valid.
  it("returns true for theme with defs", () => {
    expect(isThemeJson({ defs: { accent: "#00ff00" }, theme: { primary: "accent" } })).toBe(true)
  })

  // Empty theme record is valid — resolver will use fallback colors.
  it("returns true for empty theme record", () => {
    expect(isThemeJson({ theme: {} })).toBe(true)
  })

  // null is not a valid theme JSON.
  it("returns false for null", () => {
    expect(isThemeJson(null)).toBe(false)
  })

  // Primitives are not valid theme JSON.
  it("returns false for primitives", () => {
    expect(isThemeJson("string")).toBe(false)
    expect(isThemeJson(42)).toBe(false)
    expect(isThemeJson(undefined)).toBe(false)
  })

  // Object without "theme" key fails the type guard.
  it("returns false for object without theme key", () => {
    expect(isThemeJson({ defs: {} })).toBe(false)
    expect(isThemeJson({ colors: {} })).toBe(false)
  })

  // Array is an object but not a valid theme.
  it("returns false for arrays", () => {
    expect(isThemeJson([1, 2, 3])).toBe(false)
  })
})
