import { describe, expect, it } from "vitest"
import { packagesMissingPublishedArtifacts, publishedArtifactPaths } from "../../scripts/workspace-artifacts.js"

describe("workspace package artifacts", () => {
  it("collects concrete package entry files and ignores wildcard templates", () => {
    expect(
      publishedArtifactPaths({
        bin: { tool: "./dist/bin.js" },
        exports: {
          ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
          "./styles.css": "./dist/styles.css",
          "./*.js": "./src/*.ts"
        },
        main: "./dist/index.js",
        name: "@example/package",
        types: "./dist/index.d.ts"
      })
    ).toEqual(["dist/bin.js", "dist/index.d.ts", "dist/index.js", "dist/styles.css"])
  })

  it("builds only packages whose declared entry artifacts are missing", () => {
    const existing = new Set(["/workspace/ready/dist/index.js", "/workspace/ready/dist/index.d.ts"])
    const missing = packagesMissingPublishedArtifacts(
      [
        {
          artifactPaths: ["dist/index.js", "dist/index.d.ts"],
          name: "@example/ready",
          packageRoot: "/workspace/ready"
        },
        {
          artifactPaths: ["dist/index.js", "dist/index.d.ts"],
          name: "@example/missing",
          packageRoot: "/workspace/missing"
        },
        { artifactPaths: [], name: "@example/source", packageRoot: "/workspace/source" }
      ],
      (path) => existing.has(path),
      (root, artifact) => `${root}/${artifact}`
    )

    expect(missing).toEqual(["@example/missing"])
  })
})
