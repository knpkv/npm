import { describe, expect, it } from "@effect/vitest"
import { getLayerType } from "../src/commands/layers.js"

describe("getLayerType", () => {
  it("routes page get to the config-free fetch layer", () => {
    expect(getLayerType(["page", "get"])).toBe("fetch")
  })

  it("keeps workspace clone on the clone layer", () => {
    expect(getLayerType(["workspace", "clone"])).toBe("clone")
  })

  it("keeps nested help on the minimal layer", () => {
    expect(getLayerType(["sync", "--help"])).toBe("minimal")
    expect(getLayerType(["page", "get", "--help"])).toBe("minimal")
    expect(getLayerType(["workspace", "clone", "--help"])).toBe("minimal")
  })

  it("routes removed legacy top-level commands to the full layer", () => {
    expect(getLayerType(["fetch"])).toBe("full")
    expect(getLayerType(["clone"])).toBe("full")
  })
})
