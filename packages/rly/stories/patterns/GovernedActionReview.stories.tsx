import type { Meta, StoryObj } from "@storybook/react-vite"
import { type CSSProperties, type ReactElement, useState } from "react"
import { expect, userEvent } from "storybook/test"
import type { RlyAgentProposal } from "../../src/patterns/AgentProposal.js"
import { GovernedActionReview, type RlyGovernedActionState } from "../../src/patterns/GovernedActionReview.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle } from "../primitives/storyStyles.js"

const proposal = {
  id: "proposal-release-240",
  agent: {
    id: "release-agent",
    name: "Relay agent",
    role: "Release context assistant",
    avatarFallback: "RA"
  },
  capability: "Start a production CodePipeline execution",
  context: "Release v2.4.0 · Copper Finch",
  evidence: [
    { id: "commit", label: "CodeCommit revision", reference: "8fa21c71af41ed69947f9b9f8c7cd4a8d614a760" },
    { id: "approval", label: "Jira approval", reference: "RPS-6307 / approval-119" }
  ],
  expectedRevision: "8fa21c71af41ed69947f9b9f8c7cd4a8d614a760",
  impact: "Deploy one immutable artifact to production-eu-west-1; customer traffic may change.",
  target: "payments-production / pipeline execution"
} satisfies RlyAgentProposal

const reviewer = { id: "dev-shah", name: "Dev Shah", role: "Production authorizer" }
const confirmationLabel = "I confirm revision 8fa21c71 targets payments-production and may change customer traffic."

const ControlledReview = (): ReactElement => {
  const [isConfirmed, setConfirmed] = useState(false)
  const [message, setMessage] = useState("No decision recorded.")
  return (
    <main style={pageStyle}>
      <Text aria-live="polite" data-review-status="" role="status" tone="secondary">
        {message}
      </Text>
      <GovernedActionReview
        confirmationLabel={confirmationLabel}
        isConfirmed={isConfirmed}
        onAuthorize={() => setMessage("Human authorization callback requested.")}
        onConfirmationChange={setConfirmed}
        onReject={() => setMessage("Human rejection callback requested.")}
        outcome={<Text tone="secondary">No decision recorded.</Text>}
        proposal={proposal}
        reviewer={reviewer}
        state="pending"
      />
    </main>
  )
}

const terminalStates = [
  ["rejected", "Dev rejected the proposal; no provider action started."],
  ["authorized", "Dev authorized this exact proposal; execution has not started."],
  ["executing", "The human-authorized action is executing as pipeline run 1842."],
  ["succeeded", "Pipeline run 1842 completed successfully."],
  ["failed", "Pipeline run 1842 failed during production verification."],
  ["cancelled", "Dev cancelled the authorized action before production deployment."]
] satisfies ReadonlyArray<readonly [RlyGovernedActionState, string]>

const narrowStyle: CSSProperties = { inlineSize: "100%", maxInlineSize: "320px" }

const meta = {
  component: GovernedActionReview,
  tags: ["autodocs"],
  title: "Patterns/GovernedActionReview"
} satisfies Meta<typeof GovernedActionReview>

export default meta
type Story = StoryObj<typeof meta>

export const Confirmation: Story = {
  args: {
    confirmationLabel,
    isConfirmed: false,
    onAuthorize: () => undefined,
    onConfirmationChange: () => undefined,
    onReject: () => undefined,
    outcome: <Text tone="secondary">No decision recorded.</Text>,
    proposal,
    reviewer,
    state: "pending"
  },
  play: async ({ canvas, canvasElement }) => {
    const authorize = canvas.getByRole("button", { name: "Authorize exact action" })
    await expect(authorize).toBeDisabled()
    await userEvent.tab()
    await expect(canvas.getByRole("checkbox")).toHaveFocus()
    await userEvent.keyboard(" ")
    await expect(canvas.getByRole("checkbox")).toBeChecked()
    await expect(authorize).toBeEnabled()
    await userEvent.tab()
    await expect(canvas.getByRole("button", { name: "Reject proposal" })).toHaveFocus()
    await userEvent.tab()
    await expect(authorize).toHaveFocus()
    await userEvent.keyboard("{Enter}")
    await expect(canvas.getByRole("status")).toHaveTextContent("Human authorization callback requested.")
    canvasElement.dataset.governedActionConfirmationPlayComplete = "true"
  },
  render: () => <ControlledReview />
}

export const TerminalStates: Story = {
  args: {
    confirmationLabel,
    isConfirmed: false,
    onAuthorize: () => undefined,
    onConfirmationChange: () => undefined,
    onReject: () => undefined,
    outcome: <Text tone="secondary">No decision recorded.</Text>,
    proposal,
    reviewer,
    state: "pending"
  },
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const canary = canvasElement.querySelector<HTMLElement>("[data-governed-terminal-canary]")
    if (canary === null) throw new Error("GovernedActionReview terminal-state canary did not render")
    await expect(canary.scrollWidth).toBeLessThanOrEqual(canary.clientWidth)
    await expect(canary.querySelectorAll("[data-rly-governed-action-state]")).toHaveLength(6)
    await expect(canvas.queryByRole("button", { name: "Authorize exact action" })).toBeNull()
    for (const [state, outcome] of terminalStates) {
      await expect(canvasElement.querySelector(`[data-rly-governed-action-state='${state}']`)).not.toBeNull()
      await expect(canvas.getByText(outcome)).toBeVisible()
    }
    canvasElement.dataset.governedActionTerminalStatesPlayComplete = "true"
  },
  render: (): ReactElement => (
    <main data-governed-terminal-canary="" style={{ ...pageStyle, ...narrowStyle }}>
      <Text as="h1" variant="section-title">
        Governed action outcomes
      </Text>
      {terminalStates.map(([state, outcome]) => (
        <GovernedActionReview
          confirmationLabel={confirmationLabel}
          isConfirmed={false}
          key={state}
          onAuthorize={() => undefined}
          onConfirmationChange={() => undefined}
          onReject={() => undefined}
          outcome={<Text tone="secondary">{outcome}</Text>}
          proposal={{ ...proposal, id: `proposal-${state}` }}
          reviewer={reviewer}
          state={state}
        />
      ))}
    </main>
  )
}
