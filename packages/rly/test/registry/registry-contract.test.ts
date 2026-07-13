import { describe, expect, it } from "vitest"
import { type ComponentManifest, componentManifest } from "../../component-manifest.js"
import { validateManifest } from "../../scripts/contract.js"
import {
  renderComponentsRegistry,
  renderRegistrySchema,
  renderSearchRegistry
} from "../../scripts/registry/registry-contract.js"
import { validateComponentsRegistry } from "../../scripts/registry/registry-validation.js"

const parseJson = (source: string): unknown => JSON.parse(source)

describe("agent registry contract", () => {
  it("renders every opted-in component deterministically with explicit tooling metadata", () => {
    const reordered: ComponentManifest = {
      ...componentManifest,
      components: [...componentManifest.components].reverse()
    }
    const rendered = renderComponentsRegistry(componentManifest)
    expect(renderComponentsRegistry(reordered)).toBe(rendered)
    expect(rendered).toContain("\"accessibility\"")
    expect(rendered).toContain("\"docs\"")
    expect(rendered).toContain("\"source\"")
    expect(rendered).toContain("\"styles\"")
    expect(rendered).toContain("\"tests\"")
    expect(rendered).not.toContain("\"runtime\"")
  })

  it("compiles the published schema and rejects missing or additional metadata", () => {
    const schema = parseJson(renderRegistrySchema())
    const components = parseJson(renderComponentsRegistry(componentManifest))
    expect(validateComponentsRegistry(schema, components)).toEqual([])
    expect(validateComponentsRegistry(schema, { package: "@knpkv/rly", schemaVersion: 1 })).not.toEqual([])
    expect(
      validateComponentsRegistry(schema, {
        components: [],
        generatedNotice: "generated",
        package: "@knpkv/rly",
        runtime: "forbidden",
        schemaVersion: 1
      })
    ).not.toEqual([])
  })

  it("requires registry metadata keys and non-empty descriptions to match exactly", () => {
    const missing: ComponentManifest = { ...componentManifest, registryMetadata: {} }
    expect(() => validateManifest(missing)).toThrow("exactly match")

    const malformed: ComponentManifest = {
      ...componentManifest,
      registryMetadata: {
        ...componentManifest.registryMetadata,
        Button: { accessibility: [""], capabilities: ["act"], purpose: "", states: ["default"] }
      }
    }
    expect(() => validateManifest(malformed)).toThrow(/purpose|accessibility/)
  })

  it("keeps search records compact and free of executable component payloads", () => {
    const search = renderSearchRegistry(componentManifest)
    expect(search).toContain("\"capabilities\"")
    expect(search).toContain("\"terms\"")
    expect(search).not.toContain("React")
    expect(search).not.toContain("\"files\"")
    expect(search).not.toContain("\"example\"")
  })
})
