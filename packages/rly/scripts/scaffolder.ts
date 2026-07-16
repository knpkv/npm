import type { ComponentRecord, RegistryMetadata } from "../component-manifest.js"

/** Supported public layers for a scaffolded rly component. */
export type ScaffoldCategory = "foundation" | "primitive" | "pattern" | "diff"

/** Inputs required to create a complete, non-empty component slice. */
export interface ScaffoldComponentOptions {
  readonly category: ScaffoldCategory
  readonly existingFiles: ReadonlySet<string>
  readonly manifestSource: string
  readonly name: string
  readonly purpose: string
  readonly registryMetadataSource: string
}

/** Complete file and manifest mutation plan produced before any I/O occurs. */
export interface ScaffoldComponentPlan {
  readonly component: ComponentRecord
  readonly files: ReadonlyMap<string, string>
  readonly manifestSource: string
  readonly metadata: RegistryMetadata
  readonly registryMetadataSource: string
}

const METADATA_MARKER = "// scaffold:registry-metadata:insert"
const COMPONENT_MARKER = "// scaffold:components:insert"

const markerLine = (marker: string): RegExp => new RegExp(`^\\s*${marker}$`, "m")

const categoryDirectory = (category: ScaffoldCategory): string =>
  category === "foundation"
    ? "foundations"
    : category === "primitive"
    ? "primitives"
    : category === "pattern"
    ? "patterns"
    : "diff"

const publicEntry = (category: ScaffoldCategory): "foundations" | "primitives" | "patterns" | "diff" =>
  category === "foundation"
    ? "foundations"
    : category === "primitive"
    ? "primitives"
    : category === "pattern"
    ? "patterns"
    : "diff"

const constantName = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLocaleUpperCase("en-US")

const sourceTemplate = (name: string): string =>
  `import type { ReactElement } from "react"
import { cssClass } from "../internal/component.js"
import styles from "./${name}.module.css"

/** Complete controlled states rendered by ${name}. */
export const RLY_${
    constantName(name)
  }_STATES: readonly ["default", "loading", "empty", "error"] = ["default", "loading", "empty", "error"]
/** One explicit ${name} presentation state. */
export type Rly${name}State = (typeof RLY_${constantName(name)}_STATES)[number]

/** Presentation-only inputs accepted by ${name}. */
export interface ${name}Props {
  readonly label: string
  readonly state: Rly${name}State
}

/** Present ${name} in one explicit, caller-controlled state. */
export const ${name} = ({ label, state }: ${name}Props): ReactElement => (
  <section
    aria-busy={state === "loading" ? "true" : undefined}
    className={cssClass(styles, "root")}
    data-state={state}
    role={state === "error" ? "alert" : undefined}
  >
    {label}
  </section>
)
`

const styleTemplate = (): string =>
  `.root {
  min-inline-size: 0;
  padding: var(--rly-space-12);
  color: var(--rly-color-text-1);
  background: var(--rly-color-surface-1);
  border: 1px solid var(--rly-color-border-1);
  border-radius: var(--rly-radius-control);
}
`

const storyTemplate = (
  name: string,
  category: ScaffoldCategory
): string =>
  `import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { ${name}, RLY_${constantName(name)}_STATES } from "../../src/${categoryDirectory(category)}/${name}.js"

const meta = { component: ${name}, tags: ["autodocs"], title: "${
    categoryDirectory(category)[0]?.toLocaleUpperCase("en-US") ?? ""
  }${categoryDirectory(category).slice(1)}/${name}" } satisfies Meta<typeof ${name}>
export default meta
type Story = StoryObj<typeof meta>

export const States: Story = {
  args: { label: "${name}", state: "default" },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[data-state]")).toHaveLength(RLY_${constantName(name)}_STATES.length)
  },
  render: () => <>{RLY_${
    constantName(name)
  }_STATES.map((state) => <${name} key={state} label={state} state={state} />)}</>
}
`

const testTemplate = (name: string, category: ScaffoldCategory): string =>
  `// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ${name}, RLY_${constantName(name)}_STATES } from "../../src/${categoryDirectory(category)}/${name}.js"

describe("${name}", () => {
  it("renders every explicit state with accessible status semantics", () => {
    for (const state of RLY_${constantName(name)}_STATES) {
      const markup = renderToStaticMarkup(<${name} label={state} state={state} />)
      expect(markup).toContain(\`data-state="\${state}"\`)
      if (state === "error") expect(markup).toContain('role="alert"')
    }
    expect(RLY_${constantName(name)}_STATES).toHaveLength(4)
  })
})
`

const renderMetadataEntry = (name: string, purpose: string): string =>
  `  ${name}: registryMetadata(${
    JSON.stringify(purpose)
  }, ["default", "loading", "empty", "error"], ["present", "status"]),`

const renderComponentEntry = (component: ComponentRecord): string =>
  `  {
    category: ${JSON.stringify(component.category)},
    exports: [
      { kind: "value", name: ${JSON.stringify(component.name)} },
      { kind: "value", name: ${JSON.stringify(`RLY_${constantName(component.name)}_STATES`)} },
      { kind: "type", name: ${JSON.stringify(`${component.name}Props`)} },
      { kind: "type", name: ${JSON.stringify(`Rly${component.name}State`)} }
    ],
    name: ${JSON.stringify(component.name)},
    publicEntry: ${JSON.stringify(component.publicEntry)},
    registry: true,
    source: ${JSON.stringify(component.source)},
    status: "experimental",
    styles: [${JSON.stringify(component.styles[0])}],
    variants: [{ defaultValue: "default", name: "state", values: ["default", "loading", "empty", "error"] }],
    visual: {
      story: ${JSON.stringify(component.visual.story)},
      storyId: ${JSON.stringify(component.visual.storyId)},
      tests: [${JSON.stringify(component.visual.tests[0])}]
    }
  },`

/** Build a fail-before-write scaffold plan for one complete rly component slice. */
export const createScaffoldComponentPlan = (options: ScaffoldComponentOptions): ScaffoldComponentPlan => {
  const name = options.name.trim()
  const purpose = options.purpose.trim()
  if (!/^[A-Z][A-Za-z0-9]+$/.test(name)) throw new Error("Component name must be PascalCase")
  if (purpose.length < 12) throw new Error("Component purpose must contain at least 12 characters")
  if (
    !markerLine(COMPONENT_MARKER).test(options.manifestSource)
    || !markerLine(METADATA_MARKER).test(options.registryMetadataSource)
  ) {
    throw new Error("Component manifest scaffold markers are missing")
  }
  if (new RegExp(`\\bname: ["']${name}["']`).test(options.manifestSource)) {
    throw new Error(`Component ${name} already exists in the manifest`)
  }
  const directory = categoryDirectory(options.category)
  const slug = name.toLocaleLowerCase("en-US")
  const component: ComponentRecord = {
    category: options.category,
    exports: [
      { kind: "value", name },
      { kind: "value", name: `RLY_${constantName(name)}_STATES` },
      { kind: "type", name: `${name}Props` },
      { kind: "type", name: `Rly${name}State` }
    ],
    name,
    publicEntry: publicEntry(options.category),
    registry: true,
    source: `src/${directory}/${name}.tsx`,
    status: "experimental",
    styles: [`src/${directory}/${name}.module.css`],
    variants: [{ defaultValue: "default", name: "state", values: ["default", "loading", "empty", "error"] }],
    visual: {
      story: `stories/${directory}/${name}.stories.tsx`,
      storyId: `${directory}-${slug}--states`,
      tests: [`test/${directory}/${name}.test.tsx`]
    }
  }
  const files = new Map<string, string>([
    [component.source, sourceTemplate(name)],
    [component.styles[0] ?? "", styleTemplate()],
    [component.visual.story, storyTemplate(name, options.category)],
    [component.visual.tests[0] ?? "", testTemplate(name, options.category)]
  ])
  for (const path of files.keys()) {
    if (path.length === 0) throw new Error("Scaffolder produced an empty path")
    if (options.existingFiles.has(path)) throw new Error(`Refusing to overwrite ${path}`)
  }
  const metadata: RegistryMetadata = {
    accessibility: [
      "Provide a programmatic name for informative content",
      "Preserve keyboard focus visibility and color-independent meaning"
    ],
    capabilities: ["present", "status"],
    purpose,
    states: ["default", "loading", "empty", "error"]
  }
  const manifestSource = options.manifestSource.replace(
    markerLine(COMPONENT_MARKER),
    `${renderComponentEntry(component)}\n  ${COMPONENT_MARKER}`
  )
  const registryMetadataSource = options.registryMetadataSource.replace(
    markerLine(METADATA_MARKER),
    `${renderMetadataEntry(name, purpose)}\n  ${METADATA_MARKER}`
  )
  return { component, files, manifestSource, metadata, registryMetadataSource }
}
