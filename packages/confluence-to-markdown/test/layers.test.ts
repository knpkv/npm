import { describe, expect, it } from "@effect/vitest"
import { getLayerType } from "../src/commands/layers.js"

describe("getLayerType", () => {
  it("routes fetch to the config-free fetch layer", () => {
    expect(getLayerType(["fetch"])).toBe("fetch")
  })

  it("keeps clone on the clone layer", () => {
    expect(getLayerType(["clone"])).toBe("clone")
  })
})
