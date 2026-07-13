import { describe, expect, it } from "vitest"
import componentManifestSource from "../../component-manifest.ts?raw"
import registryMetadataSource from "../../manifest/registry-metadata.ts?raw"
import { createScaffoldComponentPlan, type ScaffoldComponentOptions } from "../../scripts/scaffolder.js"

describe("component scaffolder", () => {
  it("plans source, style, navigable story, DOM test, metadata, and public manifest entry together", () => {
    const plan = createScaffoldComponentPlan({
      category: "primitive",
      existingFiles: new Set(),
      manifestSource: componentManifestSource,
      name: "SignalCard",
      purpose: "Present one explicit delivery signal state",
      registryMetadataSource
    })
    expect([...plan.files.keys()].sort()).toEqual([
      "src/primitives/SignalCard.module.css",
      "src/primitives/SignalCard.tsx",
      "stories/primitives/SignalCard.stories.tsx",
      "test/primitives/SignalCard.test.tsx"
    ])
    expect(plan.manifestSource).toContain("name: \"SignalCard\"")
    expect(plan.registryMetadataSource).toContain("SignalCard: registryMetadata")
    expect(plan.files.get("stories/primitives/SignalCard.stories.tsx")).toContain("tags: [\"autodocs\"]")
    expect(plan.files.get("stories/primitives/SignalCard.stories.tsx")).toContain("RLY_SIGNAL_CARD_STATES.map")
    expect(plan.files.get("test/primitives/SignalCard.test.tsx")).toContain("role=\"alert\"")
    expect(plan.files.get("test/primitives/SignalCard.test.tsx")).toContain("toHaveLength(4)")
  })

  it("refuses invalid names, empty intent, duplicate records, and file overwrites before writing", () => {
    const base: ScaffoldComponentOptions = {
      category: "primitive",
      existingFiles: new Set<string>(),
      manifestSource: componentManifestSource,
      name: "SignalCard",
      purpose: "Present one explicit delivery signal state",
      registryMetadataSource
    }
    expect(() => createScaffoldComponentPlan({ ...base, name: "signal-card" })).toThrow("PascalCase")
    expect(componentManifestSource).toBe(base.manifestSource)
    expect(registryMetadataSource).toBe(base.registryMetadataSource)
    expect(() => createScaffoldComponentPlan({ ...base, purpose: "short" })).toThrow("purpose")
    expect(componentManifestSource).toBe(base.manifestSource)
    expect(() => createScaffoldComponentPlan({ ...base, name: "Button" })).toThrow("already exists")
    expect(componentManifestSource).toBe(base.manifestSource)
    expect(() =>
      createScaffoldComponentPlan({
        ...base,
        existingFiles: new Set(["src/primitives/SignalCard.tsx"])
      })
    ).toThrow("overwrite")
    expect(componentManifestSource).toBe(base.manifestSource)
  })
})
