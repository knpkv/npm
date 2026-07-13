import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactElement, useState } from "react"
import { expect, userEvent } from "storybook/test"
import { Text } from "../../src/primitives/Text.js"
import { AgentJob } from "../../src/patterns/AgentJob.js"
import { EvidenceStamp } from "../../src/patterns/EvidenceStamp.js"
import { gridStyle, pageStyle, stackStyle } from "../primitives/storyStyles.js"

const context = <p>Release 2.8.0 · PR-191 · production · inspect only; do not mutate repository or delivery state.</p>
const evidence = <EvidenceStamp freshness="current" reference="PR-191@8f6d21a" service="codecommit" />

const StateGallery = (): ReactElement => {
  const [cancellations, setCancellations] = useState(0)
  const requestCancel = () => setCancellations((value) => value + 1)
  return (
    <main style={pageStyle}>
      <Text as="h1" variant="page-title">
        Agent jobs
      </Text>
      <p aria-live="polite">Cancellation requests: {cancellations}</p>
      <div style={gridStyle}>
        <AgentJob
          capability="Review pull request"
          context={context}
          evidence={evidence}
          heading="Review PR-191"
          onCancel={requestCancel}
          provider="Local Codex"
          revision="8f6d21a"
          state="queued"
        />
        <AgentJob
          capability="Review pull request"
          context={context}
          evidence={evidence}
          heading="Review PR-191"
          onCancel={requestCancel}
          progress={64}
          provider="Local Codex"
          revision="8f6d21a"
          sandbox="rly/review-191"
          state="running"
        />
        <AgentJob
          capability="Review pull request"
          context={context}
          evidence={evidence}
          heading="Review PR-191"
          progress={67}
          provider="Local Codex"
          sandbox="rly/review-191"
          state="cancel-requested"
        />
        <AgentJob
          capability="Review pull request"
          context={context}
          evidence={evidence}
          heading="Review PR-191"
          outcome={<p>Review completed with two cited findings and no repository changes.</p>}
          progress={100}
          provider="Local Codex"
          revision="8f6d21a"
          state="succeeded"
        />
        <AgentJob
          capability="Review pull request"
          context={context}
          evidence={evidence}
          heading="Review PR-191"
          outcome={<p>Sandbox checkout failed. No review result was produced.</p>}
          progress={12}
          provider="Local Claude"
          revision="8f6d21a"
          state="failed"
        />
        <AgentJob
          capability="Review pull request"
          context={context}
          evidence={evidence}
          heading="Review PR-191"
          outcome={<p>Cancelled before analysis. No findings were produced.</p>}
          provider="Local Claude"
          sandbox="rly/review-191"
          state="cancelled"
        />
      </div>
    </main>
  )
}

const meta = {
  args: {
    capability: "Review pull request",
    context,
    evidence,
    heading: "Review PR-191",
    progress: 64,
    provider: "Local Codex",
    revision: "8f6d21a",
    sandbox: "rly/review-191",
    state: "running"
  },
  component: AgentJob,
  tags: ["autodocs"],
  title: "Patterns/AgentJob"
} satisfies Meta<typeof AgentJob>

export default meta
type Story = StoryObj<typeof meta>

export const States: Story = {
  play: async ({ canvas, canvasElement }) => {
    const jobs = canvasElement.querySelectorAll("[data-rly-agent-job-state]")
    await expect(jobs).toHaveLength(6)
    for (const state of ["queued", "running", "cancel-requested", "succeeded", "failed", "cancelled"]) {
      await expect(canvasElement.querySelector(`[data-rly-agent-job-state='${state}']`)).not.toBeNull()
    }
    await expect(canvasElement.querySelectorAll("[data-rly-agent-job-outcome]")).toHaveLength(3)
    await expect(canvasElement.querySelector("[data-rly-agent-job-state='cancel-requested'] button")).toBeNull()
    const cancellation = canvas.getAllByRole("button", { name: "Request cancellation" })[0]
    if (cancellation === undefined) throw new Error("AgentJob cancellation control did not mount")
    await userEvent.click(cancellation)
    await expect(canvas.getByText("Cancellation requests: 1")).toBeVisible()
    await expect(canvasElement.ownerDocument.activeElement).toBe(cancellation)
    canvasElement.dataset.agentJobStatesPlayComplete = "true"
  },
  render: () => <StateGallery />
}

export const CompactForcedColors: Story = {
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const canary = canvasElement.querySelector<HTMLElement>("[data-agent-job-canary]")
    if (canary === null) throw new Error("AgentJob compact canary did not mount")
    await expect(canary.scrollWidth).toBeLessThanOrEqual(canary.clientWidth)
    await expect(canvas.getByText("64%")).toBeVisible()
    await userEvent.tab()
    await expect(canvasElement.ownerDocument.activeElement?.tagName).toBe("BUTTON")
    canvasElement.dataset.agentJobCompactForcedColorsPlayComplete = "true"
  },
  render: () => (
    <main data-agent-job-canary="" style={pageStyle}>
      <div style={{ ...stackStyle, inlineSize: "100%", maxInlineSize: "320px" }}>
        <Text as="h1" variant="section-title">
          Compact agent job
        </Text>
        <AgentJob
          capability="Review pull request"
          context={context}
          evidence={evidence}
          heading="Review PR-191"
          onCancel={() => undefined}
          progress={64}
          provider="Local Codex"
          revision="8f6d21a"
          sandbox="rly/review-191"
          state="running"
        />
      </div>
    </main>
  )
}
