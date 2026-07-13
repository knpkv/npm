import * as TypeScript from "typescript"
import { describe, expect, it } from "vitest"
import { componentManifest } from "../../component-manifest.js"
import { findRegistrySourceFailures } from "../../scripts/registry/source-validation.js"

const packageRoot = new URL("../../", import.meta.url).pathname

const registryFiles = (): ReadonlyMap<string, string> => {
  const paths = new Set(
    componentManifest.components.flatMap((component) => [
      component.source,
      ...component.styles,
      component.visual.story,
      ...component.visual.tests
    ])
  )
  const files = new Map<string, string>()
  for (const path of paths) {
    const source = TypeScript.sys.readFile(`${packageRoot}${path}`)
    if (source !== undefined) files.set(path, source)
  }
  return files
}

describe("registry source validation", () => {
  it("accepts complete source, style, story, test, docs, a11y, and variant coverage", () => {
    expect(findRegistrySourceFailures(componentManifest, registryFiles())).toEqual([])
  })

  it("fails closed for every required component artifact", () => {
    const files = new Map(registryFiles())
    files.delete("src/primitives/Button.tsx")
    files.delete("src/primitives/Button.module.css")
    files.delete("test/primitives/Button.test.tsx")
    files.delete("stories/primitives/Button.stories.tsx")
    expect(findRegistrySourceFailures(componentManifest, files).join("\n")).toMatch(
      /missing source.*missing story.*missing style.*missing test/s
    )
  })

  it("rejects missing docs, accessibility interaction, and declared variant coverage", () => {
    const files = new Map(registryFiles())
    const storyPath = "stories/primitives/Button.stories.tsx"
    const story = files.get(storyPath)
    if (story === undefined) throw new Error("Button story fixture is missing")
    files.set(
      storyPath,
      story.replace("tags: [\"autodocs\"]", "tags: []").replace("play:", "visit:").replaceAll(
        "\"principal\"",
        "\"absent\""
      ) + "\nconst decoy = { play: true }\n"
    )
    expect(findRegistrySourceFailures(componentManifest, files).join("\n")).toMatch(/a11y|docs|principal/)
  })

  it("does not credit sibling or hidden stories to the referenced navigable story", () => {
    const files = new Map(registryFiles())
    const storyPath = "stories/diff/DiffCodeView.stories.tsx"
    const story = files.get(storyPath)
    if (story === undefined) throw new Error("DiffCodeView story fixture is missing")
    files.set(storyPath, story.replace("export const StackedWrapped", "const StackedWrapped"))
    expect(findRegistrySourceFailures(componentManifest, files)).toEqual(
      expect.arrayContaining([
        "story diff-diffcodeview--workbench does not cover mode=stacked",
        "story diff-diffcodeview--workbench does not cover state=strict",
        "story diff-diffcodeview--workbench does not cover virtualization=strict"
      ])
    )
  })

  it("rejects undeclared browser dependencies, host APIs, manifest dependencies, and relative escapes", () => {
    const files = new Map(registryFiles())
    files.set(
      "src/forbidden.ts",
      "import \"@aws-sdk/client-codecommit\"\nimport \"react-router-dom\"\nimport \"../../../control-center/src/index.js\"\nfetch('/service')\n"
    )
    files.set("component-manifest.ts", "import \"@knpkv/jira-api-client\"\n")
    expect(findRegistrySourceFailures(componentManifest, files)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("forbidden application import @knpkv/jira-api-client"),
        expect.stringContaining("forbidden application import @aws-sdk/client-codecommit"),
        expect.stringContaining("forbidden browser host API"),
        expect.stringContaining("undeclared browser dependency react-router-dom"),
        expect.stringContaining("relative import escapes rly package")
      ])
    )
  })
})
