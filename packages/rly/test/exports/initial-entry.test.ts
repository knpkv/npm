import { describe, expect, it } from "vitest"

describe("public token entry", () => {
  it("exports only browser-safe semantic token names", async () => {
    const Rly = await import("../../src/index.js")

    expect(Object.keys(Rly)).toEqual([
      "RLY_COLOR_TOKEN_NAMES",
      "RLY_MOTION_TOKEN_NAMES",
      "RLY_RADIUS_TOKEN_NAMES",
      "RLY_SPACE_TOKEN_NAMES",
      "RLY_TYPE_TOKEN_NAMES"
    ])
  })
})
