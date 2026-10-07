import { describe, expect, it } from "@effect/vitest"

import manifest from "../package.json" with { type: "json" }

describe("CodeCommit web package contract", () => {
  it("builds the shared review dependency before browser compilation", () => {
    expect(manifest.devDependencies["@knpkv/review"]).toBe("workspace:^")
    expect(manifest.scripts["test:browser"]).toContain("pnpm --filter \"@knpkv/review...\" build")
  })

  // The client ships prebuilt in dist/client, so what it bundles never installs with the package.
  it("keeps client-only libraries out of the runtime dependencies", () => {
    const runtime = Object.keys(manifest.dependencies)
    for (const clientOnly of ["@knpkv/review", "@knpkv/rly", "react-dom", "vite", "tailwindcss", "@tailwindcss/vite"]) {
      expect(runtime).not.toContain(clientOnly)
    }
  })
})
