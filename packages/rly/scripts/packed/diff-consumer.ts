export const renderDiffConsumerImports = (): string =>
  `import {
  type CreateDiffWorkerFactoryOptions,
  DiffCodeView,
  type DiffFileTreeProps,
  DiffFileTree,
  type DiffFindingProps,
  DiffFinding,
  type DiffHeaderProps,
  DiffHeader,
  type DiffWorkbenchProps,
  DiffWorkbench,
  type DiffWorkerProviderProps,
  DiffWorkerProvider,
  RLY_DIFF_THEMES,
  createDiffWorkerFactory,
  normalizeDiffWorkerPoolSize,
  type RlyDiffCodeAnnotation,
  type RlyDiffCodeItem,
  type RlyDiffCodeScrollTarget,
  type RlyDiffCodeSelection,
  type RlyDiffCodeViewHandle,
  type RlyDiffCodeViewProps,
  type RlyDiffFile,
  type RlyDiffFileChange,
  type RlyDiffFileContent,
  type RlyDiffFinding,
  type RlyDiffFindingAnchor,
  type RlyDiffFindingPrevention,
  type RlyDiffFindingPreventionEnforcement,
  type RlyDiffFindingFilter,
  type RlyDiffInventory,
  type RlyDiffLayout,
  type RlyDiffTextFile,
  type RlyDiffWorkbenchFinding,
  type RlyDiffWorkbenchScope
} from "@knpkv/rly/diff"
import * as Diff from "@knpkv/rly/diff"`

export const renderDiffConsumerFixture = (): string =>
  `const packedDiffFile: RlyDiffFile = {
  change: "modified",
  content: { state: "ready" },
  id: "packed-diff-file",
  path: "src/release.ts"
}
const packedDiffInventory: RlyDiffInventory = { files: [packedDiffFile], state: "ready" }
const packedDiffPrevention: RlyDiffFindingPrevention = {
  boundary: "Exclude provider-generated clients.",
  enforcement: "test",
  existingRuleOrConfig: "release revision contract suite",
  invalidFixture: "A changed revision is accepted without a matching evidence record.",
  matcherOrInvariant: "Every changed revision retains an immutable matching evidence record.",
  sourcePaths: ["packages/control-center/src/domain/**"],
  summary: "Keep revision and evidence validation coupled.",
  targetFile: "test/release-revision.test.ts",
  validFixture: "A changed revision includes the matching immutable evidence record."
}
const packedDiffFinding: RlyDiffFinding = {
  anchor: {
    contextHash: "context-7f4c9b1",
    fileId: packedDiffFile.id,
    line: 2,
    path: packedDiffFile.path,
    revision: "7f4c9b1",
    side: "after",
    state: "current"
  },
  authorName: "Release Guardian",
  body: "The release guard now preserves the immutable revision.",
  id: "packed-diff-finding",
  prevention: packedDiffPrevention,
  severity: "note",
  source: "agent",
  status: "open",
  title: "Revision is pinned"
}
const packedDiffCodeItem: RlyDiffCodeItem = {
  after: { contents: "export const revision = '7f4c9b1'\\n", name: "src/release.ts" },
  before: { contents: "export const revision = 'stale'\\n", name: "src/release.ts" },
  id: packedDiffFile.id,
  version: 1
}
const packedDiffCodeViewProps: RlyDiffCodeViewProps = {
  initialItems: [packedDiffCodeItem],
  mode: "split",
  virtualization: "buffered",
  wrap: false
}
type PackedDiffPublicTypes = readonly [
  CreateDiffWorkerFactoryOptions,
  DiffFileTreeProps,
  DiffFindingProps,
  DiffHeaderProps,
  DiffWorkbenchProps,
  DiffWorkerProviderProps,
  RlyDiffCodeAnnotation,
  RlyDiffCodeItem,
  RlyDiffCodeScrollTarget,
  RlyDiffCodeSelection,
  RlyDiffCodeViewHandle,
  RlyDiffCodeViewProps,
  RlyDiffFile,
  RlyDiffFileChange,
  RlyDiffFileContent,
  RlyDiffFinding,
  RlyDiffFindingAnchor,
  RlyDiffFindingPrevention,
  RlyDiffFindingPreventionEnforcement,
  RlyDiffFindingFilter,
  RlyDiffInventory,
  RlyDiffLayout,
  RlyDiffTextFile,
  RlyDiffWorkbenchFinding,
  RlyDiffWorkbenchScope
]
const packedDiffScope: RlyDiffWorkbenchScope = { label: "All changed files", mode: "all-files" }
const packedDiffExports = [
  DiffCodeView,
  DiffWorkerProvider,
  createDiffWorkerFactory,
  normalizeDiffWorkerPoolSize,
  RLY_DIFF_THEMES
]
const packedDiffExportNames = Object.keys(Diff).sort()
const expectedDiffExportNames = [
  "DiffCodeView",
  "DiffFileTree",
  "DiffFinding",
  "DiffHeader",
  "DiffWorkbench",
  "DiffWorkerProvider",
  "RLY_DIFF_THEMES",
  "createDiffWorkerFactory",
  "normalizeDiffWorkerPoolSize"
]
const packedDiffTypeCoverage: PackedDiffPublicTypes | undefined = undefined`

export const renderDiffConsumerMarkup = (): string =>
  `<DiffWorkbench
      findings={[{
        content: <DiffFinding finding={packedDiffFinding} onAnchorActivate={() => undefined} />,
        id: packedDiffFinding.id
      }]}
      header={<DiffHeader
        findingFilter="all"
        heading="Packed complete diff"
        indexedCount={1}
        isWrapped={false}
        layout="split"
        onFindingFilterChange={() => undefined}
        onLayoutChange={() => undefined}
        onWrapChange={() => undefined}
        totalCount={1}
      />}
      inventory={<DiffFileTree
        data={packedDiffInventory}
        heading="Packed changed files"
        onSelectedFileChange={() => undefined}
        selectedFileId={packedDiffFile.id}
      />}
      label="Packed diff review"
      scope={packedDiffScope}
      viewer={<span>Renderer is loaded only in the browser.</span>}
    />`

export const renderDiffConsumerAssertions = (): string =>
  `if (
  !markup.includes("Packed complete diff")
  || !markup.includes("Packed changed files")
  || !markup.includes("Revision is pinned")
  || !markup.includes("Agent finding · not an approval")
  || !markup.includes("Packed diff review")
  || packedDiffCodeViewProps.initialItems.length !== 1
  || packedDiffExports.some((entry) => entry === undefined)
  || JSON.stringify(packedDiffExportNames) !== JSON.stringify(expectedDiffExportNames)
  || packedDiffTypeCoverage !== undefined
) {
  throw new Error("Diff public and SSR contract failed")
}`
