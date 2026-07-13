import { describe, expect, it } from "vitest"
import {
  type ChangedFile,
  classifyVisualChanges,
  type VisualCatalog,
  type VisualClassification,
  type VisualComponentTarget
} from "../../scripts/visual/classify-changes.js"

const button: VisualComponentTarget = {
  name: "Button",
  paths: {
    source: "packages/rly/src/primitives/Button.tsx",
    story: "packages/rly/stories/primitives/Button.stories.tsx",
    styles: ["packages/rly/src/primitives/Button.module.css"],
    tests: ["packages/rly/test/primitives/Button.test.tsx"]
  },
  storyId: "primitives-button"
}

const dialog: VisualComponentTarget = {
  name: "Dialog",
  paths: {
    source: "packages/rly/src/primitives/Dialog.tsx",
    story: "packages/rly/stories/primitives/Dialog.stories.tsx",
    styles: ["packages/rly/src/primitives/Dialog.module.css"],
    tests: ["packages/rly/test/primitives/Dialog.test.tsx"]
  },
  storyId: "primitives-dialog"
}

const catalog = (components: ReadonlyArray<VisualComponentTarget>): VisualCatalog => ({
  components,
  schemaVersion: 1
})

const currentCatalog = catalog([dialog, button])

const classify = (
  changes: ReadonlyArray<ChangedFile>,
  options: { readonly baseCatalog?: VisualCatalog; readonly componentLimit?: number } = {}
): VisualClassification =>
  classifyVisualChanges({
    ...(options.baseCatalog === undefined ? {} : { baseCatalog: options.baseCatalog }),
    changes,
    ...(options.componentLimit === undefined ? {} : { componentLimit: options.componentLimit }),
    currentCatalog
  })

describe("visual changed-file classifier", () => {
  it("skips an empty change set", () => {
    expect(classify([])).toEqual({ reason: "no-changes", scope: "skip" })
  })

  it.each([
    "README.md",
    ".changeset/rly.md",
    ".specs/control-center/design.md",
    "packages/docs/src/content/docs/rly.mdx",
    "packages/rly/README.md"
  ])("skips documentation-only change %s", (path) => {
    expect(classify([{ path, status: "modified" }])).toEqual({ reason: "documentation-only", scope: "skip" })
  })

  it.each([
    button.paths.source,
    button.paths.story,
    button.paths.styles[0] ?? "missing-style-fixture",
    button.paths.tests[0] ?? "missing-test-fixture"
  ])("scopes exact component path %s", (path) => {
    expect(classify([{ path, status: "modified" }])).toEqual({
      components: [{ name: "Button", states: ["closed", "open", "focus"], storyId: "primitives-button" }],
      reasons: ["component-file-change"],
      scope: "component-scoped"
    })
  })

  it("sorts and deduplicates component captures deterministically", () => {
    const first = classify([
      { path: dialog.paths.source, status: "modified" },
      { path: button.paths.source, status: "modified" },
      { path: dialog.paths.story, status: "modified" }
    ])
    const second = classify([
      { path: dialog.paths.story, status: "modified" },
      { path: button.paths.source, status: "modified" },
      { path: dialog.paths.source, status: "modified" }
    ])

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      components: [{ name: "Button" }, { name: "Dialog" }],
      scope: "component-scoped"
    })
  })

  it.each([
    "packages/rly/src/tokens/color.ts",
    "packages/rly/src/foundations/PortalProvider.tsx",
    "packages/rly/src/diff/worker.ts",
    "packages/rly/src/styles/base.css",
    "packages/rly/.storybook/preview.tsx",
    "packages/rly/visual/high-risk.ts",
    "packages/rly/scripts/visual/run.ts",
    "packages/rly/component-manifest.ts",
    "packages/rly/package.json",
    "packages/rly/playwright.config.ts",
    "pnpm-lock.yaml"
  ])("expands full-risk path %s", (path) => {
    expect(classify([{ path, status: "modified" }])).toMatchObject({ scope: "full" })
  })

  it("expands an unrecognized file and a story MDX file", () => {
    expect(classify([{ path: "packages/rly/src/mystery.ts", status: "modified" }])).toEqual({
      reasons: ["unknown-path"],
      scope: "full"
    })
    expect(classify([{ path: "packages/rly/stories/Guide.mdx", status: "modified" }])).toEqual({
      reasons: ["unknown-path"],
      scope: "full"
    })
  })

  it("lets a component change dominate accompanying documentation", () => {
    expect(classify([
      { path: "packages/rly/README.md", status: "modified" },
      { path: button.paths.source, status: "modified" }
    ])).toMatchObject({ scope: "component-scoped" })
  })

  it("lets an unknown change dominate a component change", () => {
    expect(classify([
      { path: button.paths.source, status: "modified" },
      { path: "packages/rly/src/mystery.ts", status: "modified" }
    ])).toEqual({ reasons: ["unknown-path"], scope: "full" })
  })

  it("scopes deletion of secondary component files when the component remains", () => {
    expect(classify([{ path: button.paths.styles[0] ?? "", status: "deleted" }], {
      baseCatalog: currentCatalog
    })).toMatchObject({
      components: [{ name: "Button" }],
      scope: "component-scoped"
    })
  })

  it.each([button.paths.source, button.paths.story])("expands deletion of component entry %s", (path) => {
    expect(classify([{ path, status: "deleted" }], { baseCatalog: currentCatalog })).toEqual({
      reasons: ["deleted-component-entry"],
      scope: "full"
    })
  })

  it("expands deletion when the base catalog is unavailable", () => {
    expect(classify([{ path: button.paths.source, status: "deleted" }])).toEqual({
      reasons: ["missing-base-catalog"],
      scope: "full"
    })
  })

  it("scopes a same-component path rename", () => {
    const previousButton: VisualComponentTarget = {
      ...button,
      paths: { ...button.paths, story: "packages/rly/stories/Button.stories.tsx" }
    }

    expect(classify([{
      path: button.paths.story,
      previousPath: previousButton.paths.story,
      status: "renamed"
    }], { baseCatalog: catalog([previousButton, dialog]) })).toMatchObject({
      components: [{ name: "Button" }],
      scope: "component-scoped"
    })
  })

  it("expands a component identity rename", () => {
    const oldButton: VisualComponentTarget = {
      ...button,
      name: "Action",
      paths: { ...button.paths, source: "packages/rly/src/primitives/Action.tsx" },
      storyId: "primitives-action"
    }

    expect(classify([{
      path: button.paths.source,
      previousPath: oldButton.paths.source,
      status: "renamed"
    }], { baseCatalog: catalog([oldButton, dialog]) })).toEqual({
      reasons: ["ambiguous-component-rename"],
      scope: "full"
    })
  })

  it("skips a documentation rename", () => {
    expect(classify([{
      path: "packages/rly/NEW_README.md",
      previousPath: "packages/rly/README.md",
      status: "renamed"
    }])).toEqual({ reason: "documentation-only", scope: "skip" })
  })

  it.each<ChangedFile>([
    { path: button.paths.source, previousPath: "packages/rly/src/primitives/Old.tsx", status: "copied" },
    { path: button.paths.source, status: "type-changed" },
    { path: button.paths.source, status: "unmerged" },
    { path: button.paths.source, status: "unknown" },
    { path: "../outside.tsx", status: "modified" },
    { path: "packages/rly/src/primitives/Bad\nPath.tsx", status: "modified" }
  ])("expands unsupported or unsafe change %#", (change) => {
    expect(classify([change])).toMatchObject({ scope: "full" })
  })

  it("expands when the component cap is exceeded or invalid", () => {
    expect(classify([
      { path: button.paths.source, status: "modified" },
      { path: dialog.paths.source, status: "modified" }
    ], { componentLimit: 1 })).toEqual({ reasons: ["component-limit-exceeded"], scope: "full" })

    expect(classify([{ path: button.paths.source, status: "modified" }], { componentLimit: 0 })).toEqual({
      reasons: ["invalid-component-limit"],
      scope: "full"
    })
  })

  it("rejects ambiguous catalog paths", () => {
    const ambiguousDialog: VisualComponentTarget = {
      ...dialog,
      paths: { ...dialog.paths, source: button.paths.source }
    }

    expect(classifyVisualChanges({
      changes: [{ path: button.paths.source, status: "modified" }],
      currentCatalog: catalog([button, ambiguousDialog])
    })).toEqual({ reasons: ["invalid-visual-catalog"], scope: "full" })
  })
})
