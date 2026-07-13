import { describe, expect, it } from "vitest"

describe("initial public entry", () => {
  it("does not invent a placeholder runtime export", async () => {
    const Rly = await import("../../src/index.js")

    expect(Object.keys(Rly)).toEqual([])
  })
})
