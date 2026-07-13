import { describe, expect, it } from "vitest"
import {
  type ComponentManifest,
  componentManifest,
  type ComponentRecord,
  type ModuleEntry
} from "../../component-manifest.js"
import {
  componentStyleSources,
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
  it("renders deterministically when entries and components are reordered", () => {
    const reordered: ComponentManifest = {
      ...manifestWithEntries([...componentManifest.entries].reverse()),
      components: [...componentManifest.components].reverse()
    }

    expect([...renderContract(reordered)]).toEqual([...renderContract(componentManifest)])
  })

  it("projects manifest-owned component styles in deterministic build order", () => {
    const manifest: ComponentManifest = {
      ...componentManifest,
      components: componentManifest.components.map((component): ComponentRecord => {
        if (component.name === "GlobalStyles") {
          return { ...component, styles: ["src/foundations/Zebra.module.css"] }
        }
        if (component.name === "Icon") {
          return { ...component, styles: ["src/foundations/Alpha.module.css"] }
        }
        return component
      })
    }

    expect(componentStyleSources(manifest)).toEqual([
      "src/foundations/Alpha.module.css",
      "src/foundations/Zebra.module.css",
      "src/primitives/Avatar.module.css",
      "src/primitives/Button.module.css",
      "src/primitives/Divider.module.css",
      "src/primitives/IconButton.module.css",
      "src/primitives/Skeleton.module.css",
      "src/primitives/StateLabel.module.css",
      "src/primitives/StatePanel.module.css",
      "src/primitives/Surface.module.css",
      "src/primitives/Text.module.css"
    ])
  })

  it("projects every R07 primitive stylesheet from the checked-in manifest", () => {
    expect(componentStyleSources(componentManifest)).toEqual([
      "src/primitives/Avatar.module.css",
      "src/primitives/Button.module.css",
      "src/primitives/Divider.module.css",
      "src/primitives/IconButton.module.css",
      "src/primitives/Skeleton.module.css",
      "src/primitives/StateLabel.module.css",
      "src/primitives/StatePanel.module.css",
      "src/primitives/Surface.module.css",
      "src/primitives/Text.module.css"
    ])
  })

  it("rejects component styles owned by more than one manifest record", () => {
    const manifest: ComponentManifest = {
      ...componentManifest,
      components: componentManifest.components.map((component): ComponentRecord =>
        component.name === "GlobalStyles" || component.name === "Icon"
          ? { ...component, styles: ["src/foundations/Shared.module.css"] }
          : component
      )
    }

    expect(() => componentStyleSources(manifest)).toThrow("Duplicate component style")
  })

  it("rejects duplicate entry identities", () => {
    const root = componentManifest.entries.find(({ id }) => id === "root")
    if (root === undefined) throw new Error("Fixture root entry is missing")

    expect(() => validateManifest(manifestWithEntries([...componentManifest.entries, root]))).toThrow(
      "Duplicate entry id"
    )
  })

  it("rejects identities shared by module and asset entries", () => {
    expect(() =>
      validateManifest({
        ...componentManifest,
        assets: componentManifest.assets.map((asset) => ({ ...asset, id: "tokens" }))
      })
    ).toThrow("Duplicate entry id")
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
    const files = [
      ...componentManifest.entries.map(({ source }) => source),
      ...componentManifest.assets.map(({ source }) => source),
      ...componentManifest.components.flatMap(({ source, styles }) => [source, ...styles])
    ]

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
        },
        "./styles.css": "./dist/styles.css"
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
