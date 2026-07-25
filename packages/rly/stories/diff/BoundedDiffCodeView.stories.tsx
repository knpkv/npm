import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties, ReactElement } from "react"
import { BoundedDiffCodeView } from "../../src/diff/bounded/BoundedDiffCodeView.js"
import type { RlyDiffCodeAnnotation, RlyDiffCodeItem } from "../../src/diff/types.js"

const releaseItem = {
  after: {
    contents: [
      "export const releaseGate = {",
      "  approvedPullRequests: 6,",
      "  blockers: 0,",
      '  verdict: "can-ship"',
      "}",
      ""
    ].join("\n"),
    name: "src/release-gate.ts"
  },
  before: {
    contents: [
      "export const releaseGate = {",
      "  approvedPullRequests: 5,",
      "  blockers: 1,",
      '  verdict: "held"',
      "}",
      ""
    ].join("\n"),
    name: "src/release-gate.ts"
  },
  id: "release-gate"
} satisfies RlyDiffCodeItem

const cardStyle = {
  background: "var(--rly-color-surface-1)",
  border: "1px solid var(--rly-color-border-1)",
  borderRadius: "var(--rly-radius-field)",
  display: "grid",
  gap: "var(--rly-space-8)",
  padding: "var(--rly-space-12)"
} satisfies CSSProperties

const BoundedAnnotationCard = ({
  confidence,
  evidence,
  replacement,
  severity,
  status
}: {
  readonly confidence: string
  readonly evidence: string
  readonly replacement?: string
  readonly severity: string
  readonly status: string
}): ReactElement => (
  <article data-bounded-annotation-status={status} style={cardStyle}>
    <strong>
      {severity} · {confidence} confidence · {status}
    </strong>
    <span>{evidence}</span>
    {replacement === undefined ? null : <span>Replacement: {replacement}</span>}
  </article>
)

const boundedAnnotations = [
  {
    accessibilityLabel: "High confidence draft annotation",
    id: "bounded-draft",
    location: { itemId: "release-gate", lineNumber: 2, side: "additions" },
    render: () => (
      <BoundedAnnotationCard
        confidence="96%"
        evidence="Approval evidence is awaiting a final signature."
        severity="high"
        status="draft"
      />
    )
  },
  {
    accessibilityLabel: "Stale critical annotation",
    id: "bounded-stale",
    location: { itemId: "release-gate", lineNumber: 3, side: "deletions" },
    render: () => (
      <BoundedAnnotationCard
        confidence="89%"
        evidence="This anchor belongs to the earlier blocker projection."
        severity="critical"
        status="stale"
      />
    )
  },
  {
    accessibilityLabel: "Resolved note annotation",
    id: "bounded-resolved",
    location: { itemId: "release-gate", lineNumber: 3, side: "additions" },
    render: () => (
      <BoundedAnnotationCard
        confidence="100%"
        evidence="The blocker ledger and this revision now agree."
        severity="note"
        status="resolved"
      />
    )
  },
  {
    accessibilityLabel: "Dismissed low confidence annotation",
    id: "bounded-dismissed",
    location: { itemId: "release-gate", lineNumber: 4, side: "deletions" },
    render: () => (
      <BoundedAnnotationCard
        confidence="48%"
        evidence="The old line heuristic did not account for durable evidence."
        replacement="Read the signed release verdict projection."
        severity="low"
        status="dismissed"
      />
    )
  },
  {
    accessibilityLabel: "Medium confidence long evidence annotation",
    id: "bounded-long",
    location: { itemId: "release-gate", lineNumber: 4, side: "additions" },
    render: () => (
      <BoundedAnnotationCard
        confidence="84%"
        evidence="Long evidence remains complete in the synchronous renderer: the approval ledger, blocker projection, provider outcome, and signed manifest all reference the same immutable release revision."
        severity="medium"
        status="draft"
      />
    )
  }
] satisfies ReadonlyArray<RlyDiffCodeAnnotation>

const meta = {
  args: { initialItems: [releaseItem] },
  component: BoundedDiffCodeView,
  tags: ["autodocs"],
  title: "Diff/BoundedDiffCodeView"
} satisfies Meta<typeof BoundedDiffCodeView>

export default meta
type Story = StoryObj<typeof meta>

export const Split: Story = {}

export const StackedWrapped: Story = {
  args: { mode: "stacked", wrap: true },
  globals: { theme: "dark", viewport: { isRotated: false, value: "mobile1" } }
}

export const RichAnnotations: Story = {
  args: { annotations: boundedAnnotations },
  play: async ({ canvasElement }) => {
    if (canvasElement.querySelectorAll("[data-rly-diff-annotation]").length !== 5) {
      throw new Error("Synchronous rich annotations did not render completely")
    }
    canvasElement.dataset.boundedDiffRichAnnotationsPlayComplete = "true"
  }
}

export const RichAnnotationsDarkStacked: Story = {
  args: { annotations: boundedAnnotations, mode: "stacked", wrap: true },
  globals: { theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvasElement }) => {
    if (canvasElement.querySelectorAll("[data-rly-diff-annotation]").length !== 5) {
      throw new Error("Dark stacked synchronous annotations did not render completely")
    }
    canvasElement.dataset.boundedDiffRichAnnotationsDarkPlayComplete = "true"
  }
}
