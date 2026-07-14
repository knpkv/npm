import { describe, expect, it } from "vitest"

import {
  type ClientBuildManifest,
  CONTROL_CENTER_BROWSER_SESSION_HYDRATOR_ENTRY,
  decodeClientBuildManifest,
  initialJavaScriptArtifacts,
  inspectClientBuildContract
} from "../../scripts/clientBuildContract.js"

const validManifest = (): ClientBuildManifest => ({
  "_client.js": {
    file: "assets/client.js",
    name: "client"
  },
  "_runtime.js": {
    file: "assets/runtime.js"
  },
  "_ui.js": {
    file: "assets/ui.js",
    imports: ["_runtime.js"]
  },
  "index.html": {
    dynamicImports: [CONTROL_CENTER_BROWSER_SESSION_HYDRATOR_ENTRY],
    file: "assets/index.js",
    imports: ["_runtime.js", "_ui.js"],
    isEntry: true
  },
  [CONTROL_CENTER_BROWSER_SESSION_HYDRATOR_ENTRY]: {
    file: "assets/BrowserSessionHydrator.js",
    imports: ["_client.js"],
    isDynamicEntry: true
  }
})

const validArtifactSizes = (): ReadonlyMap<string, number> =>
  new Map([
    ["assets/index.js", 200_000],
    ["assets/runtime.js", 8_000],
    ["assets/ui.js", 140_000]
  ])

const validMjsManifest = (): ClientBuildManifest => ({
  "_client.js": {
    file: "assets/client.mjs",
    name: "client"
  },
  "_runtime.js": {
    file: "assets/runtime.mjs"
  },
  "_ui.js": {
    file: "assets/ui.mjs",
    imports: ["_runtime.js"]
  },
  "index.html": {
    dynamicImports: [CONTROL_CENTER_BROWSER_SESSION_HYDRATOR_ENTRY],
    file: "assets/index.mjs",
    imports: ["_runtime.js", "_ui.js"],
    isEntry: true
  },
  [CONTROL_CENTER_BROWSER_SESSION_HYDRATOR_ENTRY]: {
    file: "assets/BrowserSessionHydrator.mjs",
    imports: ["_client.js"],
    isDynamicEntry: true
  }
})

describe("client build contract", () => {
  it("counts the recursive static closure once and excludes dynamic imports", () => {
    const manifest = validManifest()
    expect(initialJavaScriptArtifacts(manifest)).toEqual([
      "assets/index.js",
      "assets/runtime.js",
      "assets/ui.js"
    ])
    expect(inspectClientBuildContract(manifest, validArtifactSizes())).toEqual([])
  })

  it("rejects a static closure above the deterministic raw-byte budget", () => {
    const artifactSizes = new Map([
      ["assets/index.mjs", 200_000],
      ["assets/runtime.mjs", 8_000],
      ["assets/ui.mjs", 153_000]
    ])

    expect(inspectClientBuildContract(validMjsManifest(), artifactSizes)).toContain(
      "initial JavaScript closure is 361000 bytes; budget is 360000 bytes"
    )
  })

  it("accepts an mjs generated API client outside the initial closure", () => {
    const artifactSizes = new Map([
      ["assets/index.mjs", 200_000],
      ["assets/runtime.mjs", 8_000],
      ["assets/ui.mjs", 140_000]
    ])

    expect(initialJavaScriptArtifacts(validMjsManifest())).toEqual([
      "assets/index.mjs",
      "assets/runtime.mjs",
      "assets/ui.mjs"
    ])
    expect(inspectClientBuildContract(validMjsManifest(), artifactSizes)).toEqual([])
  })

  it("rejects eager session hydration and generated API client code", () => {
    const manifest = validManifest()
    const eagerManifest: ClientBuildManifest = {
      ...manifest,
      "index.html": {
        dynamicImports: [CONTROL_CENTER_BROWSER_SESSION_HYDRATOR_ENTRY],
        file: "assets/index.js",
        imports: ["_runtime.js", "_ui.js", CONTROL_CENTER_BROWSER_SESSION_HYDRATOR_ENTRY, "_client.js"],
        isEntry: true
      }
    }
    const artifactSizes = new Map(validArtifactSizes())
    artifactSizes.set("assets/BrowserSessionHydrator.js", 1_000)
    artifactSizes.set("assets/client.js", 10_000)

    const violations = inspectClientBuildContract(eagerManifest, artifactSizes)
    expect(violations).toContain("BrowserSessionHydrator must remain outside the initial JavaScript closure")
    expect(violations).toContain("generated API client chunk must remain outside the initial JavaScript closure")
  })

  it("rejects malformed manifests, missing chunks, and unsafe artifact paths", () => {
    expect(decodeClientBuildManifest({ "index.html": { file: 42 } })).toBeUndefined()

    const manifest: ClientBuildManifest = {
      ...validManifest(),
      "index.html": {
        dynamicImports: [CONTROL_CENTER_BROWSER_SESSION_HYDRATOR_ENTRY],
        file: "../outside.mjs",
        imports: ["_missing.js"],
        isEntry: true
      }
    }
    const violations = inspectClientBuildContract(manifest, new Map())
    expect(violations).toContain("initial JavaScript closure references missing manifest entry \"_missing.js\"")
    expect(violations).toContain("initial JavaScript artifact has an unsafe path: \"../outside.mjs\"")
  })
})
