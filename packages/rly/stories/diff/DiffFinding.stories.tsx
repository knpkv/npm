import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties } from "react"
import { expect, fn, userEvent, within } from "storybook/test"
import { DiffFinding, type RlyDiffFinding } from "../../src/diff/DiffFinding.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const agentFinding = {
  anchor: {
    contextHash: "ctx-66f31",
    fileId: "authorize",
    line: 84,
    path: "src/payments/authorize.ts",
    revision: "8fa21c7",
    side: "after",
    state: "current"
  },
  authorName: "Relay reviewer",
  body: "The retry branch creates a fresh idempotency key and can authorize the same payment twice.",
  id: "finding-agent-1",
  severity: "critical",
  source: "agent",
  status: "open",
  title: "Reuse the original idempotency key"
} satisfies RlyDiffFinding

const humanFinding = {
  ...agentFinding,
  authorName: "Mina Chen",
  body: "The audit label should use the customer-facing payment reference.",
  id: "finding-human-1",
  severity: "note",
  source: "human",
  status: "resolved",
  title: "Keep the audit label recognizable"
} satisfies RlyDiffFinding

const staleFinding = {
  ...agentFinding,
  anchor: {
    ...agentFinding.anchor,
    currentRevision: "91bd221",
    reason: "The PR head changed from 8fa21c7 to 91bd221.",
    state: "stale"
  },
  id: "finding-stale-1",
  severity: "warning"
} satisfies RlyDiffFinding

const narrowStyle: CSSProperties = { inlineSize: "100%", maxInlineSize: "320px" }

const meta = {
  args: { finding: agentFinding, onAnchorActivate: fn() },
  component: DiffFinding,
  tags: ["autodocs"],
  title: "Diff/DiffFinding"
} satisfies Meta<typeof DiffFinding>

export default meta
type Story = StoryObj<typeof meta>

export const HumanAndAgent: Story = {
  play: async ({ args, canvas, canvasElement }) => {
    await expect(canvas.getByText("Agent finding · not an approval")).toBeVisible()
    await expect(canvas.getByText("Human finding")).toBeVisible()
    const agentCard = canvasElement.querySelector<HTMLElement>("[data-rly-diff-finding-source='agent']")
    if (agentCard === null) throw new Error("Agent finding did not render")
    await userEvent.click(within(agentCard).getByRole("button", { name: /Open anchor/ }))
    await expect(args.onAnchorActivate).toHaveBeenCalledWith("finding-agent-1")
    canvasElement.dataset.diffFindingSourcesPlayComplete = "true"
  },
  render: (args) => (
    <main style={pageStyle}>
      <Text as="h1" variant="section-title">
        Findings stay attached to evidence
      </Text>
      <div style={stackStyle}>
        <DiffFinding {...args} />
        <DiffFinding finding={humanFinding} onAnchorActivate={args.onAnchorActivate} />
      </div>
    </main>
  )
}

export const StaleAnchor: Story = {
  args: { finding: staleFinding, onAnchorActivate: fn() },
  play: async ({ args, canvas, canvasElement }) => {
    await expect(canvas.getByText("Stale anchor")).toBeVisible()
    await expect(canvas.getByText("The PR head changed from 8fa21c7 to 91bd221.")).toBeVisible()
    await expect(canvas.queryByRole("button")).not.toBeInTheDocument()
    await expect(args.onAnchorActivate).not.toHaveBeenCalled()
    canvasElement.dataset.diffFindingStalePlayComplete = "true"
  },
  render: (args) => (
    <main style={pageStyle}>
      <DiffFinding {...args} />
    </main>
  )
}

export const CompactForcedColors: Story = {
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvasElement }) => {
    const canary = canvasElement.querySelector<HTMLElement>("[data-diff-finding-compact]")
    if (canary === null) throw new Error("DiffFinding compact canary did not render")
    await expect(canary.scrollWidth).toBeLessThanOrEqual(canary.clientWidth)
    canvasElement.dataset.diffFindingCompactPlayComplete = "true"
  },
  render: (args) => (
    <main data-diff-finding-compact="" style={{ ...pageStyle, ...narrowStyle }}>
      <DiffFinding {...args} />
    </main>
  )
}
