import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties, ReactElement } from "react"
import { expect } from "storybook/test"
import { AgentProposal, type RlyAgentProposal } from "../../src/patterns/AgentProposal.js"
import { StateLabel, type RlyStateTone } from "../../src/primitives/StateLabel.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const proposal = {
  id: "proposal-release-240",
  agent: {
    id: "release-agent",
    name: "Relay agent",
    role: "Release context assistant",
    avatarFallback: "RA"
  },
  capability: "Start a production CodePipeline execution",
  context: "Release v2.4.0 · Copper Finch · PR-184 · six Jira items",
  evidence: [
    { id: "commit", label: "CodeCommit revision", reference: "8fa21c71af41ed69947f9b9f8c7cd4a8d614a760" },
    { id: "approval", label: "Jira approval", reference: "RPS-6307 / approval-119" }
  ],
  expectedRevision: "8fa21c71af41ed69947f9b9f8c7cd4a8d614a760",
  impact: "Deploy one immutable artifact to production-eu-west-1; customer traffic may change.",
  target: "payments-production / pipeline execution"
} satisfies RlyAgentProposal

const stateCatalog = [
  { id: "draft", label: "Draft", tone: "neutral", outcome: "No human decision has been requested." },
  { id: "proposed", label: "Proposed", tone: "progress", outcome: "Waiting for a named human reviewer." },
  {
    id: "superseded",
    label: "Superseded",
    tone: "caution",
    outcome: "A newer expected revision replaced this proposal."
  },
  {
    id: "withdrawn",
    label: "Withdrawn",
    tone: "critical",
    outcome: "The agent withdrew the proposal after evidence changed."
  }
] satisfies ReadonlyArray<{
  readonly id: string
  readonly label: string
  readonly outcome: string
  readonly tone: RlyStateTone
}>

const narrowStyle: CSSProperties = { inlineSize: "100%", maxInlineSize: "320px" }

const meta = {
  component: AgentProposal,
  tags: ["autodocs"],
  title: "Patterns/AgentProposal"
} satisfies Meta<typeof AgentProposal>

export default meta
type Story = StoryObj<typeof meta>

export const States: Story = {
  args: {
    outcome: <Text tone="secondary">Waiting for a named human reviewer.</Text>,
    proposal,
    state: <StateLabel label="Proposed" tone="progress" />
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[data-rly-agent-proposal-id]")).toHaveLength(4)
    await expect(canvas.getAllByText("This is an agent proposal. It is not human authorization.")).toHaveLength(4)
    await expect(canvas.getAllByText(proposal.capability)).toHaveLength(4)
    await expect(canvas.getAllByText(proposal.expectedRevision)).toHaveLength(8)
    await expect(canvas.getByText("Superseded")).toBeVisible()
    canvasElement.dataset.agentProposalStatesPlayComplete = "true"
  },
  render: (): ReactElement => (
    <main style={pageStyle}>
      <Text as="h1" variant="section-title">
        Agent proposals remain proposals
      </Text>
      {stateCatalog.map((entry) => (
        <AgentProposal
          key={entry.id}
          outcome={<Text tone="secondary">{entry.outcome}</Text>}
          proposal={{ ...proposal, id: `proposal-${entry.id}` }}
          state={<StateLabel label={entry.label} tone={entry.tone} />}
        />
      ))}
    </main>
  )
}

export const CompactForcedColors: Story = {
  args: {
    outcome: <Text tone="secondary">Waiting for a named human reviewer.</Text>,
    proposal,
    state: <StateLabel label="Proposed" tone="progress" />
  },
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const canary = canvasElement.querySelector<HTMLElement>("[data-agent-proposal-compact]")
    if (canary === null) throw new Error("AgentProposal compact canary did not render")
    await expect(canary.scrollWidth).toBeLessThanOrEqual(canary.clientWidth)
    await expect(canvas.getByText(proposal.impact)).toBeVisible()
    await expect(canvas.getByText("This is an agent proposal. It is not human authorization.")).toBeVisible()
    canvasElement.dataset.agentProposalCompactPlayComplete = "true"
  },
  render: (args): ReactElement => (
    <main data-agent-proposal-compact="" style={{ ...pageStyle, ...narrowStyle }}>
      <div style={stackStyle}>
        <AgentProposal {...args} />
      </div>
    </main>
  )
}
