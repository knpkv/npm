import { describe, expect, it } from "@effect/vitest"

import manifest from "../package.json" with { type: "json" }

describe("CodeCommit web package contract", () => {
  it("builds the shared review dependency before browser compilation", () => {
    expect(manifest.devDependencies["@knpkv/review"]).toBe("workspace:^")
    expect(manifest.scripts["test:browser"]).toContain("pnpm --filter \"@knpkv/review...\" build")
  })

  // The app is prebuilt; the views library exposes its shared runtimes as optional peers.
  it("keeps client-only libraries out of the runtime dependencies", () => {
    const runtime = Object.keys(manifest.dependencies)
    for (const clientOnly of ["@knpkv/review", "@knpkv/rly", "react-dom", "vite", "tailwindcss", "@tailwindcss/vite"]) {
      expect(runtime).not.toContain(clientOnly)
    }
  })

  it("publishes the browser library and stylesheet separately from the application", () => {
    expect(manifest.exports["./views"]).toEqual({
      types: "./src/views.ts",
      default: "./dist/views/index.js"
    })
    expect(manifest.publishConfig.exports["./views"]).toEqual({
      types: "./dist/dts/views.d.ts",
      default: "./dist/views/index.js"
    })
    expect(manifest.publishConfig.exports["."]).toEqual({
      types: "./dist/dts/index.d.ts",
      default: "./dist/index.js"
    })
    expect(manifest.exports["./views/style.css"]).toBe("./dist/views/style.css")
    expect(manifest.publishConfig.exports["./views/style.css"]).toBe("./dist/views/style.css")
    for (const script of [manifest.scripts.build, manifest.scripts.prepack]) {
      expect(script).toContain("vite build && vite build -c vite.views.config.ts")
    }
  })

  it("declares external browser runtimes as optional peers for server-only consumers", () => {
    const peers: ReadonlyArray<keyof typeof manifest.peerDependencies> = [
      "@knpkv/rly",
      "react",
      "react-dom",
      "react-router"
    ]
    for (const peer of peers) {
      expect(manifest.peerDependencies[peer]).toBe(manifest.devDependencies[peer])
      expect(manifest.peerDependenciesMeta[peer].optional).toBe(true)
    }
  })
})
