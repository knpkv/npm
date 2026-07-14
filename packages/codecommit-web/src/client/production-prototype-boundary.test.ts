import { describe, expect, it } from "vitest"

import { inspectProductionPrototypeModules } from "../tooling/production-prototype-boundary.js"

describe("production prototype boundary", () => {
  it("rejects prototype modules reached through any resolved loader", () => {
    expect(
      inspectProductionPrototypeModules(
        [
          "/repo/src/client/main.tsx",
          "/repo/src/client/prototype/release.tsx",
          "/repo/src/client/prototypes/control-center/page.tsx?import",
          "/repo/src/client/prototypes/release.tsx"
        ],
        "/repo/src/client"
      )
    ).toEqual([
      "/repo/src/client/prototype/release.tsx",
      "/repo/src/client/prototypes/control-center/page.tsx",
      "/repo/src/client/prototypes/release.tsx"
    ])
  })

  it("allows unreachable fixtures and similarly named production modules", () => {
    expect(
      inspectProductionPrototypeModules(
        [
          "/repo/src/client/main.tsx",
          "/repo/src/client/prototype-tools/lazy-page.tsx",
          "/repo/src/client/components/page.tsx",
          "/other/fixtures/prototypes/release.tsx"
        ],
        "/repo/src/client/"
      )
    ).toEqual([])
  })
})
