import * as TypeScript from "typescript"
import { describe, expect, it } from "vitest"
import { type ComponentManifest, componentManifest } from "../../component-manifest.js"
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

interface FocusedRegistry {
  readonly manifest: ComponentManifest
  readonly files: ReadonlyMap<string, string>
}

/** One component's manifest and files, so a mutation check scans one component, not the registry. */
const focused = (name: string): FocusedRegistry => {
  const component = componentManifest.components.find((candidate) => candidate.name === name)
  if (component === undefined) throw new Error(`${name} is not in the manifest`)
  const all = registryFiles()
  const paths = [component.source, ...component.styles, component.visual.story, ...component.visual.tests]
  return {
    files: new Map(
      paths.flatMap((path): ReadonlyArray<readonly [string, string]> => {
        const source = all.get(path)
        return source === undefined ? [] : [[path, source]]
      })
    ),
    manifest: { ...componentManifest, components: [component] }
  }
}

const withDiffCodeCoverageStory = (storyId: string): ComponentManifest => ({
  ...componentManifest,
  components: componentManifest.components.map((component) =>
    component.name === "DiffCodeView"
      ? { ...component, visual: { ...component.visual, coverageStoryIds: [storyId] } }
      : component
  )
})

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

  it("rejects manifest variants that drift from the source's defineVariants", () => {
    const manifest: ComponentManifest = {
      ...componentManifest,
      components: componentManifest.components.map((component) =>
        component.name === "Button"
          ? {
            ...component,
            variants: component.variants.map((variant) =>
              variant.name === "size"
                ? { ...variant, defaultValue: "default", values: ["compact", "default", "principal"] }
                : variant
            )
          }
          : component
      )
    }
    const failures = findRegistrySourceFailures(manifest, registryFiles())
    expect(failures).toContain(
      "variant Button.size lists compact|default|principal but source declares dense|compact|default|principal"
    )
    expect(failures).toContain("variant Button.size defaults to default but source defaults to dense")
  })

  it("fails closed on duplicated, unlisted or unreadable variant declarations", () => {
    const { files, manifest } = focused("Button")
    const path = "src/primitives/Button.tsx"
    const source = files.get(path)
    if (source === undefined) throw new Error("Button source fixture is missing")
    const mutate = (next: string) => findRegistrySourceFailures(manifest, new Map([...files, [path, next]]))
    expect(
      mutate(
        `${source}\nexport const RLY_EXTRA_VARIANTS = defineVariants({ size: { dense: { className: "x", purpose: "x", tokens: [] } } })\n`
      )
    ).toContain(
      "variant Button.size is declared 2 times in src/primitives/Button.tsx, expected once"
    )
    expect(
      mutate(
        `${source}\nexport const RLY_EXTRA_VARIANTS = defineVariants({ tone: { calm: { className: "x", purpose: "x", tokens: [] } } })\n`
      )
    ).toContain(
      "variant Button.tone is declared in source but missing from the manifest"
    )
    expect(mutate(source.replace("size = RLY_BUTTON_DEFAULT_VARIANTS.size", "size = RLY_ICON_DEFAULT_VARIANTS.size")))
      .toContain(
        "component Button destructures size from RLY_ICON_DEFAULT_VARIANTS.size, not its own default"
      )
    // A parenthesized catalog is read through; one built some other way fails instead of being skipped.
    const parenthesized = source.replace(
      "RLY_BUTTON_VARIANTS = defineVariants({",
      "RLY_BUTTON_VARIANTS = defineVariants(({"
    )
    expect(parenthesized).not.toBe(source)
    expect(
      mutate(
        parenthesized.replace(
          "\n})\nexport const RLY_BUTTON_DEFAULT_VARIANTS",
          "\n}))\nexport const RLY_BUTTON_DEFAULT_VARIANTS"
        ).replace("    dense: {\n      className: style(\"dense\")", "    roomy: {\n      className: style(\"dense\")")
      )
    ).toContain(
      "variant Button.size lists dense|compact|default|principal but source declares roomy|compact|default|principal"
    )
    expect(
      mutate(
        source.replace(
          "RLY_BUTTON_VARIANTS = defineVariants({",
          "RLY_BUTTON_VARIANTS = defineVariants(buttonCatalog, {"
        )
      )
    ).toContain(
      "component Button declares RLY_BUTTON_VARIANTS in a form the registry cannot read"
    )
    expect(mutate(source.replace("size: \"dense\" })", "size: (`dense`) })"))).toContain(
      "variant Button.size has a source default the registry cannot read; write it as a string"
    )
    expect(mutate(source.replace("  size = RLY_BUTTON_DEFAULT_VARIANTS.size,\n", "  size,\n"))).toContain(
      "component Button never falls back to its size default when the prop is omitted"
    )
    expect(mutate(source.replace("size = RLY_BUTTON_DEFAULT_VARIANTS.size", "size = pickSize()"))).toContain(
      "component Button destructures size = pickSize(), which the registry cannot check"
    )
    // An axis built indirectly, a spread value, or a spread axis hides values; each fails instead of vanishing.
    expect(mutate(
      source.replace("  size: {\n    dense: {", "  size: sizes({\n    dense: {").replace(
        "      tokens: [\"control-height-principal\", \"space-8\"]\n    }\n  }\n})",
        "      tokens: [\"control-height-principal\", \"space-8\"]\n    }\n  })\n})"
      )
    )).toContain("component Button declares RLY_BUTTON_VARIANTS.size in a form the registry cannot read")
    expect(mutate(source.replace("  size: {\n    dense: {", "  size: {\n    ...roomy,\n    dense: {"))).toContain(
      "component Button declares RLY_BUTTON_VARIANTS.size (...roomy) in a form the registry cannot read"
    )
    expect(mutate(source.replace("  size: {\n    dense: {", "  ...axes,\n  size: {\n    dense: {"))).toContain(
      "component Button declares RLY_BUTTON_VARIANTS (...axes) in a form the registry cannot read"
    )
  })

  it("reads fallbacks only from the component's own implementation", () => {
    const { files, manifest } = focused("Button")
    const path = "src/primitives/Button.tsx"
    const source = files.get(path)
    if (source === undefined) throw new Error("Button source fixture is missing")
    const mutate = (next: string) => findRegistrySourceFailures(manifest, new Map([...files, [path, next]]))
    const helper = (fallback: string) =>
      `\nconst sizeOf = ({ size = ${fallback} }: { readonly size?: string }) => size\n`
    // A same-named helper neither stands in for a missing fallback nor rejects a correct one.
    expect(
      mutate(
        source.replace("  size = RLY_BUTTON_DEFAULT_VARIANTS.size,\n", "  size,\n") +
          helper("RLY_BUTTON_DEFAULT_VARIANTS.size")
      )
    ).toContain("component Button never falls back to its size default when the prop is omitted")
    expect(mutate(source + helper("\"principal\""))).toEqual([])
    // A nested helper inside the component counts no more than one outside it.
    const nested = (fallback: string) =>
      `\n  const pick = ({ size = ${fallback} }: { readonly size?: string }) => size\n  void pick\n`
    const head = "}: ButtonProps): ReactElement => {"
    expect(source).toContain(head)
    const withNested = (base: string, fallback: string) => base.replace(head, head + nested(fallback))
    expect(
      mutate(
        withNested(
          source.replace("  size = RLY_BUTTON_DEFAULT_VARIANTS.size,\n", "  size,\n"),
          "RLY_BUTTON_DEFAULT_VARIANTS.size"
        )
      )
    ).toContain("component Button never falls back to its size default when the prop is omitted")
    expect(mutate(withNested(source, "\"principal\""))).toEqual([])
    // An aliased props binding still counts.
    expect(mutate(source.replace("size = RLY_BUTTON_DEFAULT_VARIANTS.size", "size: chosen = \"principal\"")))
      .toContain("component Button destructures size = \"principal\" but its declared default is dense")
    // The focused fixture is clean, and an implementation the registry cannot locate fails closed.
    expect(findRegistrySourceFailures(manifest, files)).toEqual([])
    expect(mutate(source.replace("export const Button = (", "export const Button = makeButton(), unused = (")))
      .toContain(
        "component Button has no implementation the registry can find in src/primitives/Button.tsx"
      )
  })

  it("requires a forwarded axis a component defaults to be listed in its manifest variants", () => {
    const files = registryFiles()
    const pick = (name: string) => {
      const component = componentManifest.components.find((candidate) => candidate.name === name)
      if (component === undefined) throw new Error(`${name} is not in the manifest`)
      return component
    }
    const themeSelect = pick("ThemeSelect")
    const manifest = (withSize: boolean, sizeDefault = "dense"): ComponentManifest => ({
      ...componentManifest,
      components: componentManifest.components
        .filter((component) => component.name === "ThemeSelect" || component.name === "Select")
        .map((component) =>
          component.name !== "ThemeSelect"
            ? component
            : withSize
            ? {
              ...component,
              variants: component.variants.map((variant) =>
                variant.name === "size" ? { ...variant, defaultValue: sizeDefault } : variant
              )
            }
            : { ...component, variants: component.variants.filter((variant) => variant.name !== "size") }
        )
    })
    const focusedFiles = new Map(
      [themeSelect, pick("Select")].flatMap((component) =>
        [component.source, ...component.styles, component.visual.story, ...component.visual.tests].flatMap(
          (path): ReadonlyArray<readonly [string, string]> => {
            const source = files.get(path)
            return source === undefined ? [] : [[path, source]]
          }
        )
      )
    )
    expect(findRegistrySourceFailures(manifest(true), focusedFiles)).toEqual([])
    expect(
      findRegistrySourceFailures(manifest(false), focusedFiles)
    ).toContain("component ThemeSelect defaults its size prop but the manifest lists no size variant")
    // A listed forwarded axis must agree with the owner it forwards from.
    expect(findRegistrySourceFailures(manifest(true, "compact"), focusedFiles)).toContain(
      "variant ThemeSelect.size defaults to compact but its owner RLY_SELECT_DEFAULT_VARIANTS defaults to dense"
    )
    // A wrapped literal is read through; a computed default fails closed.
    const themePath = themeSelect.source
    const themeSource = focusedFiles.get(themePath) ?? ""
    const withFallback = (fallback: string) =>
      new Map([...focusedFiles, [
        themePath,
        themeSource.replace("size = RLY_SELECT_DEFAULT_VARIANTS.size", `size = ${fallback}`)
      ]])
    expect(findRegistrySourceFailures(manifest(true), withFallback("(\"compact\" as const)"))).toContain(
      "variant ThemeSelect.size defaults to dense but source forwards compact"
    )
    expect(findRegistrySourceFailures(manifest(true), withFallback("pickSize()"))).toContain(
      "component ThemeSelect forwards size = pickSize(), which the registry cannot check"
    )
  })

  it("rejects a destructured fallback that disagrees with the declared default", () => {
    const files = new Map(registryFiles())
    const path = "src/primitives/ToggleGroup.tsx"
    const source = files.get(path)
    if (source === undefined) throw new Error("ToggleGroup source fixture is missing")
    files.set(path, source.replace("size = RLY_TOGGLE_GROUP_DEFAULT_VARIANTS.size,", "size = \"default\","))
    expect(findRegistrySourceFailures(componentManifest, files)).toContain(
      "component ToggleGroup destructures size = \"default\" but its declared default is dense"
    )
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

  it("does not credit story names or unrelated object-key bindings as rendered coverage", () => {
    const storyPath = "stories/diff/DiffCodeView.stories.tsx"
    for (
      const decoy of [
        `export const StackedStrict: Story = { args: {}, play: async () => undefined }`,
        `const args = { mode: "stacked", virtualization: "strict" }\nexport const CoverageDecoy: Story = { args: {}, play: async () => undefined }`
      ]
    ) {
      const files = new Map(registryFiles())
      const story = files.get(storyPath)
      if (story === undefined) throw new Error("DiffCodeView story fixture is missing")
      files.set(storyPath, `${story}\n${decoy}\n`)
      const storyId = decoy.includes("StackedStrict")
        ? "diff-diffcodeview--stacked-strict"
        : "diff-diffcodeview--coverage-decoy"
      expect(findRegistrySourceFailures(withDiffCodeCoverageStory(storyId), files)).toEqual(
        expect.arrayContaining([
          "story diff-diffcodeview--workbench does not cover mode=stacked",
          "story diff-diffcodeview--workbench does not cover virtualization=strict"
        ])
      )
    }
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
