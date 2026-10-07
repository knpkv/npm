import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { type RlyStage, StageRail } from "../../src/patterns/StageRail.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const owner = { id: "avery", name: "Avery Diaz", role: "Deployment operator" }
const sixStages = [
  { id: "queued", name: "Queued", state: "Not started", tone: "neutral" },
  { id: "build", name: "Build", reason: "Compiling immutable artifacts.", state: "Building", tone: "progress" },
  { id: "verify", name: "Verify", owner, state: "Verified", tone: "positive" },
  { id: "approval", name: "Approval", reason: "Waiting for a deployment approver.", state: "Held", tone: "caution" },
  { id: "production", name: "Production", reason: "Runbook evidence is missing.", state: "Blocked", tone: "critical" },
  { id: "complete", name: "Complete", state: "Ready", tone: "positive" }
] satisfies ReadonlyArray<RlyStage>

const singleStage = [
  { id: "build", name: "Build", state: "Building", tone: "progress" }
] satisfies ReadonlyArray<RlyStage>
const twentyStages = Array.from({ length: 20 }, (_, index) => ({
  id: `workflow-stage-${index + 1}`,
  name: `Workflow stage ${index + 1}`,
  state: index === 19 ? "Complete" : "Queued",
  tone: index === 19 ? "positive" : "neutral"
})) satisfies ReadonlyArray<RlyStage>

const StageRailStates = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Ordered delivery stages
    </Text>
    <Text tone="secondary">
      Neutral wiring preserves sequence while words, icons, reasons, and named people explain each stage.
    </Text>
    <div style={stackStyle}>
      <StageRail data-stage-fixture="zero" heading="No configured stages" stages={[]} />
      <StageRail data-stage-fixture="one" heading="Single-stage workflow" stages={singleStage} />
      <StageRail data-stage-fixture="six" heading="Release progression" stages={sixStages} />
      <StageRail data-stage-fixture="twenty" heading="Extended workflow" size="compact" stages={twentyStages} />
    </div>
  </main>
)

const CompactCanary = () => (
  <main data-stage-rail-canary="" style={pageStyle}>
    <Text as="h1" variant="section-title">
      Compact stage wiring
    </Text>
    <StageRail heading="Release progression" size="compact" stages={sixStages} />
  </main>
)

const meta = {
  component: StageRail,
  tags: ["autodocs"],
  title: "Patterns/StageRail"
} satisfies Meta<typeof StageRail>

export default meta
type Story = StoryObj<typeof meta>

export const States: Story = {
  args: { heading: "Release progression", stages: [] },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("No stages recorded.")).toBeVisible()
    await expect(canvasElement.querySelectorAll("[data-rly-stage-id]")).toHaveLength(27)
    await expect(canvasElement.querySelectorAll("[data-rly-stage-connector]")).toHaveLength(24)
    for (const state of ["Not started", "Building", "Verified", "Held", "Blocked", "Ready"]) {
      await expect(canvas.getAllByText(state).length).toBeGreaterThan(0)
    }

    const one = canvasElement.querySelector("[data-stage-fixture='one']")
    const six = canvasElement.querySelector("[data-stage-fixture='six']")
    const twenty = canvasElement.querySelector("[data-stage-fixture='twenty']")
    if (one === null || six === null || twenty === null) throw new Error("StageRail cardinality fixture did not render")
    await expect(one.querySelectorAll("[data-rly-stage-id]")).toHaveLength(1)
    await expect(one.querySelector("[data-rly-stage-connector]")).toBeNull()
    const sixStageItems = six.querySelectorAll("[data-rly-stage-id]")
    const sixConnectors = six.querySelectorAll("[data-rly-stage-connector]")
    const sixMarkers = six.querySelectorAll("[data-rly-stage-marker]")
    await expect(sixStageItems).toHaveLength(6)
    await expect(sixConnectors).toHaveLength(5)
    // A 1px rule on its cross axis: horizontal in a row, vertical when the rail stacks on a phone.
    for (const connector of sixConnectors) {
      const box = connector.getBoundingClientRect()
      await expect(Math.min(box.width, box.height)).toBe(1)
    }
    for (const marker of sixMarkers) await expect(marker.getBoundingClientRect().width).toBe(24)
    await expect(twenty.querySelectorAll("[data-rly-stage-id]")).toHaveLength(20)
    await expect(canvas.getByText("Avery Diaz")).toBeVisible()
    await expect(canvas.getByText("Deployment operator")).toBeVisible()
    canvasElement.dataset.stageRailStatesPlayComplete = "true"
  },
  render: () => <StageRailStates />
}

export const CompactForcedColors: Story = {
  args: { heading: "Release progression", size: "compact", stages: sixStages },
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const canary = canvasElement.querySelector<HTMLElement>("[data-stage-rail-canary]")
    if (canary === null) throw new Error("StageRail compact canary did not render")
    const markers = canary.querySelectorAll("[data-rly-stage-marker]")
    const connectors = canary.querySelectorAll("[data-rly-stage-connector]")
    const stages = canary.querySelectorAll("[data-rly-stage-id]")

    await expect(stages).toHaveLength(6)
    await expect(markers).toHaveLength(6)
    await expect(connectors).toHaveLength(5)
    await expect(canary.scrollWidth).toBeLessThanOrEqual(canary.clientWidth)
    for (const marker of markers) await expect(marker.getBoundingClientRect().width).toBe(24)
    // A 1px rule on its cross axis, whichever way the rail lays out at this width.
    for (const connector of connectors) {
      const box = connector.getBoundingClientRect()
      await expect(Math.min(box.width, box.height)).toBe(1)
    }
    for (let index = 1; index < stages.length; index += 1) {
      const previous = stages[index - 1]
      const current = stages[index]
      if (previous === undefined || current === undefined) throw new Error("StageRail stage geometry was incomplete")
      await expect(current.getBoundingClientRect().top).toBeGreaterThan(previous.getBoundingClientRect().top)
    }
    await expect(canvas.getByText("Avery Diaz")).toBeVisible()
    await expect(canvas.getByText("Deployment operator")).toBeVisible()
    canvasElement.dataset.stageRailCompactPlayComplete = "true"
  },
  render: () => <CompactCanary />
}

const releaseStages = [
  { id: "build", name: "Build", state: "succeeded", tone: "positive" },
  { id: "staging", name: "Staging", reason: "integration tests", state: "failed", tone: "critical" },
  { id: "prod", name: "Prod", state: "waiting", tone: "neutral" }
] satisfies ReadonlyArray<RlyStage>
const heldStages = [
  { id: "build", name: "Build", state: "succeeded", tone: "positive" },
  { id: "approval", name: "Approval", reason: "waiting for a deployment approver", state: "held", tone: "caution" },
  { id: "prod", name: "Prod", state: "not started", tone: "neutral" }
] satisfies ReadonlyArray<RlyStage>

/** Stages as words inside list rows: only the blocking and held states take ink. */
export const Words: Story = {
  args: { heading: "Relay 2.4 stages", size: "words", stages: releaseStages },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("list", { name: "Relay 2.4 stages" })).toBeVisible()
    await expect(canvas.queryAllByRole("region")).toHaveLength(0)
    await expect(canvasElement.querySelectorAll("[data-rly-stage-marker]")).toHaveLength(0)
    await expect(canvasElement.querySelectorAll("[data-rly-stage-word='blocked']")).toHaveLength(1)
    await expect(canvasElement.querySelectorAll("[data-rly-stage-word='held']")).toHaveLength(1)
    await expect(canvas.getByText(": integration tests")).toBeVisible()
  },
  render: () => (
    <main style={pageStyle}>
      <Text as="h1" variant="section-title">
        Releases
      </Text>
      <div style={stackStyle}>
        <StageRail heading="Relay 2.4 stages" size="words" stages={releaseStages} />
        <StageRail heading="Agent usage 1.3 stages" size="words" stages={heldStages} />
      </div>
    </main>
  )
}
