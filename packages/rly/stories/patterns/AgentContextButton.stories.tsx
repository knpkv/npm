import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties, ReactElement } from "react"
import { expect, fn, userEvent } from "storybook/test"
import { AgentContextButton, type AgentContextButtonProps } from "../../src/patterns/AgentContextButton.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const wideStack: CSSProperties = { ...stackStyle, inlineSize: "100%", maxWidth: "64rem" }
const compact: CSSProperties = { inlineSize: "100%", maxInlineSize: "320px" }

const ContextCatalog = ({
  onActivate
}: {
  readonly onActivate: NonNullable<AgentContextButtonProps["onClick"]>
}): ReactElement => (
  <main style={pageStyle}>
    <div style={wideStack}>
      <Text as="h1" variant="section-title">
        Explicit agent contexts
      </Text>
      <AgentContextButton
        agentName="Release Guardian"
        context="Release v2.4.0 · Copper Finch · production-eu-west-1"
        onClick={onActivate}
      />
      <AgentContextButton
        agentName="Code reviewer"
        context="CodeCommit PR #184 · payments-api · 8fa21c7"
        job={{ count: 1, status: "Review running" }}
      />
      <AgentContextButton
        agentName="Issue companion"
        context="Jira RLY-240 · Prepare payment authorization rollout"
        job={{ count: 20, status: "Checks queued" }}
      />
    </div>
  </main>
)

const meta = {
  component: AgentContextButton,
  tags: ["autodocs"],
  title: "Patterns/AgentContextButton"
} satisfies Meta<typeof AgentContextButton>

export default meta
type Story = StoryObj<typeof meta>

export const Contexts: Story = {
  args: { agentName: "Release Guardian", context: "Release v2.4.0", onClick: fn() },
  play: async ({ args, canvas, canvasElement }) => {
    const launchers = canvas.getAllByRole("button")
    await expect(launchers).toHaveLength(3)
    await expect(canvas.getByText("Release v2.4.0 · Copper Finch · production-eu-west-1")).toBeVisible()
    await expect(canvasElement.querySelectorAll("[data-rly-agent-job]")).toHaveLength(2)
    const firstLauncher = launchers[0]
    if (firstLauncher === undefined) throw new Error("AgentContextButton primary fixture did not mount")
    await userEvent.click(firstLauncher)
    await expect(args.onClick).toHaveBeenCalledTimes(1)
    canvasElement.dataset.agentContextButtonContextsPlayComplete = "true"
  },
  render: (args) => <ContextCatalog onActivate={args.onClick ?? (() => undefined)} />
}

export const CompactForcedColors: Story = {
  args: {
    agentName: "Release Guardian",
    context: "Release v2.4.0 · The Deliberately Long Copper Finch Identity · production-eu-west-1",
    job: { count: 20, status: "Evidence checks waiting for review" }
  },
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const boundary = canvasElement.querySelector<HTMLElement>("[data-agent-context-compact]")
    if (boundary === null) throw new Error("AgentContextButton compact boundary did not mount")
    await expect(boundary.scrollWidth).toBeLessThanOrEqual(boundary.clientWidth)
    await expect(canvas.getByRole("button")).toHaveAccessibleName(/Release v2.4.0/)
    await userEvent.tab()
    await expect(canvas.getByRole("button")).toHaveFocus()
    canvasElement.dataset.agentContextButtonCompactPlayComplete = "true"
  },
  render: (args) => (
    <main style={pageStyle}>
      <div data-agent-context-compact="" style={compact}>
        <AgentContextButton {...args} />
      </div>
    </main>
  )
}
