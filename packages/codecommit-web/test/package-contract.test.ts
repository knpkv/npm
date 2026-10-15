import { describe, expect, it } from "@effect/vitest"

import manifest from "../package.json" with { type: "json" }

describe("CodeCommit web package contract", () => {
  it("keeps the private write spike out of source and published package exports", () => {
    for (const exports of [manifest.exports, manifest.publishConfig.exports]) {
      expect(JSON.stringify(exports)).not.toContain("ReviewWriteSpike")
      expect(Object.keys(exports).some((name) => name.includes("*"))).toBe(false)
    }
  })
  it("declares the shared persisted and host review contracts as a runtime dependency", () => {
    expect(manifest.dependencies["@knpkv/review"]).toBe("workspace:^")
    expect(manifest.scripts["test:browser"]).toContain("pnpm --filter \"@knpkv/review...\" build")
  })

  // The app is prebuilt; the views library exposes its shared runtimes as optional peers.
  it("keeps client-only libraries out of the runtime dependencies", () => {
    const runtime = Object.keys(manifest.dependencies)
    for (const clientOnly of ["@knpkv/rly", "react-dom", "vite", "tailwindcss", "@tailwindcss/vite"]) {
      expect(runtime).not.toContain(clientOnly)
    }
  })

  it("publishes the browser library and stylesheet separately from the application", () => {
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

  /**
   * This named workspace exception keeps owner-only source aliases out of hub typechecks.
   * Remove it when the views graph uses consumer-safe imports; runtime and published paths stay fixed.
   */
  it("uses built workspace declarations for @knpkv/codecommit-web/views until owner aliases are removed", () => {
    expect(manifest.exports["./views"]).toEqual({
      types: "./dist/dts/views.d.ts",
      default: "./dist/views/index.js"
    })
    // Build-info lives outside dist; a cleared output directory still needs every declaration emitted.
    for (const script of [manifest.scripts.build, manifest.scripts.prepack]) {
      expect(script).toContain("tsc -b --force")
    }
  })

  it("publishes browser host contracts and CSS separately from the server authority factory", () => {
    expect(manifest.exports["./host"]).toEqual({
      types: "./src/host-contract.ts",
      default: "./dist/host-contract.js"
    })
    expect(manifest.publishConfig.exports["./host"]).toEqual({
      types: "./dist/dts/host-contract.d.ts",
      default: "./dist/host-contract.js"
    })
    expect(manifest.exports["./host/server"]).toEqual({
      types: "./src/server/host.ts",
      default: "./dist/server/host.js"
    })
    expect(manifest.publishConfig.exports["./host/server"]).toEqual({
      types: "./dist/dts/server/host.d.ts",
      default: "./dist/server/host.js"
    })
    expect(manifest.exports["./host/style.css"]).toBe("./dist/host-code.css")
    expect(manifest.publishConfig.exports["./host/style.css"]).toBe("./dist/host-code.css")
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
