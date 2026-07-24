import { COMPONENT_REGISTRY_METADATA } from "./manifest/registry-metadata.js"

/** Stable identifiers for rly's public package entries. */
export type EntryId =
  | "root"
  | "tokens"
  | "foundations"
  | "primitives"
  | "patterns"
  | "diff"
  | "diff/workbench"

/** A JavaScript module entry generated into the published package. */
export interface ModuleEntry {
  readonly aggregates: ReadonlyArray<EntryId>
  readonly environment: "universal" | "client"
  readonly id: EntryId
  readonly source: `src/${string}.ts`
  readonly subpath: "." | `./${string}`
}

/** A non-JavaScript artifact exported from the published package. */
export interface AssetEntry {
  readonly id: string
  readonly output: `dist/${string}` | `registry/${string}`
  readonly source: `src/${string}` | `registry/${string}`
  readonly subpath: `./${string}`
}

/** Curated agent-facing guidance which cannot be inferred safely from TypeScript alone. */
export interface RegistryMetadata {
  readonly accessibility: readonly [string, ...ReadonlyArray<string>]
  readonly capabilities: readonly [string, ...ReadonlyArray<string>]
  readonly purpose: string
  readonly states: readonly [string, ...ReadonlyArray<string>]
}

/** Metadata for one named component export. */
export interface ComponentRecord {
  readonly category: "foundation" | "primitive" | "pattern" | "diff"
  readonly exports: ReadonlyArray<{
    readonly kind: "type" | "value"
    readonly name: string
  }>
  readonly name: string
  readonly publicEntry: EntryId
  readonly registry: boolean
  readonly source: `src/${string}.ts` | `src/${string}.tsx`
  readonly status: "experimental" | "stable" | "deprecated"
  readonly styles: ReadonlyArray<`src/${string}.css`>
  readonly variants: ReadonlyArray<{
    readonly defaultValue?: string
    readonly name: string
    readonly values: readonly [string, ...ReadonlyArray<string>]
  }>
  readonly visual: {
    readonly coverageStoryIds?: ReadonlyArray<string>
    readonly story: `stories/${string}.stories.tsx`
    readonly storyId: string
    readonly tests: ReadonlyArray<`test/${string}.test.ts` | `test/${string}.test.tsx`>
  }
}

/** Single source of truth for generated rly entries and component metadata. */
export interface ComponentManifest {
  readonly assets: ReadonlyArray<AssetEntry>
  readonly components: ReadonlyArray<ComponentRecord>
  readonly entries: ReadonlyArray<ModuleEntry>
  readonly registryMetadata: Readonly<Record<string, RegistryMetadata>>
  readonly schemaVersion: 1
}

/** Checked-in rly package contract. Components are added with their implementation commits. */
export const componentManifest = {
  schemaVersion: 1,
  assets: [
    { id: "styles", output: "dist/styles.css", source: "src/styles/styles.css", subpath: "./styles.css" },
    {
      id: "registry-components",
      output: "registry/components.json",
      source: "registry/components.json",
      subpath: "./registry/components.json"
    },
    {
      id: "registry-schema",
      output: "registry/schema.json",
      source: "registry/schema.json",
      subpath: "./registry/schema.json"
    },
    {
      id: "registry-search",
      output: "registry/search.json",
      source: "registry/search.json",
      subpath: "./registry/search.json"
    },
    { id: "registry-usage", output: "registry/USAGE.md", source: "registry/USAGE.md", subpath: "./registry/USAGE.md" }
  ],
  registryMetadata: COMPONENT_REGISTRY_METADATA,
  entries: [
    {
      aggregates: ["tokens", "foundations", "primitives", "patterns"],
      environment: "client",
      id: "root",
      source: "src/index.ts",
      subpath: "."
    },
    {
      aggregates: [],
      environment: "universal",
      id: "tokens",
      source: "src/tokens/index.ts",
      subpath: "./tokens"
    },
    {
      aggregates: [],
      environment: "client",
      id: "foundations",
      source: "src/foundations/index.ts",
      subpath: "./foundations"
    },
    {
      aggregates: [],
      environment: "client",
      id: "primitives",
      source: "src/primitives/index.ts",
      subpath: "./primitives"
    },
    {
      aggregates: [],
      environment: "client",
      id: "patterns",
      source: "src/patterns/index.ts",
      subpath: "./patterns"
    },
    {
      aggregates: ["diff/workbench"],
      environment: "client",
      id: "diff",
      source: "src/diff/index.ts",
      subpath: "./diff"
    },
    {
      aggregates: [],
      environment: "client",
      id: "diff/workbench",
      source: "src/diff/workbench/index.ts",
      subpath: "./diff/workbench"
    }
  ],
  components: [
    // scaffold:components:insert
    {
      category: "foundation",
      exports: [
        { kind: "value", name: "RLY_COLOR_TOKEN_NAMES" },
        { kind: "value", name: "RLY_MOTION_TOKEN_NAMES" },
        { kind: "value", name: "RLY_RADIUS_TOKEN_NAMES" },
        { kind: "value", name: "RLY_SPACE_TOKEN_NAMES" },
        { kind: "value", name: "RLY_TYPE_TOKEN_NAMES" },
        { kind: "type", name: "RlyColorToken" },
        { kind: "type", name: "RlyMotionToken" },
        { kind: "type", name: "RlyRadiusToken" },
        { kind: "type", name: "RlySpaceToken" },
        { kind: "type", name: "RlyTypeToken" }
      ],
      name: "SemanticTokens",
      publicEntry: "tokens",
      registry: true,
      source: "src/tokens/semantic-tokens.ts",
      status: "stable",
      styles: [],
      variants: [],
      visual: {
        story: "stories/foundations/Tokens.stories.tsx",
        storyId: "foundations-tokens--overview",
        tests: ["test/tokens/token-contract.test.ts"]
      }
    },
    {
      category: "diff",
      exports: [{ kind: "value", name: "DiffCodeView" }],
      name: "DiffCodeView",
      publicEntry: "diff",
      registry: true,
      source: "src/diff/DiffCodeView.tsx",
      status: "experimental",
      styles: ["src/diff/DiffCodeView.module.css"],
      variants: [
        { defaultValue: "split", name: "mode", values: ["split", "stacked"] },
        { defaultValue: "buffered", name: "virtualization", values: ["buffered", "strict"] }
      ],
      visual: {
        coverageStoryIds: ["diff-diffcodeview--stacked-wrapped"],
        story: "stories/diff/DiffCodeView.stories.tsx",
        storyId: "diff-diffcodeview--workbench",
        tests: ["test/diff/DiffCodeView.test.tsx"]
      }
    },
    {
      category: "diff",
      exports: [
        { kind: "type", name: "RlyDiffCodeAnnotation" },
        { kind: "type", name: "RlyDiffCodeItem" },
        { kind: "type", name: "RlyDiffCodeScrollTarget" },
        { kind: "type", name: "RlyDiffCodeSelection" },
        { kind: "type", name: "RlyDiffCodeViewHandle" },
        { kind: "type", name: "RlyDiffCodeViewProps" },
        { kind: "type", name: "RlyDiffTextFile" }
      ],
      name: "DiffCodeTypes",
      publicEntry: "diff",
      registry: false,
      source: "src/diff/types.ts",
      status: "experimental",
      styles: [],
      variants: [],
      visual: {
        story: "stories/diff/DiffCodeView.stories.tsx",
        storyId: "diff-diffcodeview--workbench",
        tests: ["test/diff/DiffCodeView.test.tsx"]
      }
    },
    {
      category: "diff",
      exports: [
        { kind: "value", name: "DiffFileTree" },
        { kind: "type", name: "DiffFileTreeProps" },
        { kind: "type", name: "RlyDiffFile" },
        { kind: "type", name: "RlyDiffFileChange" },
        { kind: "type", name: "RlyDiffFileContent" },
        { kind: "type", name: "RlyDiffInventory" }
      ],
      name: "DiffFileTree",
      publicEntry: "diff/workbench",
      registry: true,
      source: "src/diff/DiffFileTree.tsx",
      status: "stable",
      styles: ["src/diff/DiffFileTree.module.css"],
      variants: [],
      visual: {
        story: "stories/diff/DiffFileTree.stories.tsx",
        storyId: "diff-difffiletree--file-states",
        tests: ["test/diff/DiffFileTree.test.tsx"]
      }
    },
    {
      category: "diff",
      exports: [
        { kind: "value", name: "DiffFinding" },
        { kind: "type", name: "DiffFindingProps" },
        { kind: "type", name: "RlyDiffFinding" },
        { kind: "type", name: "RlyDiffFindingAnchor" },
        { kind: "type", name: "RlyDiffFindingPrevention" },
        { kind: "type", name: "RlyDiffFindingPreventionEnforcement" }
      ],
      name: "DiffFinding",
      publicEntry: "diff",
      registry: true,
      source: "src/diff/DiffFinding.tsx",
      status: "stable",
      styles: ["src/diff/DiffFinding.module.css"],
      variants: [
        { name: "source", values: ["human", "agent"] },
        { name: "anchor", values: ["current", "stale"] }
      ],
      visual: {
        coverageStoryIds: ["diff-difffinding--stale-anchor"],
        story: "stories/diff/DiffFinding.stories.tsx",
        storyId: "diff-difffinding--human-and-agent",
        tests: ["test/diff/DiffFinding.test.tsx"]
      }
    },
    {
      category: "diff",
      exports: [
        { kind: "value", name: "DiffHeader" },
        { kind: "type", name: "DiffHeaderProps" },
        { kind: "type", name: "RlyDiffFindingFilter" },
        { kind: "type", name: "RlyDiffLayout" }
      ],
      name: "DiffHeader",
      publicEntry: "diff/workbench",
      registry: true,
      source: "src/diff/DiffHeader.tsx",
      status: "stable",
      styles: ["src/diff/DiffHeader.module.css"],
      variants: [
        { name: "layout", values: ["split", "stacked"] },
        { name: "findingFilter", values: ["all", "human", "agent", "unresolved"] }
      ],
      visual: {
        story: "stories/diff/DiffHeader.stories.tsx",
        storyId: "diff-diffheader--controlled-preferences",
        tests: ["test/diff/DiffHeader.test.tsx"]
      }
    },
    {
      category: "diff",
      exports: [{ kind: "value", name: "RLY_DIFF_THEMES" }],
      name: "DiffThemes",
      publicEntry: "diff",
      registry: false,
      source: "src/diff/themes.ts",
      status: "experimental",
      styles: [],
      variants: [],
      visual: {
        story: "stories/diff/DiffCodeView.stories.tsx",
        storyId: "diff-diffcodeview--workbench",
        tests: ["test/diff/DiffCodeView.test.tsx"]
      }
    },
    {
      category: "diff",
      exports: [
        { kind: "value", name: "DiffWorkbench" },
        { kind: "type", name: "DiffWorkbenchProps" },
        { kind: "type", name: "RlyDiffWorkbenchFinding" },
        { kind: "type", name: "RlyDiffWorkbenchScope" }
      ],
      name: "DiffWorkbench",
      publicEntry: "diff/workbench",
      registry: true,
      source: "src/diff/DiffWorkbench.tsx",
      status: "stable",
      styles: ["src/diff/DiffWorkbench.module.css"],
      variants: [{ name: "scope", values: ["all-files", "selected-file"] }],
      visual: {
        story: "stories/diff/DiffWorkbench.stories.tsx",
        storyId: "diff-diffworkbench--bird-eye-review",
        tests: ["test/diff/DiffWorkbench.test.tsx"]
      }
    },
    {
      category: "diff",
      exports: [
        { kind: "value", name: "createDiffWorkerFactory" },
        { kind: "value", name: "DiffWorkerProvider" },
        { kind: "value", name: "normalizeDiffWorkerPoolSize" },
        { kind: "type", name: "CreateDiffWorkerFactoryOptions" },
        { kind: "type", name: "DiffWorkerProviderProps" }
      ],
      name: "DiffWorkerProvider",
      publicEntry: "diff",
      registry: true,
      source: "src/diff/worker-pool.tsx",
      status: "experimental",
      styles: [],
      variants: [],
      visual: {
        story: "stories/diff/DiffCodeView.stories.tsx",
        storyId: "diff-diffcodeview--worker-states",
        tests: ["test/diff/worker-pool.test.tsx"]
      }
    },
    {
      category: "foundation",
      exports: [
        { kind: "value", name: "GlobalStyles" },
        { kind: "type", name: "GlobalStylesProps" }
      ],
      name: "GlobalStyles",
      publicEntry: "foundations",
      registry: true,
      source: "src/foundations/GlobalStyles.tsx",
      status: "stable",
      styles: [],
      variants: [],
      visual: {
        story: "stories/foundations/GlobalStyles.stories.tsx",
        storyId: "foundations-globalstyles--scope",
        tests: ["test/foundations/GlobalStyles.test.tsx"]
      }
    },
    {
      category: "foundation",
      exports: [
        { kind: "value", name: "Icon" },
        { kind: "value", name: "RLY_ICON_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_ICON_NAMES" },
        { kind: "value", name: "RLY_ICON_VARIANTS" },
        { kind: "type", name: "IconProps" },
        { kind: "type", name: "RlyIconName" },
        { kind: "type", name: "RlyIconSize" }
      ],
      name: "Icon",
      publicEntry: "foundations",
      registry: true,
      source: "src/foundations/Icon.tsx",
      status: "stable",
      styles: [],
      variants: [{ defaultValue: "default", name: "size", values: ["small", "default", "large"] }],
      visual: {
        story: "stories/foundations/Icon.stories.tsx",
        storyId: "foundations-icon--catalog",
        tests: ["test/foundations/Icon.test.tsx"]
      }
    },
    {
      category: "foundation",
      exports: [
        { kind: "value", name: "LinkProvider" },
        { kind: "type", name: "LinkProviderProps" },
        { kind: "type", name: "RlyLinkComponent" },
        { kind: "type", name: "RlyLinkProps" }
      ],
      name: "LinkProvider",
      publicEntry: "foundations",
      registry: true,
      source: "src/foundations/LinkProvider.tsx",
      status: "stable",
      styles: [],
      variants: [],
      visual: {
        story: "stories/foundations/LinkProvider.stories.tsx",
        storyId: "foundations-linkprovider--framework-bridge",
        tests: ["test/foundations/LinkProvider.test.tsx"]
      }
    },
    {
      category: "foundation",
      exports: [
        { kind: "value", name: "PortalProvider" },
        { kind: "type", name: "PortalProviderProps" },
        { kind: "type", name: "RlyPortalContainer" }
      ],
      name: "PortalProvider",
      publicEntry: "foundations",
      registry: true,
      source: "src/foundations/PortalProvider.tsx",
      status: "stable",
      styles: [],
      variants: [],
      visual: {
        story: "stories/foundations/PortalProvider.stories.tsx",
        storyId: "foundations-portalprovider--custom-target",
        tests: ["test/foundations/PortalProvider.test.tsx"]
      }
    },
    {
      category: "foundation",
      exports: [
        { kind: "value", name: "RLY_THEME_NAMES" },
        { kind: "value", name: "ThemeProvider" },
        { kind: "type", name: "RlyTheme" },
        { kind: "type", name: "ThemeProviderProps" }
      ],
      name: "ThemeProvider",
      publicEntry: "foundations",
      registry: true,
      source: "src/foundations/ThemeProvider.tsx",
      status: "stable",
      styles: [],
      variants: [{ name: "theme", values: ["system", "light", "dark"] }],
      visual: {
        story: "stories/foundations/ThemeProvider.stories.tsx",
        storyId: "foundations-themeprovider--controlled",
        tests: ["test/foundations/ThemeProvider.test.tsx"]
      }
    },
    {
      category: "primitive",
      exports: [
        { kind: "value", name: "Avatar" },
        { kind: "value", name: "RLY_AVATAR_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_AVATAR_VARIANTS" },
        { kind: "type", name: "AvatarProps" },
        { kind: "type", name: "RlyAvatarShape" },
        { kind: "type", name: "RlyAvatarSize" }
      ],
      name: "Avatar",
      publicEntry: "primitives",
      registry: true,
      source: "src/primitives/Avatar.tsx",
      status: "stable",
      styles: ["src/primitives/Avatar.module.css"],
      variants: [
        { defaultValue: "default", name: "size", values: ["small", "default", "large", "hero"] },
        { defaultValue: "circle", name: "shape", values: ["circle", "rounded-square"] }
      ],
      visual: {
        story: "stories/primitives/Avatar.stories.tsx",
        storyId: "primitives-avatar--gallery",
        tests: ["test/primitives/Avatar.test.tsx"]
      }
    },
    {
      category: "primitive",
      exports: [
        { kind: "value", name: "Button" },
        { kind: "value", name: "RLY_BUTTON_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_BUTTON_VARIANTS" },
        { kind: "type", name: "ButtonProps" },
        { kind: "type", name: "RlyButtonSize" },
        { kind: "type", name: "RlyButtonVariant" }
      ],
      name: "Button",
      publicEntry: "primitives",
      registry: true,
      source: "src/primitives/Button.tsx",
      status: "stable",
      styles: ["src/primitives/Button.module.css"],
      variants: [
        { defaultValue: "secondary", name: "variant", values: ["primary", "secondary", "quiet"] },
        { defaultValue: "default", name: "size", values: ["compact", "default", "principal"] }
      ],
      visual: {
        story: "stories/primitives/Button.stories.tsx",
        storyId: "primitives-button--states",
        tests: ["test/primitives/Button.test.tsx"]
      }
    },
    {
      category: "primitive",
      exports: [
        { kind: "value", name: "Dialog" },
        { kind: "value", name: "RLY_DIALOG_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_DIALOG_VARIANTS" },
        { kind: "type", name: "DialogCloseProps" },
        { kind: "type", name: "DialogContentProps" },
        { kind: "type", name: "DialogRootProps" },
        { kind: "type", name: "DialogTriggerProps" },
        { kind: "type", name: "RlyDialogSize" }
      ],
      name: "Dialog",
      publicEntry: "primitives",
      registry: true,
      source: "src/primitives/Dialog.tsx",
      status: "stable",
      styles: ["src/primitives/Dialog.module.css"],
      variants: [{ defaultValue: "default", name: "size", values: ["default", "wide"] }],
      visual: {
        coverageStoryIds: ["primitives-dialog--nested-isolation"],
        story: "stories/primitives/Dialog.stories.tsx",
        storyId: "primitives-dialog--interaction",
        tests: ["test/primitives/Dialog.test.tsx"]
      }
    },
    {
      category: "primitive",
      exports: [
        { kind: "value", name: "Divider" },
        { kind: "value", name: "RLY_DIVIDER_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_DIVIDER_VARIANTS" },
        { kind: "type", name: "DividerProps" },
        { kind: "type", name: "RlyDividerOrientation" },
        { kind: "type", name: "RlyDividerStrength" }
      ],
      name: "Divider",
      publicEntry: "primitives",
      registry: true,
      source: "src/primitives/Divider.tsx",
      status: "stable",
      styles: ["src/primitives/Divider.module.css"],
      variants: [
        { defaultValue: "horizontal", name: "orientation", values: ["horizontal", "vertical"] },
        { defaultValue: "subtle", name: "strength", values: ["subtle", "strong"] }
      ],
      visual: {
        story: "stories/primitives/Divider.stories.tsx",
        storyId: "primitives-divider--gallery",
        tests: ["test/primitives/Divider.test.tsx"]
      }
    },
    {
      category: "primitive",
      exports: [
        { kind: "value", name: "Field" },
        { kind: "value", name: "RLY_FIELD_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_FIELD_VARIANTS" },
        { kind: "type", name: "FieldControlProps" },
        { kind: "type", name: "FieldProps" },
        { kind: "type", name: "RlyFieldSize" }
      ],
      name: "Field",
      publicEntry: "primitives",
      registry: true,
      source: "src/primitives/Field.tsx",
      status: "stable",
      styles: ["src/primitives/Field.module.css"],
      variants: [{ defaultValue: "default", name: "size", values: ["compact", "default"] }],
      visual: {
        story: "stories/primitives/Field.stories.tsx",
        storyId: "primitives-field--states",
        tests: ["test/primitives/Field.test.tsx"]
      }
    },
    {
      category: "primitive",
      exports: [
        { kind: "value", name: "IconButton" },
        { kind: "value", name: "RLY_ICON_BUTTON_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_ICON_BUTTON_VARIANTS" },
        { kind: "type", name: "IconButtonProps" },
        { kind: "type", name: "RlyIconButtonSize" },
        { kind: "type", name: "RlyIconButtonVariant" }
      ],
      name: "IconButton",
      publicEntry: "primitives",
      registry: true,
      source: "src/primitives/IconButton.tsx",
      status: "stable",
      styles: ["src/primitives/IconButton.module.css"],
      variants: [
        { defaultValue: "secondary", name: "variant", values: ["primary", "secondary", "quiet"] },
        { defaultValue: "default", name: "size", values: ["compact", "default", "principal"] }
      ],
      visual: {
        story: "stories/primitives/IconButton.stories.tsx",
        storyId: "primitives-iconbutton--states",
        tests: ["test/primitives/IconButton.test.tsx"]
      }
    },
    {
      category: "primitive",
      exports: [
        { kind: "value", name: "RLY_SELECT_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_SELECT_VARIANTS" },
        { kind: "value", name: "Select" },
        { kind: "type", name: "RlySelectOption" },
        { kind: "type", name: "RlySelectSize" },
        { kind: "type", name: "SelectProps" }
      ],
      name: "Select",
      publicEntry: "primitives",
      registry: true,
      source: "src/primitives/Select.tsx",
      status: "stable",
      styles: ["src/primitives/Select.module.css"],
      variants: [{ defaultValue: "default", name: "size", values: ["compact", "default"] }],
      visual: {
        story: "stories/primitives/Select.stories.tsx",
        storyId: "primitives-select--states",
        tests: ["test/primitives/Select.test.tsx"]
      }
    },
    {
      category: "primitive",
      exports: [
        { kind: "value", name: "RLY_SHEET_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_SHEET_VARIANTS" },
        { kind: "value", name: "Sheet" },
        { kind: "type", name: "RlySheetSide" },
        { kind: "type", name: "SheetBodyProps" },
        { kind: "type", name: "SheetCloseProps" },
        { kind: "type", name: "SheetContentProps" },
        { kind: "type", name: "SheetFooterProps" },
        { kind: "type", name: "SheetRootProps" },
        { kind: "type", name: "SheetTriggerProps" }
      ],
      name: "Sheet",
      publicEntry: "primitives",
      registry: true,
      source: "src/primitives/Sheet.tsx",
      status: "stable",
      styles: ["src/primitives/Sheet.module.css"],
      variants: [{ defaultValue: "end", name: "side", values: ["end", "start"] }],
      visual: {
        story: "stories/primitives/Sheet.stories.tsx",
        storyId: "primitives-sheet--interaction",
        tests: ["test/primitives/Sheet.test.tsx"]
      }
    },
    {
      category: "primitive",
      exports: [
        { kind: "value", name: "Skeleton" },
        { kind: "value", name: "RLY_SKELETON_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_SKELETON_VARIANTS" },
        { kind: "type", name: "RlySkeletonVariant" },
        { kind: "type", name: "SkeletonProps" }
      ],
      name: "Skeleton",
      publicEntry: "primitives",
      registry: true,
      source: "src/primitives/Skeleton.tsx",
      status: "stable",
      styles: ["src/primitives/Skeleton.module.css"],
      variants: [{ defaultValue: "text", name: "variant", values: ["text", "block", "circle"] }],
      visual: {
        story: "stories/primitives/Skeleton.stories.tsx",
        storyId: "primitives-skeleton--gallery",
        tests: ["test/primitives/Skeleton.test.tsx"]
      }
    },
    {
      category: "primitive",
      exports: [
        { kind: "value", name: "StateLabel" },
        { kind: "value", name: "RLY_STATE_LABEL_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_STATE_LABEL_VARIANTS" },
        { kind: "type", name: "RlyStateLabelSize" },
        { kind: "type", name: "RlyStateTone" },
        { kind: "type", name: "StateLabelProps" }
      ],
      name: "StateLabel",
      publicEntry: "primitives",
      registry: true,
      source: "src/primitives/StateLabel.tsx",
      status: "stable",
      styles: ["src/primitives/StateLabel.module.css"],
      variants: [
        {
          defaultValue: "neutral",
          name: "tone",
          values: ["neutral", "positive", "critical", "caution", "progress"]
        },
        { defaultValue: "default", name: "size", values: ["compact", "default"] }
      ],
      visual: {
        story: "stories/primitives/StateLabel.stories.tsx",
        storyId: "primitives-statelabel--gallery",
        tests: ["test/primitives/StateLabel.test.tsx"]
      }
    },
    {
      category: "primitive",
      exports: [
        { kind: "value", name: "StatePanel" },
        { kind: "value", name: "RLY_STATE_PANEL_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_STATE_PANEL_VARIANTS" },
        { kind: "type", name: "RlyStatePanelAnnouncement" },
        { kind: "type", name: "RlyStatePanelTone" },
        { kind: "type", name: "StatePanelProps" }
      ],
      name: "StatePanel",
      publicEntry: "primitives",
      registry: true,
      source: "src/primitives/StatePanel.tsx",
      status: "stable",
      styles: ["src/primitives/StatePanel.module.css"],
      variants: [{
        defaultValue: "neutral",
        name: "tone",
        values: ["neutral", "positive", "critical", "caution", "progress"]
      }],
      visual: {
        story: "stories/primitives/StatePanel.stories.tsx",
        storyId: "primitives-statepanel--gallery",
        tests: ["test/primitives/StatePanel.test.tsx"]
      }
    },
    {
      category: "primitive",
      exports: [
        { kind: "value", name: "Surface" },
        { kind: "value", name: "RLY_SURFACE_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_SURFACE_VARIANTS" },
        { kind: "type", name: "RlySurfaceElement" },
        { kind: "type", name: "RlySurfacePadding" },
        { kind: "type", name: "RlySurfaceShape" },
        { kind: "type", name: "RlySurfaceTone" },
        { kind: "type", name: "SurfaceProps" }
      ],
      name: "Surface",
      publicEntry: "primitives",
      registry: true,
      source: "src/primitives/Surface.tsx",
      status: "stable",
      styles: ["src/primitives/Surface.module.css"],
      variants: [
        { defaultValue: "primary", name: "tone", values: ["primary", "secondary", "tertiary"] },
        { defaultValue: "card", name: "shape", values: ["card", "grouped"] },
        { defaultValue: "default", name: "padding", values: ["none", "compact", "default", "spacious"] }
      ],
      visual: {
        story: "stories/primitives/Surface.stories.tsx",
        storyId: "primitives-surface--gallery",
        tests: ["test/primitives/Surface.test.tsx"]
      }
    },
    {
      category: "primitive",
      exports: [
        { kind: "value", name: "RLY_TABS_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_TABS_VARIANTS" },
        { kind: "value", name: "Tabs" },
        { kind: "type", name: "RlyTabItem" },
        { kind: "type", name: "RlyTabsDirection" },
        { kind: "type", name: "RlyTabsSize" },
        { kind: "type", name: "TabsProps" }
      ],
      name: "Tabs",
      publicEntry: "primitives",
      registry: true,
      source: "src/primitives/Tabs.tsx",
      status: "stable",
      styles: ["src/primitives/Tabs.module.css"],
      variants: [{ defaultValue: "default", name: "size", values: ["default", "large"] }],
      visual: {
        story: "stories/primitives/Tabs.stories.tsx",
        storyId: "primitives-tabs--interaction",
        tests: ["test/primitives/Tabs.test.tsx"]
      }
    },
    {
      category: "primitive",
      exports: [
        { kind: "value", name: "Text" },
        { kind: "value", name: "RLY_TEXT_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_TEXT_VARIANTS" },
        { kind: "type", name: "RlyTextElement" },
        { kind: "type", name: "RlyTextTone" },
        { kind: "type", name: "RlyTextVariant" },
        { kind: "type", name: "TextProps" }
      ],
      name: "Text",
      publicEntry: "primitives",
      registry: true,
      source: "src/primitives/Text.tsx",
      status: "stable",
      styles: ["src/primitives/Text.module.css"],
      variants: [
        {
          defaultValue: "body",
          name: "variant",
          values: [
            "verdict",
            "page-title",
            "section-title",
            "card-title",
            "body-large",
            "body",
            "label",
            "meta",
            "code"
          ]
        },
        { defaultValue: "primary", name: "tone", values: ["primary", "secondary", "tertiary", "inherit"] }
      ],
      visual: {
        story: "stories/primitives/Text.stories.tsx",
        storyId: "primitives-text--gallery",
        tests: ["test/primitives/Text.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "AgentContextButton" },
        { kind: "type", name: "AgentContextButtonProps" },
        { kind: "type", name: "RlyAgentJobSummary" }
      ],
      name: "AgentContextButton",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/AgentContextButton.tsx",
      status: "stable",
      styles: ["src/patterns/AgentContextButton.module.css"],
      variants: [],
      visual: {
        story: "stories/patterns/AgentContextButton.stories.tsx",
        storyId: "patterns-agentcontextbutton--contexts",
        tests: ["test/patterns/AgentContextButton.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "AgentDrawer" },
        { kind: "type", name: "AgentDrawerProps" }
      ],
      name: "AgentDrawer",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/AgentDrawer.tsx",
      status: "stable",
      styles: ["src/patterns/AgentDrawer.module.css"],
      variants: [],
      visual: {
        story: "stories/patterns/AgentDrawer.stories.tsx",
        storyId: "patterns-agentdrawer--interaction",
        tests: ["test/patterns/AgentDrawer.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "AgentJob" },
        { kind: "type", name: "AgentJobProps" },
        { kind: "type", name: "RlyAgentJobState" }
      ],
      name: "AgentJob",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/AgentJob.tsx",
      status: "stable",
      styles: ["src/patterns/AgentJob.module.css"],
      variants: [],
      visual: {
        story: "stories/patterns/AgentJob.stories.tsx",
        storyId: "patterns-agentjob--states",
        tests: ["test/patterns/AgentJob.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "AgentProposal" },
        { kind: "type", name: "AgentProposalProps" },
        { kind: "type", name: "RlyAgentIdentity" },
        { kind: "type", name: "RlyAgentProposal" },
        { kind: "type", name: "RlyAgentProposalEvidence" }
      ],
      name: "AgentProposal",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/AgentProposal.tsx",
      status: "stable",
      styles: ["src/patterns/AgentProposal.module.css"],
      variants: [],
      visual: {
        story: "stories/patterns/AgentProposal.stories.tsx",
        storyId: "patterns-agentproposal--states",
        tests: ["test/patterns/AgentProposal.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "AgentThread" },
        { kind: "type", name: "AgentThreadProps" },
        { kind: "type", name: "RlyAgentThreadActor" },
        { kind: "type", name: "RlyAgentThreadAgentActor" },
        { kind: "type", name: "RlyAgentThreadHumanActor" },
        { kind: "type", name: "RlyAgentThreadMessage" },
        { kind: "type", name: "RlyAgentThreadSystemActor" }
      ],
      name: "AgentThread",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/AgentThread.tsx",
      status: "stable",
      styles: ["src/patterns/AgentThread.module.css"],
      variants: [],
      visual: {
        story: "stories/patterns/AgentThread.stories.tsx",
        storyId: "patterns-agentthread--release-thread",
        tests: ["test/patterns/AgentThread.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "CollaboratorGroup" },
        { kind: "value", name: "RLY_COLLABORATOR_GROUP_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_COLLABORATOR_GROUP_VARIANTS" },
        { kind: "type", name: "CollaboratorGroupProps" },
        { kind: "type", name: "RlyCollaboratorCategory" },
        { kind: "type", name: "RlyCollaboratorGroupSize" }
      ],
      name: "CollaboratorGroup",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/CollaboratorGroup.tsx",
      status: "stable",
      styles: ["src/patterns/CollaboratorGroup.module.css"],
      variants: [{ defaultValue: "default", name: "size", values: ["compact", "default"] }],
      visual: {
        story: "stories/patterns/CollaboratorGroup.stories.tsx",
        storyId: "patterns-collaboratorgroup--entity-roles",
        tests: ["test/patterns/CollaboratorGroup.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "EntityShell" },
        { kind: "type", name: "EntityShellProps" }
      ],
      name: "EntityShell",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/EntityShell.tsx",
      status: "stable",
      styles: ["src/patterns/EntityShell.module.css"],
      variants: [],
      visual: {
        story: "stories/patterns/EntityShell.stories.tsx",
        storyId: "patterns-entityshell--services",
        tests: ["test/patterns/EntityShell.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "EntityTable" },
        { kind: "type", name: "EntityTableProps" },
        { kind: "type", name: "RlyEntityTableCell" },
        { kind: "type", name: "RlyEntityTableColumn" },
        { kind: "type", name: "RlyEntityTableData" },
        { kind: "type", name: "RlyEntityTableRow" },
        { kind: "type", name: "RlyEntityTableSortDirection" }
      ],
      name: "EntityTable",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/EntityTable.tsx",
      status: "stable",
      styles: ["src/patterns/EntityTable.module.css"],
      variants: [],
      visual: {
        story: "stories/patterns/EntityTable.stories.tsx",
        storyId: "patterns-entitytable--states",
        tests: ["test/patterns/EntityTable.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "EvidenceStamp" },
        { kind: "type", name: "EvidenceStampProps" }
      ],
      name: "EvidenceStamp",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/EvidenceStamp.tsx",
      status: "stable",
      styles: ["src/patterns/EvidenceStamp.module.css"],
      variants: [],
      visual: {
        story: "stories/patterns/EvidenceStamp.stories.tsx",
        storyId: "patterns-evidencestamp--compact-forced-colors",
        tests: ["test/patterns/EvidenceStamp.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "FreshnessStamp" },
        { kind: "value", name: "RLY_FRESHNESS_STAMP_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_FRESHNESS_STAMP_VARIANTS" },
        { kind: "type", name: "FreshnessStampProps" },
        { kind: "type", name: "RlyFreshnessStampSize" },
        { kind: "type", name: "RlyFreshnessState" }
      ],
      name: "FreshnessStamp",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/FreshnessStamp.tsx",
      status: "stable",
      styles: ["src/patterns/FreshnessStamp.module.css"],
      variants: [
        { name: "state", values: ["current", "cached", "stale", "missing", "unavailable"] },
        { defaultValue: "default", name: "size", values: ["compact", "default"] }
      ],
      visual: {
        story: "stories/patterns/FreshnessStamp.stories.tsx",
        storyId: "patterns-freshnessstamp--matrix",
        tests: ["test/patterns/FreshnessStamp.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "GovernedActionReview" },
        { kind: "type", name: "GovernedActionReviewProps" },
        { kind: "type", name: "RlyGovernedActionState" }
      ],
      name: "GovernedActionReview",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/GovernedActionReview.tsx",
      status: "stable",
      styles: ["src/patterns/GovernedActionReview.module.css"],
      variants: [],
      visual: {
        coverageStoryIds: ["patterns-governedactionreview--terminal-states"],
        story: "stories/patterns/GovernedActionReview.stories.tsx",
        storyId: "patterns-governedactionreview--confirmation",
        tests: ["test/patterns/GovernedActionReview.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "PeopleStrip" },
        { kind: "value", name: "RLY_PEOPLE_STRIP_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_PEOPLE_STRIP_VARIANTS" },
        { kind: "type", name: "PeopleStripProps" },
        { kind: "type", name: "RlyPeopleStripSize" }
      ],
      name: "PeopleStrip",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/PeopleStrip.tsx",
      status: "stable",
      styles: ["src/patterns/PeopleStrip.module.css"],
      variants: [{ defaultValue: "default", name: "size", values: ["compact", "default"] }],
      visual: {
        story: "stories/patterns/PeopleStrip.stories.tsx",
        storyId: "patterns-peoplestrip--overflow",
        tests: ["test/patterns/PeopleStrip.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "Person" },
        { kind: "value", name: "RLY_PERSON_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_PERSON_VARIANTS" },
        { kind: "type", name: "PersonProps" },
        { kind: "type", name: "RlyPerson" },
        { kind: "type", name: "RlyPersonSize" }
      ],
      name: "Person",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/Person.tsx",
      status: "stable",
      styles: ["src/patterns/Person.module.css"],
      variants: [{ defaultValue: "default", name: "size", values: ["compact", "default"] }],
      visual: {
        story: "stories/patterns/Person.stories.tsx",
        storyId: "patterns-person--states",
        tests: ["test/patterns/Person.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "ReleasePreview" },
        { kind: "type", name: "ReleasePreviewProps" },
        { kind: "type", name: "RlyReleasePreviewPresentation" }
      ],
      name: "ReleasePreview",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/ReleasePreview.tsx",
      status: "stable",
      styles: ["src/patterns/ReleasePreview.module.css"],
      variants: [{ defaultValue: "dialog", name: "presentation", values: ["dialog", "sheet"] }],
      visual: {
        coverageStoryIds: ["patterns-releasepreview--compact-forced-colors"],
        story: "stories/patterns/ReleasePreview.stories.tsx",
        storyId: "patterns-releasepreview--interaction",
        tests: ["test/patterns/ReleasePreview.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "ReleaseRelay" },
        { kind: "value", name: "RLY_RELEASE_RELAY_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_RELEASE_RELAY_SYMBOLS" },
        { kind: "value", name: "RLY_RELEASE_RELAY_VARIANTS" },
        { kind: "type", name: "ReleaseRelayProps" },
        { kind: "type", name: "RlyReleaseRelaySize" },
        { kind: "type", name: "RlyReleaseRelaySymbolIndex" },
        { kind: "type", name: "RlyReleaseRelaySymbolIndices" },
        { kind: "type", name: "RlyReleaseRelaySymbolName" }
      ],
      name: "ReleaseRelay",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/ReleaseRelay.tsx",
      status: "stable",
      styles: ["src/patterns/ReleaseRelay.module.css"],
      variants: [{ defaultValue: "compact", name: "size", values: ["compact", "hero"] }],
      visual: {
        coverageStoryIds: ["patterns-releaserelay--geometry-forced-colors"],
        story: "stories/patterns/ReleaseRelay.stories.tsx",
        storyId: "patterns-releaserelay--catalog",
        tests: ["test/patterns/ReleaseRelay.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "ReleaseRow" },
        { kind: "type", name: "ReleaseRowProps" },
        { kind: "type", name: "RlyReleaseFact" },
        { kind: "type", name: "RlyReleasePresentation" },
        { kind: "type", name: "RlyReleaseState" },
        { kind: "type", name: "RlyReleaseTransitionNames" }
      ],
      name: "ReleaseRow",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/ReleaseRow.tsx",
      status: "stable",
      styles: ["src/patterns/ReleaseRow.module.css"],
      variants: [],
      visual: {
        coverageStoryIds: ["patterns-releaserow--unknown-unassigned"],
        story: "stories/patterns/ReleaseRow.stories.tsx",
        storyId: "patterns-releaserow--six-states",
        tests: ["test/patterns/ReleaseRow.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "RLY_RELATIONSHIP_DIRECTION_PRESENTATION" },
        { kind: "value", name: "RLY_RELATIONSHIP_LIFECYCLE_PRESENTATION" },
        { kind: "value", name: "RelationshipChain" },
        { kind: "type", name: "RelationshipChainProps" },
        { kind: "type", name: "RlyMissingRelationshipEndpoint" },
        { kind: "type", name: "RlyPresentRelationshipEndpoint" },
        { kind: "type", name: "RlyRelationship" },
        { kind: "type", name: "RlyRelationshipDirection" },
        { kind: "type", name: "RlyRelationshipEndpoint" },
        { kind: "type", name: "RlyRelationshipLifecycle" }
      ],
      name: "RelationshipChain",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/RelationshipChain.tsx",
      status: "stable",
      styles: ["src/patterns/RelationshipChain.module.css"],
      variants: [],
      visual: {
        story: "stories/patterns/RelationshipChain.stories.tsx",
        storyId: "patterns-relationshipchain--cardinalities",
        tests: ["test/patterns/RelationshipChain.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "RelationshipTable" },
        { kind: "type", name: "RelationshipTableProps" }
      ],
      name: "RelationshipTable",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/RelationshipTable.tsx",
      status: "stable",
      styles: ["src/patterns/RelationshipTable.module.css"],
      variants: [],
      visual: {
        story: "stories/patterns/RelationshipTable.stories.tsx",
        storyId: "patterns-relationshiptable--equivalence",
        tests: ["test/patterns/RelationshipTable.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "RLY_SERVICE_MARK_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_SERVICE_MARK_VARIANTS" },
        { kind: "value", name: "ServiceMark" },
        { kind: "type", name: "RlyService" },
        { kind: "type", name: "RlyServiceMarkSize" },
        { kind: "type", name: "ServiceMarkProps" }
      ],
      name: "ServiceMark",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/ServiceMark.tsx",
      status: "stable",
      styles: ["src/patterns/ServiceMark.module.css"],
      variants: [
        {
          name: "service",
          values: ["codecommit", "codepipeline", "jira", "confluence", "clockify"]
        },
        { defaultValue: "default", name: "size", values: ["compact", "default"] }
      ],
      visual: {
        story: "stories/patterns/ServiceMark.stories.tsx",
        storyId: "patterns-servicemark--gallery",
        tests: ["test/patterns/ServiceMark.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "RLY_STAGE_RAIL_DEFAULT_VARIANTS" },
        { kind: "value", name: "RLY_STAGE_RAIL_VARIANTS" },
        { kind: "value", name: "StageRail" },
        { kind: "type", name: "RlyStage" },
        { kind: "type", name: "RlyStageRailSize" },
        { kind: "type", name: "StageRailProps" }
      ],
      name: "StageRail",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/StageRail.tsx",
      status: "stable",
      styles: ["src/patterns/StageRail.module.css"],
      variants: [{ defaultValue: "default", name: "size", values: ["compact", "default"] }],
      visual: {
        story: "stories/patterns/StageRail.stories.tsx",
        storyId: "patterns-stagerail--states",
        tests: ["test/patterns/StageRail.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "TimelineRow" },
        { kind: "type", name: "RlyTimelineActorKind" },
        { kind: "type", name: "RlyTimelineEvent" },
        { kind: "type", name: "TimelineRowProps" }
      ],
      name: "TimelineRow",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/TimelineRow.tsx",
      status: "stable",
      styles: ["src/patterns/TimelineRow.module.css"],
      variants: [],
      visual: {
        story: "stories/patterns/TimelineRow.stories.tsx",
        storyId: "patterns-timelinerow--actor-kinds",
        tests: ["test/patterns/TimelineRow.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "RLY_VERDICT_VARIANTS" },
        { kind: "value", name: "Verdict" },
        { kind: "type", name: "RlyVerdictTone" },
        { kind: "type", name: "VerdictProps" }
      ],
      name: "Verdict",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/Verdict.tsx",
      status: "stable",
      styles: ["src/patterns/Verdict.module.css"],
      variants: [{ name: "tone", values: ["caution", "critical", "neutral", "positive", "progress"] }],
      visual: {
        story: "stories/patterns/Verdict.stories.tsx",
        storyId: "patterns-verdict--states",
        tests: ["test/patterns/Verdict.test.tsx"]
      }
    },
    {
      category: "pattern",
      exports: [
        { kind: "value", name: "WorksetCard" },
        { kind: "type", name: "RlyWorksetGap" },
        { kind: "type", name: "RlyWorksetJiraItem" },
        { kind: "type", name: "RlyWorksetPipeline" },
        { kind: "type", name: "RlyWorksetPullRequestGroup" },
        { kind: "type", name: "WorksetCardProps" }
      ],
      name: "WorksetCard",
      publicEntry: "patterns",
      registry: true,
      source: "src/patterns/WorksetCard.tsx",
      status: "stable",
      styles: ["src/patterns/WorksetCard.module.css"],
      variants: [],
      visual: {
        story: "stories/patterns/WorksetCard.stories.tsx",
        storyId: "patterns-worksetcard--release-dimensions",
        tests: ["test/patterns/WorksetCard.test.tsx"]
      }
    }
  ]
} satisfies ComponentManifest
