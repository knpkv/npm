import { describe, expect, it } from "vitest"
import { type ComponentManifest, componentManifest, type ModuleEntry } from "../../component-manifest.js"
import {
  findSourceDrift,
  renderContract,
  renderPackageJson,
  renderVisualCatalog,
  validateManifest
} from "../../scripts/contract.js"

const manifestWithEntries = (entries: ReadonlyArray<ModuleEntry>): ComponentManifest => ({
  ...componentManifest,
  entries
})

describe("component manifest contract", () => {
  it("renders deterministically when entries are reordered", () => {
    const reordered = manifestWithEntries([...componentManifest.entries].reverse())

    expect([...renderContract(reordered)]).toEqual([...renderContract(componentManifest)])
  })

  it("rejects duplicate entry identities", () => {
    const root = componentManifest.entries.find(({ id }) => id === "root")
    if (root === undefined) throw new Error("Fixture root entry is missing")

    expect(() => validateManifest(manifestWithEntries([...componentManifest.entries, root]))).toThrow(
      "Duplicate entry id"
    )
  })

  it("rejects aggregate cycles", () => {
    const entries = componentManifest.entries.map((entry) =>
      entry.id === "root" ? { ...entry, aggregates: ["root"] } satisfies ModuleEntry : entry
    )

    expect(() => validateManifest(manifestWithEntries(entries))).toThrow("Aggregate cycle")
  })

  it("rejects variant defaults outside their values", () => {
    const manifest: ComponentManifest = {
      ...componentManifest,
      components: [{
        category: "primitive",
        exports: [{ kind: "value", name: "Button" }],
        name: "Button",
        publicEntry: "primitives",
        registry: true,
        source: "src/primitives/button.tsx",
        status: "stable",
        styles: [],
        variants: [{ defaultValue: "quiet", name: "tone", values: ["strong"] }],
        visual: {
          story: "stories/primitives/Button.stories.tsx",
          storyId: "primitives-button",
          tests: ["test/primitives/Button.test.tsx"]
        }
      }]
    }

    expect(() => validateManifest(manifest)).toThrow("Invalid default")
  })

  it("generates named value and type exports from component records", () => {
    const manifest: ComponentManifest = {
      ...componentManifest,
      components: [{
        category: "primitive",
        exports: [
          { kind: "type", name: "ButtonProps" },
          { kind: "value", name: "Button" }
        ],
        name: "Button",
        publicEntry: "primitives",
        registry: true,
        source: "src/primitives/button.tsx",
        status: "stable",
        styles: ["src/primitives/button.css"],
        variants: [],
        visual: {
          story: "stories/primitives/Button.stories.tsx",
          storyId: "primitives-button",
          tests: ["test/primitives/Button.test.tsx"]
        }
      }]
    }

    expect(renderContract(manifest).get("src/primitives/index.ts")).toContain(
      "export { Button } from \"./button.js\"\nexport type { ButtonProps } from \"./button.js\""
    )
  })

  it("detects missing records and undeclared component sources", () => {
    const files = componentManifest.entries.map(({ source }) => source)

    expect(
      findSourceDrift(componentManifest, [
        ...files,
        "src/primitives/undeclared.tsx",
        "src/primitives/undeclared.css"
      ])
    ).toEqual({
      missing: [],
      unexpected: ["src/primitives/undeclared.css", "src/primitives/undeclared.tsx"]
    })
    expect(findSourceDrift(componentManifest, files.filter((file) => file !== "src/primitives/index.ts"))).toEqual({
      missing: ["src/primitives/index.ts"],
      unexpected: []
    })
  })

  it("replaces handwritten package exports with the manifest projection", () => {
    const rendered: unknown = JSON.parse(
      renderPackageJson(componentManifest, { name: "@knpkv/rly", exports: { ".": "stale" } })
    )

    expect(rendered).toMatchObject({
      name: "@knpkv/rly",
      exports: {
        ".": {
          import: "./dist/index.js",
          types: "./dist/dts/index.d.ts"
        }
      }
    })
  })

  it("projects exact repository paths for the fail-safe visual classifier", () => {
    const manifest: ComponentManifest = {
      ...componentManifest,
      components: [{
        category: "primitive",
        exports: [{ kind: "value", name: "Button" }],
        name: "Button",
        publicEntry: "primitives",
        registry: true,
        source: "src/primitives/Button.tsx",
        status: "stable",
        styles: ["src/primitives/Button.module.css"],
        variants: [],
        visual: {
          story: "stories/primitives/Button.stories.tsx",
          storyId: "primitives-button",
          tests: ["test/primitives/Button.test.tsx"]
        }
      }]
    }

    expect(JSON.parse(renderVisualCatalog(manifest))).toEqual({
      components: [{
        name: "Button",
        paths: {
          source: "packages/rly/src/primitives/Button.tsx",
          story: "packages/rly/stories/primitives/Button.stories.tsx",
          styles: ["packages/rly/src/primitives/Button.module.css"],
          tests: ["packages/rly/test/primitives/Button.test.tsx"]
        },
        storyId: "primitives-button"
      }],
      schemaVersion: 1
    })
  })
})
