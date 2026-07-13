import type { Meta, StoryObj } from "@storybook/react-vite"
import { type CSSProperties, type ReactElement, useState } from "react"
import { expect, userEvent, waitFor } from "storybook/test"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import { AgentContextButton } from "../../src/patterns/AgentContextButton.js"
import { AgentDrawer } from "../../src/patterns/AgentDrawer.js"
import { Button } from "../../src/primitives/Button.js"
import { Field } from "../../src/primitives/Field.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--rly-space-8)",
  margin: 0,
  paddingInlineStart: "1.25rem"
}

const EvidenceCardinalities = (): ReactElement => (
  <div style={stackStyle}>
    <Text tone="secondary">Zero missing evidence references</Text>
    <Text>One primary source · PR #184 at 8fa21c7</Text>
    <details>
      <summary>20 supporting records</summary>
      <ol style={listStyle}>
        {Array.from({ length: 20 }, (_, index) => (
          <li key={index}>Evidence record {index + 1}</li>
        ))}
      </ol>
    </details>
  </div>
)

const Capabilities = (): ReactElement => (
  <div style={stackStyle}>
    <Text>Review code in a sandbox</Text>
    <Text>Explain release evidence</Text>
    <Text>Draft a Jira update</Text>
  </div>
)

const DrawerComposer = (): ReactElement => (
  <form onSubmit={(event) => event.preventDefault()}>
    <Field controlId="release-agent-message" label="Ask Release Guardian">
      {(controlProps) => <textarea {...controlProps} defaultValue="Summarize the remaining release risk" rows={4} />}
    </Field>
    <div style={{ marginBlockStart: "var(--rly-space-12)" }}>
      <Button type="submit" variant="primary">
        Send message
      </Button>
    </div>
  </form>
)

const DrawerInteraction = ({ initiallyOpen = false }: { readonly initiallyOpen?: boolean }): ReactElement => {
  const [open, setOpen] = useState(initiallyOpen)
  const [updates, setUpdates] = useState(1)
  return (
    <PortalProvider>
      <main data-agent-drawer-background="" style={pageStyle}>
        <div style={stackStyle}>
          <Text as="h1" variant="section-title">
            A thread that knows this release
          </Text>
          <AgentContextButton
            agentName="Release Guardian"
            context="Release v2.4.0 · Copper Finch · production-eu-west-1"
            job={{ count: 1, status: "Review ready" }}
            onClick={() => setOpen(true)}
          />
        </div>
        <AgentDrawer
          agentName="Release Guardian"
          capabilities={<Capabilities />}
          composer={<DrawerComposer />}
          context={
            <Text tone="secondary">Six Jira items, PR #184, pipeline run 6672, and the current approval state.</Text>
          }
          contextSummary="Release v2.4.0 · Copper Finch"
          evidence={<EvidenceCardinalities />}
          onOpenChange={setOpen}
          open={open}
          thread={
            <div style={stackStyle}>
              <Text>Agent: The release has current build and review evidence.</Text>
              <Text>Live updates {updates}</Text>
              <Button onClick={() => setUpdates((count) => count + 1)} size="compact">
                Add live update
              </Button>
            </div>
          }
          title="Release agent"
        />
      </main>
    </PortalProvider>
  )
}

const meta = {
  component: AgentDrawer,
  tags: ["autodocs"],
  title: "Patterns/AgentDrawer"
} satisfies Meta<typeof AgentDrawer>

export default meta
type Story = StoryObj<typeof meta>

export const Interaction: Story = {
  args: {
    agentName: "Release Guardian",
    capabilities: <Capabilities />,
    composer: <DrawerComposer />,
    context: "Release context",
    contextSummary: "Release v2.4.0 · Copper Finch",
    evidence: <EvidenceCardinalities />,
    onOpenChange: () => undefined,
    open: false,
    thread: "Thread",
    title: "Release agent"
  },
  play: async ({ canvas, canvasElement }) => {
    const launcher = canvas.getByRole("button", { name: /Ask agent.*Release v2.4.0/ })
    await userEvent.click(launcher)
    const dialog = canvas.getByRole("dialog", { name: "Release agent" })
    const summary = canvasElement.querySelector<HTMLElement>('[data-rly-agent-drawer-slot="context"]')
    if (summary === null) throw new Error("AgentDrawer context summary did not render")
    await waitFor(() => expect(dialog).toBeVisible())
    await expect(summary).toHaveFocus()
    await expect(
      [...dialog.querySelectorAll("[data-rly-agent-drawer-slot]")].map((slot) =>
        slot.getAttribute("data-rly-agent-drawer-slot")
      )
    ).toEqual(["context", "evidence", "capabilities", "thread", "composer"])
    const update = canvas.getByRole("button", { name: "Add live update" })
    await userEvent.click(update)
    await expect(canvas.getByText("Live updates 2")).toBeVisible()
    await expect(update).toHaveFocus()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(launcher).toHaveFocus())
    canvasElement.dataset.agentDrawerInteractionPlayComplete = "true"
  },
  render: () => <DrawerInteraction />
}

export const CompactForcedColors: Story = {
  args: {
    agentName: "Release Guardian",
    capabilities: <Capabilities />,
    composer: <DrawerComposer />,
    context: "Release context",
    contextSummary: "Release v2.4.0 · Copper Finch",
    evidence: <EvidenceCardinalities />,
    onOpenChange: () => undefined,
    open: true,
    thread: "Thread",
    title: "Release agent"
  },
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const dialog = canvas.getByRole("dialog", { name: "Release agent" })
    const summary = canvasElement.querySelector<HTMLElement>('[data-rly-agent-drawer-slot="context"]')
    if (summary === null) throw new Error("AgentDrawer compact context did not render")
    await waitFor(() => expect(dialog).toBeVisible())
    await expect(summary).toHaveFocus()
    await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth)
    await expect(canvas.getByText("20 supporting records")).toBeVisible()
    canvasElement.dataset.agentDrawerCompactPlayComplete = "true"
  },
  render: () => <DrawerInteraction initiallyOpen />
}
