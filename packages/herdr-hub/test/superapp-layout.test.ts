import { describe, expect, it } from "@effect/vitest"
import { superappLayout } from "../src/internal/superapp-layout.js"

describe("superappLayout", () => {
  it("puts Fleet beside Connect for a host in a fleet", () => {
    expect(superappLayout(["connect", "fleet", "code", "usage", "resources", "stacks"], true)).toEqual({
      modules: ["connect", "fleet", "code", "usage", "resources", "stacks"],
      mobileModules: ["connect", "fleet", "code", "usage"],
      primaryModules: ["connect", "fleet"]
    })
  })

  it("leaves Fleet out everywhere and draws one flat group on a standalone host", () => {
    expect(superappLayout(["connect", "fleet", "code", "usage", "resources", "stacks"], false)).toEqual({
      modules: ["connect", "code", "usage", "resources", "stacks"],
      mobileModules: ["connect", "code", "usage"],
      // One flat group: without Fleet there is nothing to divide Connect from.
      primaryModules: ["connect", "code", "usage", "resources", "stacks"]
    })
  })
})
