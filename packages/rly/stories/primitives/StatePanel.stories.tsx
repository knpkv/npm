import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { Button } from "../../src/primitives/Button.js"
import { StatePanel } from "../../src/primitives/StatePanel.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "./storyStyles.js"

const StatePanelGallery = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Outcome explanations
    </Text>
    <div style={stackStyle}>
      <StatePanel data-state-panel-tone="neutral" description="No automated checks have started." title="Waiting" />
      <StatePanel
        data-state-panel-tone="positive"
        description="All required checks completed successfully."
        title="Ready"
        tone="positive"
      />
      <StatePanel
        action={<Button size="compact">Review details</Button>}
        data-state-panel-tone="critical"
        description="One required check needs attention before continuing."
        title="Blocked"
        tone="critical"
      />
      <StatePanel
        data-state-panel-tone="caution"
        description="A reviewer paused this change for clarification."
        title="Held for review"
        tone="caution"
      />
      <StatePanel
        announce="polite"
        data-state-panel-tone="progress"
        description="Checks are still running. Layout remains stable while the result changes."
        title="Checking changes"
        tone="progress"
      />
    </div>
  </main>
)

const meta = { component: StatePanel, tags: ["autodocs"], title: "Primitives/StatePanel" } satisfies Meta<
  typeof StatePanel
>
export default meta
type Story = StoryObj<typeof meta>
export const Gallery: Story = {
  args: { title: "Waiting" },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("Blocked")).toBeVisible()
    await expect(canvas.getByRole("status")).toHaveTextContent("Checking changes")
    await expect(canvasElement.querySelectorAll("[data-state-panel-tone]")).toHaveLength(5)
  },
  render: () => <StatePanelGallery />
}
