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
  }]
} satisfies ComponentManifest
