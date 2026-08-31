import { describe, expect, it } from "@effect/vitest"

import manifest from "../package.json" with { type: "json" }

describe("CodeCommit web package contract", () => {
  it("builds the shared review dependency before browser compilation", () => {
    expect(manifest.dependencies["@knpkv/review"]).toBe("workspace:^")
    expect(manifest.scripts["test:browser"]).toContain("pnpm --filter \"@knpkv/review...\" build")
  })
})
