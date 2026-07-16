import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactElement, useState } from "react"
import { expect, userEvent } from "storybook/test"
import { DiffCodeView } from "../../src/diff/DiffCodeView.js"
import { DiffFileTree, type RlyDiffFile } from "../../src/diff/DiffFileTree.js"
import { DiffFinding, type RlyDiffFinding, type RlyDiffFindingPrevention } from "../../src/diff/DiffFinding.js"
import { DiffHeader, type RlyDiffFindingFilter, type RlyDiffLayout } from "../../src/diff/DiffHeader.js"
import {
  DiffWorkbench,
  type RlyDiffWorkbenchFinding,
  type RlyDiffWorkbenchScope
} from "../../src/diff/DiffWorkbench.js"
import { pageStyle } from "../primitives/storyStyles.js"

const files = [
  { change: "modified", content: { state: "ready" }, id: "authorize", path: "src/payments/authorize.ts" },
  { change: "added", content: { state: "ready" }, id: "idempotency", path: "src/payments/idempotency.ts" },
  {
    change: "renamed",
    content: { state: "ready" },
    id: "audit",
    path: "src/audit/payment-evidence.ts",
    previousPath: "src/audit/payment-log.ts"
  },
  { change: "deleted", content: { reason: "PNG image", state: "binary" }, id: "diagram", path: "docs/old-flow.png" },
  {
    change: "modified",
    content: { reason: "Generated API client", state: "generated" },
    id: "client",
    path: "src/generated/payments.ts"
  },
  {
    change: "modified",
    content: { reason: "Exceeds the 2 MiB viewing limit", state: "oversized" },
    id: "fixture",
    path: "fixtures/payment-ledger.json"
  }
] satisfies ReadonlyArray<RlyDiffFile>

const codeItems = [
  {
    after: {
      contents: "export const authorize = (payment: Payment) => retry(payment, payment.idempotencyKey)\n",
      name: "src/payments/authorize.ts"
    },
    before: {
      contents: "export const authorize = (payment: Payment) => retry(payment, createKey())\n",
      name: "src/payments/authorize.ts"
    },
    id: "authorize"
  },
  {
    after: {
      contents: "export const reuseKey = (payment: Payment) => payment.idempotencyKey\n",
      name: "src/payments/idempotency.ts"
    },
    before: { contents: "", name: "src/payments/idempotency.ts" },
    id: "idempotency"
  },
  {
    after: {
      contents: 'export const evidence = ["PR-184", "RPS-6307"]\n',
      name: "src/audit/payment-evidence.ts"
    },
    before: {
      contents: 'export const evidence = ["PR-184"]\n',
      name: "src/audit/payment-log.ts"
    },
    id: "audit"
  }
]

const DiffPreview = ({
  isWrapped,
  layout,
  selectedFileId
}: {
  readonly isWrapped: boolean
  readonly layout: RlyDiffLayout
  readonly selectedFileId?: string
}): ReactElement => {
  const visibleItems = selectedFileId === undefined ? codeItems : codeItems.filter((item) => item.id === selectedFileId)
  return (
    <div aria-label="Renderable source changes" role="group">
      <DiffCodeView
        key={selectedFileId ?? "all-files"}
        contextLines={1}
        initialItems={visibleItems}
        mode={layout}
        virtualization="strict"
        wrap={isWrapped}
      />
    </div>
  )
}

const agentPrevention = {
  boundary: "Generated clients keep their generator-owned validation contract.",
  enforcement: "test",
  existingRuleOrConfig: "payment retry contract suite",
  invalidFixture: "A gateway retry creates a second authorization key.",
  matcherOrInvariant: "Every retry attempt for one payment reuses its immutable authorization key.",
  sourcePaths: ["packages/payments/src/**"],
  summary: "Keep gateway retries bound to one authorization key.",
  targetFile: "packages/payments/test/retry-contract.test.ts",
  validFixture: "A gateway retry reuses the first attempt's authorization key."
} satisfies RlyDiffFindingPrevention

const findings = [
  {
    anchor: {
      contextHash: "ctx-66f31",
      fileId: "authorize",
      line: 2,
      path: "src/payments/authorize.ts",
      revision: "8fa21c7",
      side: "after",
      state: "current"
    },
    authorName: "Relay reviewer",
    body: "The retry now reuses the immutable payment key, preventing a second authorization.",
    id: "agent-current",
    prevention: agentPrevention,
    severity: "note",
    source: "agent",
    status: "resolved",
    title: "Idempotency is preserved"
  },
  {
    anchor: {
      contextHash: "ctx-103ab",
      fileId: "idempotency",
      line: 1,
      path: "src/payments/idempotency.ts",
      revision: "8fa21c7",
      side: "after",
      state: "current"
    },
    authorName: "Mina Chen",
    body: "Add a regression test for retries after the gateway accepts the first request.",
    id: "human-current",
    severity: "warning",
    source: "human",
    status: "open",
    title: "Cover accepted gateway retries"
  },
  {
    anchor: {
      contextHash: "ctx-old91",
      currentRevision: "8fa21c7",
      fileId: "audit",
      line: 1,
      path: "src/audit/payment-evidence.ts",
      reason: "The file was renamed after this review was recorded.",
      revision: "55c102a",
      side: "before",
      state: "stale"
    },
    authorName: "Relay reviewer",
    body: "The evidence list previously omitted the release candidate ticket.",
    id: "agent-stale",
    prevention: {
      enforcement: "none",
      rationale: "The release evidence policy is domain-specific and cannot be inferred safely from syntax alone.",
      summary: "Keep this invariant in the release review instructions."
    },
    severity: "warning",
    source: "agent",
    status: "open",
    title: "Release evidence changed"
  }
] satisfies ReadonlyArray<RlyDiffFinding>

const WorkbenchHarness = ({
  presentation = "bird-eye"
}: {
  readonly presentation?: "bird-eye" | "compact"
}): ReactElement => {
  const [selectedFileId, setSelectedFileId] = useState<string | undefined>(
    presentation === "compact" ? "authorize" : undefined
  )
  const [layout, setLayout] = useState<RlyDiffLayout>(presentation === "compact" ? "stacked" : "split")
  const [isWrapped, setIsWrapped] = useState(presentation === "compact")
  const [findingFilter, setFindingFilter] = useState<RlyDiffFindingFilter>("all")
  const [notice, setNotice] = useState("3 renderable sources · 3 exceptional files remain visible")
  const visibleFindings = findings.filter((finding) => {
    if (findingFilter === "all") return true
    if (findingFilter === "unresolved") return finding.status === "open"
    return finding.source === findingFilter
  })
  const scope: RlyDiffWorkbenchScope =
    selectedFileId === undefined
      ? { label: "All 6 changed files", mode: "all-files" }
      : {
          fileId: selectedFileId,
          label: files.find((file) => file.id === selectedFileId)?.path ?? selectedFileId,
          mode: "selected-file"
        }
  const findingSlots: ReadonlyArray<RlyDiffWorkbenchFinding> = visibleFindings.map((finding) => ({
    content: (
      <DiffFinding
        finding={finding}
        onAnchorActivate={(findingId) => setNotice(`Opened immutable anchor for ${findingId}`)}
      />
    ),
    id: finding.id
  }))

  return (
    <DiffWorkbench
      findings={findingSlots}
      header={
        <DiffHeader
          findingFilter={findingFilter}
          heading="PR-184 · Payment retries"
          indexedCount={6}
          isWrapped={isWrapped}
          layout={layout}
          onFindingFilterChange={setFindingFilter}
          onLayoutChange={setLayout}
          onWrapChange={setIsWrapped}
          {...(selectedFileId === undefined ? {} : { selectedFileLabel: scope.label })}
          totalCount={6}
        />
      }
      inventory={
        <DiffFileTree
          data={{ files, state: "ready" }}
          heading="PR-184 files"
          onSelectedFileChange={setSelectedFileId}
          {...(selectedFileId === undefined ? {} : { selectedFileId })}
        />
      }
      label="PR-184 complete diff review"
      onShowAllFiles={() => setSelectedFileId(undefined)}
      scope={scope}
      statusNotice={notice}
      viewer={
        <DiffPreview
          isWrapped={isWrapped}
          layout={layout}
          {...(selectedFileId === undefined ? {} : { selectedFileId })}
        />
      }
    />
  )
}

const meta = {
  component: DiffWorkbench,
  tags: ["autodocs"],
  title: "Diff/DiffWorkbench"
} satisfies Meta<typeof DiffWorkbench>

export default meta
type Story = StoryObj<typeof meta>

export const BirdEyeReview: Story = {
  args: {
    findings: [],
    header: null,
    inventory: null,
    label: "PR-184 complete diff review",
    scope: { label: "All 6 changed files", mode: "all-files" },
    viewer: null
  },
  play: async ({ canvas, canvasElement }) => {
    const workbench = canvas.getByRole("region", { name: "PR-184 complete diff review" })
    await expect(workbench).toHaveAttribute("data-rly-diff-scope", "all-files")
    await expect(canvasElement.querySelectorAll("[data-rly-diff-file-id]")).toHaveLength(6)
    await expect(canvasElement.querySelectorAll("[data-rly-diff-finding-source]")).toHaveLength(3)
    await expect(canvasElement.querySelector("[data-rly-diff-finding-anchor='stale']")).not.toBeNull()
    await expect(canvas.getByRole("group", { name: "Renderable source changes" })).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: /File 2 of 6/ }))
    await expect(workbench).toHaveAttribute("data-rly-diff-scope", "selected-file")
    await expect(workbench).toHaveTextContent("src/payments/idempotency.ts")
    await userEvent.click(canvas.getByRole("button", { name: "Show all files" }))
    await expect(workbench).toHaveAttribute("data-rly-diff-scope", "all-files")
    await expect(canvasElement.querySelectorAll("diffs-container")).toHaveLength(3)
    const firstCodeRegion = canvasElement.querySelector("diffs-container")?.shadowRoot?.querySelector("code[data-code]")
    await expect(firstCodeRegion).toHaveAttribute("tabindex", "0")
    canvasElement.dataset.diffWorkbenchBirdEyePlayComplete = "true"
  },
  render: () => (
    <main style={pageStyle}>
      <div style={{ inlineSize: "100%", maxInlineSize: "96rem" }}>
        <WorkbenchHarness />
      </div>
    </main>
  )
}

export const CompactForcedColors: Story = {
  args: {
    findings: [],
    header: null,
    inventory: null,
    label: "Compact PR diff review",
    scope: { label: "src/payments/authorize.ts", mode: "all-files" },
    viewer: null
  },
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvasElement }) => {
    const canary = canvasElement.querySelector<HTMLElement>("[data-diff-workbench-compact]")
    if (canary === null) throw new Error("DiffWorkbench compact canary did not render")
    await expect(canary.scrollWidth).toBeLessThanOrEqual(canary.clientWidth)
    await expect(canary.querySelector("[data-rly-diff-scope='selected-file']")).not.toBeNull()
    canvasElement.dataset.diffWorkbenchCompactPlayComplete = "true"
  },
  render: () => (
    <main data-diff-workbench-compact="" style={{ ...pageStyle, inlineSize: "100%", maxInlineSize: "320px" }}>
      <WorkbenchHarness presentation="compact" />
    </main>
  )
}

const staleFindings = Array.from({ length: 12 }, (_, index): RlyDiffFinding => {
  const finding = {
    anchor: {
      contextHash: `ctx-stale-${index}`,
      currentRevision: "8fa21c7",
      fileId: "audit",
      line: index + 1,
      path: "src/audit/payment-evidence.ts",
      reason: "A newer revision replaced this immutable review anchor.",
      revision: "55c102a",
      side: "before",
      state: "stale"
    },
    authorName: index % 2 === 0 ? "Relay reviewer" : "Mina Chen",
    body: `Preserved review evidence ${index + 1} remains readable after the source revision changed.`,
    id: `stale-${index}`,
    severity: index % 3 === 0 ? "warning" : "note",
    status: "open",
    title: `Historical finding ${index + 1}`
  } satisfies Pick<RlyDiffFinding, "anchor" | "authorName" | "body" | "id" | "severity" | "status" | "title">
  return index % 2 === 0
    ? { ...finding, prevention: agentPrevention, source: "agent" }
    : { ...finding, source: "human" }
})

export const StaticFindingsOverflow: Story = {
  args: {
    findings: [],
    header: null,
    inventory: null,
    label: "Static findings keyboard review",
    scope: { label: "All 6 changed files", mode: "all-files" },
    viewer: null
  },
  play: async ({ canvas }) => {
    const list = canvas.getByRole("list", { name: "Historical findings list" })
    list.focus()
    await expect(list).toHaveFocus()
    await userEvent.keyboard("{PageDown}")
  },
  render: () => (
    <main style={pageStyle}>
      <DiffWorkbench
        findings={staleFindings.map((finding) => ({
          content: <DiffFinding finding={finding} onAnchorActivate={() => undefined} />,
          id: finding.id
        }))}
        findingsLabel="Historical findings"
        header={<header>PR-184 · preserved review evidence</header>}
        inventory={<nav>Six changed files</nav>}
        label="Static findings keyboard review"
        scope={{ label: "All 6 changed files", mode: "all-files" }}
        viewer={<div>Complete source changes</div>}
      />
    </main>
  )
}
