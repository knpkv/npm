import { describe, expect, it } from "vitest"
import { controlCenterBuildPhases } from "../../scripts/build-phases.js"

describe("Control Center build phases", () => {
  it("reports every build boundary and finishes with distribution validation", () => {
    expect(controlCenterBuildPhases.map(({ label }) => label)).toEqual([
      "ensure dependency artifacts",
      "validate source boundaries",
      "clean output",
      "bundle client",
      "bundle server",
      "emit server declarations",
      "validate distribution integrity"
    ])
  })

  it("rebuilds local declarations without forcing unchanged referenced projects", () => {
    const dependencies = controlCenterBuildPhases.find(({ label }) => label === "ensure dependency artifacts")
    const clean = controlCenterBuildPhases.find(({ label }) => label === "clean output")
    const declarations = controlCenterBuildPhases.find(({ label }) => label === "emit server declarations")

    expect(dependencies).toMatchObject({
      args: ["scripts/ensure-build-dependencies.ts"],
      command: "tsx"
    })
    expect(clean?.args).toContain("node_modules/.cache/tsconfig.server.tsbuildinfo")
    expect(declarations).toMatchObject({ args: ["-b", "tsconfig.server.json"], command: "tsc" })
    expect(declarations?.args).not.toContain("--force")
  })
})
