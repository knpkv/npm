/** Git change kinds understood by the visual change classifier. */
export type ChangedFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged"
  | "unknown"

/** One decoded changed-file record. Git and filesystem access stay outside this module. */
export interface ChangedFile {
  readonly path: string
  readonly previousPath?: string
  readonly status: ChangedFileStatus
}

/** Files that unambiguously belong to one public component's visual surface. */
export interface VisualComponentTarget {
  readonly name: string
  readonly paths: {
    readonly source: string
    readonly story: string
    readonly styles: ReadonlyArray<string>
    readonly tests: ReadonlyArray<string>
  }
  readonly storyId: string
}

/** Versioned component lookup projected from the checked-in component manifest. */
export interface VisualCatalog {
  readonly components: ReadonlyArray<VisualComponentTarget>
  readonly schemaVersion: 1
}

/** Inputs to the pure, deterministic visual change classifier. */
export interface ClassifyVisualChangesInput {
  readonly baseCatalog?: VisualCatalog
  readonly changes: ReadonlyArray<ChangedFile>
  readonly componentLimit?: number
  readonly currentCatalog: VisualCatalog
}

/** Fail-safe visual scope selected for a set of repository changes. */
export type VisualClassification =
  | {
    readonly reason: "documentation-only" | "no-changes"
    readonly scope: "skip"
  }
  | {
    readonly components: ReadonlyArray<{
      readonly name: string
      readonly states: readonly ["closed", "open", "focus"]
      readonly storyId: string
    }>
    readonly reasons: ReadonlyArray<string>
    readonly scope: "component-scoped"
  }
  | {
    readonly reasons: ReadonlyArray<string>
    readonly scope: "full"
  }

type ComponentPathRole = "source" | "story" | "style" | "test"

interface IndexedComponentPath {
  readonly component: VisualComponentTarget
  readonly role: ComponentPathRole
}

interface CatalogIndex {
  readonly byName: ReadonlyMap<string, VisualComponentTarget>
  readonly byPath: ReadonlyMap<string, IndexedComponentPath>
  readonly valid: boolean
}

const CAPTURE_STATES: readonly ["closed", "open", "focus"] = ["closed", "open", "focus"]
const DEFAULT_COMPONENT_LIMIT = 8

const isUnsafePath = (path: string): boolean => {
  if (path.length === 0 || path.startsWith("/") || path.startsWith("./") || path.includes("\\")) return true
  if (path.split("/").includes("..")) return true
  for (const character of path) {
    const code = character.codePointAt(0)
    if (code !== undefined && (code < 32 || code === 127)) return true
  }
  return false
}

const isDocumentationPath = (path: string): boolean => {
  if (path.startsWith("packages/rly/stories/")) return false
  if (path.startsWith(".changeset/") || path.startsWith(".specs/") || path.startsWith("packages/docs/")) {
    return path.endsWith(".md") || path.endsWith(".mdx")
  }
  if (path === "README.md" || path === "CHANGELOG.md" || path === "LICENSE") return true
  return path.startsWith("packages/rly/") && (path.endsWith(".md") || path.endsWith(".mdx"))
}

const isFullRiskPath = (path: string): boolean => {
  if (path === "pnpm-lock.yaml" || path === "packages/rly/package.json") return true
  if (path === "packages/rly/component-manifest.ts") return true
  if (path.startsWith("packages/rly/.storybook/") || path.startsWith("packages/rly/visual/")) return true
  if (path.startsWith("packages/rly/scripts/") || path.startsWith("packages/rly/generated/")) return true
  if (path.startsWith("packages/rly/src/tokens/") || path.startsWith("packages/rly/src/foundations/")) return true
  if (path.startsWith("packages/rly/src/diff/") || path.startsWith("packages/rly/src/styles/")) return true
  return /^packages\/rly\/(?:vite|vitest|playwright)(?:\.[^/]+)*\.config\.[^/]+$/.test(path)
}

const componentPaths = (
  component: VisualComponentTarget
): ReadonlyArray<readonly [string, ComponentPathRole]> => [
  [component.paths.source, "source"],
  [component.paths.story, "story"],
  ...component.paths.styles.map((path): readonly [string, ComponentPathRole] => [path, "style"]),
  ...component.paths.tests.map((path): readonly [string, ComponentPathRole] => [path, "test"])
]

const indexCatalog = (catalog: VisualCatalog): CatalogIndex => {
  const byName = new Map<string, VisualComponentTarget>()
  const byPath = new Map<string, IndexedComponentPath>()
  let valid = catalog.schemaVersion === 1

  for (const component of catalog.components) {
    if (component.name.length === 0 || component.storyId.length === 0 || byName.has(component.name)) valid = false
    byName.set(component.name, component)
    for (const [path, role] of componentPaths(component)) {
      if (isUnsafePath(path) || byPath.has(path)) valid = false
      byPath.set(path, { component, role })
    }
  }

  return { byName, byPath, valid }
}

const full = (reasons: ReadonlySet<string>): VisualClassification => ({
  reasons: [...reasons].sort(),
  scope: "full"
})

const pathRole = (index: CatalogIndex, path: string): IndexedComponentPath | undefined => index.byPath.get(path)

/**
 * Classify changed files into no visual work, component-only captures, or the
 * complete high-risk matrix. Any ambiguity deliberately expands to full.
 */
export const classifyVisualChanges = (input: ClassifyVisualChangesInput): VisualClassification => {
  if (input.changes.length === 0) return { reason: "no-changes", scope: "skip" }

  const componentLimit = input.componentLimit ?? DEFAULT_COMPONENT_LIMIT
  const current = indexCatalog(input.currentCatalog)
  const base = input.baseCatalog === undefined ? undefined : indexCatalog(input.baseCatalog)
  const fullReasons = new Set<string>()
  const components = new Map<string, VisualComponentTarget>()
  let sawNonDocumentation = false

  const hasValidComponentLimit = Number.isSafeInteger(componentLimit) && componentLimit >= 1
  if (!hasValidComponentLimit) fullReasons.add("invalid-component-limit")
  if (!current.valid || (base !== undefined && !base.valid)) fullReasons.add("invalid-visual-catalog")

  const sortedChanges = [...input.changes].sort((left, right) => {
    const pathOrder = left.path.localeCompare(right.path)
    if (pathOrder !== 0) return pathOrder
    const previousOrder = (left.previousPath ?? "").localeCompare(right.previousPath ?? "")
    return previousOrder !== 0 ? previousOrder : left.status.localeCompare(right.status)
  })

  const addComponent = (component: VisualComponentTarget): void => {
    components.set(component.name, component)
  }

  for (const change of sortedChanges) {
    const previousPath = change.previousPath
    if (isUnsafePath(change.path) || (previousPath !== undefined && isUnsafePath(previousPath))) {
      fullReasons.add("unsafe-path")
      continue
    }

    if (change.status === "type-changed" || change.status === "unmerged" || change.status === "unknown") {
      fullReasons.add("unsupported-status")
      continue
    }

    if (change.status === "copied") {
      if (previousPath !== undefined && isDocumentationPath(previousPath) && isDocumentationPath(change.path)) {
        continue
      }
      sawNonDocumentation = true
      fullReasons.add("copied-file")
      continue
    }

    if (change.status === "renamed") {
      if (previousPath === undefined) {
        fullReasons.add("malformed-rename")
        continue
      }
      if (isDocumentationPath(previousPath) && isDocumentationPath(change.path)) continue
      sawNonDocumentation = true
      if (isFullRiskPath(previousPath) || isFullRiskPath(change.path)) {
        fullReasons.add("full-risk-path")
        continue
      }
      if (base === undefined) {
        fullReasons.add("missing-base-catalog")
        continue
      }
      const before = pathRole(base, previousPath)
      const after = pathRole(current, change.path)
      if (
        before === undefined ||
        after === undefined ||
        before.component.name !== after.component.name ||
        before.role !== after.role
      ) {
        fullReasons.add("ambiguous-component-rename")
        continue
      }
      addComponent(after.component)
      continue
    }

    if (isDocumentationPath(change.path)) continue
    sawNonDocumentation = true

    if (isFullRiskPath(change.path)) {
      fullReasons.add("full-risk-path")
      continue
    }

    if (change.status === "deleted") {
      if (base === undefined) {
        fullReasons.add("missing-base-catalog")
        continue
      }
      const before = pathRole(base, change.path)
      if (before === undefined) {
        fullReasons.add("unknown-path")
        continue
      }
      const remaining = current.byName.get(before.component.name)
      if (remaining === undefined || before.role === "source" || before.role === "story") {
        fullReasons.add("deleted-component-entry")
        continue
      }
      addComponent(remaining)
      continue
    }

    const target = pathRole(current, change.path)
    if (target === undefined) {
      if (change.path.endsWith(".css")) fullReasons.add("shared-style")
      else fullReasons.add("unknown-path")
      continue
    }
    addComponent(target.component)
  }

  if (hasValidComponentLimit && components.size > componentLimit) fullReasons.add("component-limit-exceeded")
  if (fullReasons.size > 0) return full(fullReasons)

  if (components.size > 0) {
    return {
      components: [...components.values()].sort((left, right) => left.name.localeCompare(right.name)).map(
        (component) => ({ name: component.name, states: CAPTURE_STATES, storyId: component.storyId })
      ),
      reasons: ["component-file-change"],
      scope: "component-scoped"
    }
  }

  return sawNonDocumentation ? full(new Set(["unknown-change"])) : { reason: "documentation-only", scope: "skip" }
}
