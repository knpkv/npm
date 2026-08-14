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

  it("routes attachment upload dry-runs to the config-free minimal layer", () => {
    expect(getLayerType(["page", "attachment", "upload", "123", "./diagram.svg", "--dry-run"])).toBe("minimal")
    expect(getLayerType(["page", "attachment", "upload", "123", "./diagram.svg", "-n"])).toBe("minimal")
    expect(getLayerType(["page", "attachment", "upload", "123", "./diagram.svg"])).toBe("full")
  })

  // These talk to the site directly, so they must not require a `.confluence/`
  // workspace: AppLayer reads `<cwd>/.confluence/config.json` while it is being
  // built, which aborts the command before its handler ever runs.
  it("routes folder and search to the config-free fetch layer", () => {
    expect(getLayerType(["folder", "get"])).toBe("fetch")
    expect(getLayerType(["folder", "children"])).toBe("fetch")
    expect(getLayerType(["folder", "create"])).toBe("fetch")
    expect(getLayerType(["search"])).toBe("fetch")
  })

  it("routes removed legacy top-level commands to the full layer", () => {
    expect(getLayerType(["fetch"])).toBe("full")
    expect(getLayerType(["clone"])).toBe("full")
  })
})
