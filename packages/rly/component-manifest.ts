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
}

/** Single source of truth for generated rly entries and component metadata. */
export interface ComponentManifest {
  readonly components: ReadonlyArray<ComponentRecord>
  readonly entries: ReadonlyArray<ModuleEntry>
  readonly schemaVersion: 1
}

/** Checked-in rly package contract. Components are added with their implementation commits. */
export const componentManifest = {
  schemaVersion: 1,
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
  components: []
} satisfies ComponentManifest
