import { describe, expect, it } from "@effect/vitest"
import { getLayerType } from "../src/commands/layers.js"

describe("getLayerType", () => {
  it("routes attachment upload dry-runs to the config-free minimal layer", () => {
    expect(getLayerType(["issue", "attachment", "upload", "PROJ-1", "./evidence.png", "--dry-run"])).toBe(
      "minimal"
    )
    expect(getLayerType(["issue", "attachment", "upload", "PROJ-1", "./evidence.png", "-n"])).toBe("minimal")
    expect(getLayerType(["issue", "attachment", "upload", "PROJ-1", "./evidence.png"])).toBe("full")
  })
})
