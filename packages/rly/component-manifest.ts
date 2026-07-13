/** Stable identifiers for rly's public package entries. */
export type EntryId = "root" | "tokens" | "foundations" | "primitives" | "patterns" | "diff"

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
  readonly output: `dist/${string}`
  readonly source: `src/${string}`
  readonly subpath: `./${string}`
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
  readonly schemaVersion: 1
}

/** Checked-in rly package contract. Components are added with their implementation commits. */
export const componentManifest = {
  schemaVersion: 1,
  assets: [{ id: "styles", output: "dist/styles.css", source: "src/styles/styles.css", subpath: "./styles.css" }],
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
      aggregates: [],
      environment: "client",
      id: "diff",
      source: "src/diff/index.ts",
      subpath: "./diff"
    }
  ],
  components: [{
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
  }, {
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
  }, {
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
  }, {
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
  }, {
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
  }, {
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
  }, {
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
  }, {
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
  }, {
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
  }, {
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
  }, {
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
  }, {
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
  }, {
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
  }, {
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
  }, {
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
  }, {
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
  }, {
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
  }, {
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
        values: ["verdict", "page-title", "section-title", "card-title", "body-large", "body", "label", "meta", "code"]
      },
      { defaultValue: "primary", name: "tone", values: ["primary", "secondary", "tertiary", "inherit"] }
    ],
    visual: {
      story: "stories/primitives/Text.stories.tsx",
      storyId: "primitives-text--gallery",
      tests: ["test/primitives/Text.test.tsx"]
    }
  }]
} satisfies ComponentManifest
