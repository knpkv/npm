import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties } from "react"
import { expect, userEvent } from "storybook/test"
import {
  type RlyWorksetGap,
  type RlyWorksetJiraItem,
  type RlyWorksetPipeline,
  type RlyWorksetPullRequestGroup,
  WorksetCard
} from "../../src/patterns/WorksetCard.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const owner = { id: "avery", name: "Avery Diaz", role: "Release owner" }
const author = { id: "blake", name: "Blake Kim", role: "Pull request author" }
const operator = { id: "casey", name: "Casey Singh", role: "Deployment operator" }
const approver = { id: "devon", name: "Devon O'Rourke", role: "Deployment approver" }

const sixJiraItems = Array.from({ length: 6 }, (_, index) => ({
  id: `jira-${index + 1}`,
  key: `OPS-${428 + index}`,
  title:
    index === 0
      ? "Preserve every release relationship across compact views without truncating this deliberately long title"
      : `Release requirement ${index + 1}`,
  state: index === 5 ? "Needs link" : "In progress",
  tone: index === 5 ? "caution" : "progress",
  href: `/jira/OPS-${428 + index}`,
  ...(index === 0 ? { owner } : {})
})) satisfies ReadonlyArray<RlyWorksetJiraItem>

const pullRequestGroups = [
  {
    id: "pr-a",
    title: "Checkout and capture",
    reference: "PR-184",
    state: "Ready for review",
    tone: "progress",
    href: "/pull-requests/184",
    linkedJiraKeys: ["OPS-428", "OPS-429", "OPS-430"],
    author
  },
  {
    id: "pr-b",
    title: "Settlement verification",
    reference: "PR-191",
    state: "Approved",
    tone: "positive",
    href: "/pull-requests/191",
    linkedJiraKeys: ["OPS-430", "OPS-431", "OPS-432"]
  }
] satisfies ReadonlyArray<RlyWorksetPullRequestGroup>

const gaps = [
  {
    id: "gap-ops-433",
    label: "OPS-433 has no CodeCommit pull request",
    reason: "Implementation evidence has not been linked.",
    service: "codecommit"
  }
] satisfies ReadonlyArray<RlyWorksetGap>

const pipelines = [
  {
    id: "pipeline-1842",
    title: "Payments production delivery",
    reference: "Execution #1842",
    state: "Verifying",
    tone: "progress",
    href: "/pipelines/1842",
    stages: [
      { id: "build", name: "Build", state: "Passed", tone: "positive" },
      { id: "verify", name: "Verify", state: "Running", tone: "progress" },
      { id: "production", name: "Production", state: "Waiting", tone: "neutral" }
    ],
    operator,
    approver
  }
] satisfies ReadonlyArray<RlyWorksetPipeline>

const twentyJiraItems = Array.from({ length: 20 }, (_, index) => ({
  id: `bulk-${index + 1}`,
  key: `BULK-${index + 1}`,
  title: `Complete release work item ${index + 1}`,
  state: index === 19 ? "Needs link" : "Queued",
  tone: index === 19 ? "caution" : "neutral"
})) satisfies ReadonlyArray<RlyWorksetJiraItem>

const narrowStyle: CSSProperties = {
  inlineSize: "100%",
  maxInlineSize: "320px"
}

const meta = {
  component: WorksetCard,
  tags: ["autodocs"],
  title: "Patterns/WorksetCard"
} satisfies Meta<typeof WorksetCard>

export default meta
type Story = StoryObj<typeof meta>

export const ReleaseDimensions: Story = {
  args: {
    gaps,
    heading: "Payments release workset",
    jiraItems: sixJiraItems,
    pipelines,
    pullRequestGroups
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[data-rly-workset-dimension]")).toHaveLength(3)
    await expect(canvasElement.querySelectorAll("[data-rly-workset-jira-id]")).toHaveLength(6)
    await expect(canvasElement.querySelectorAll("[data-rly-workset-pr-id]")).toHaveLength(2)
    await expect(canvasElement.querySelectorAll("[data-rly-workset-gap-id]")).toHaveLength(1)
    await expect(canvasElement.querySelectorAll("[data-rly-workset-pipeline-id]")).toHaveLength(1)
    await expect(canvasElement.querySelectorAll("[data-rly-linked-jira-key='OPS-430']")).toHaveLength(2)
    await expect(canvas.getByText("OPS-433 has no CodeCommit pull request")).toBeVisible()
    await expect(canvas.getByText("Casey Singh")).toBeVisible()
    await expect(canvas.getByText("Deployment approver")).toBeVisible()
    for (const provider of ["Jira", "CodeCommit", "CodePipeline"]) {
      await expect(canvas.getAllByRole("img", { name: provider }).length).toBeGreaterThan(0)
    }
    await userEvent.tab()
    await expect(canvasElement.ownerDocument.activeElement?.tagName).toBe("A")
    canvasElement.dataset.worksetCardReleaseDimensionsPlayComplete = "true"
  }
}

export const CardinalitiesForcedColors: Story = {
  args: {
    gaps,
    heading: "Payments release workset",
    jiraItems: sixJiraItems,
    pipelines,
    pullRequestGroups
  },
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const canary = canvasElement.querySelector<HTMLElement>("[data-workset-card-canary]")
    if (canary === null) throw new Error("WorksetCard cardinality canary did not mount")
    for (const count of [0, 1, 6, 20]) {
      const card = canary.querySelector(`[data-cardinality='${count}']`)
      if (card === null) throw new Error(`WorksetCard ${count} cardinality did not mount`)
      await expect(card.querySelectorAll("[data-rly-workset-jira-id]")).toHaveLength(count)
    }
    await expect(canary.scrollWidth).toBeLessThanOrEqual(canary.clientWidth)
    await expect(canvas.getAllByText("No Jira work recorded.").length).toBeGreaterThan(0)
    await expect(canvas.getAllByText("OPS-433 has no CodeCommit pull request").length).toBeGreaterThan(0)
    await expect(
      canvas.getAllByText(
        "Preserve every release relationship across compact views without truncating this deliberately long title"
      ).length
    ).toBeGreaterThan(0)
    canvasElement.dataset.worksetCardCardinalitiesPlayComplete = "true"
  },
  render: () => (
    <main data-workset-card-canary="" style={pageStyle}>
      <Text as="h1" variant="section-title">
        Workset cardinalities
      </Text>
      <div style={{ ...stackStyle, ...narrowStyle }}>
        <WorksetCard
          data-cardinality="0"
          gaps={[]}
          heading="Zero Jira items"
          jiraItems={[]}
          pipelines={[]}
          pullRequestGroups={[]}
        />
        <WorksetCard
          data-cardinality="1"
          gaps={[]}
          heading="One Jira item"
          jiraItems={sixJiraItems.slice(0, 1)}
          pipelines={[]}
          pullRequestGroups={[]}
        />
        <WorksetCard
          data-cardinality="6"
          gaps={gaps}
          heading="Six Jira items"
          jiraItems={sixJiraItems}
          pipelines={pipelines}
          pullRequestGroups={pullRequestGroups}
        />
        <WorksetCard
          data-cardinality="20"
          gaps={gaps}
          heading="Twenty Jira items"
          jiraItems={twentyJiraItems}
          pipelines={[]}
          pullRequestGroups={pullRequestGroups}
        />
      </div>
    </main>
  )
}
