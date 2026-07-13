import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { StateLabel } from "../../src/primitives/StateLabel.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, rowStyle } from "./storyStyles.js"

const StateLabelGallery = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Visible state labels
    </Text>
    <div style={rowStyle}>
      <StateLabel data-state-label-tone="neutral" label="Not started" />
      <StateLabel data-state-label-size="default" data-state-label-tone="positive" label="Ready" tone="positive" />
      <StateLabel data-state-label-tone="critical" label="Blocked" tone="critical" />
      <StateLabel data-state-label-tone="caution" label="Held" tone="caution" />
      <StateLabel data-state-label-tone="progress" label="Checking" tone="progress" />
    </div>
    <div style={rowStyle}>
      <StateLabel data-state-label-size="compact" label="Compact ready" size="compact" tone="positive" />
      <StateLabel icon="clock" label="Custom indicator" size="compact" />
    </div>
  </main>
)

const meta = { component: StateLabel, tags: ["autodocs"], title: "Primitives/StateLabel" } satisfies Meta<
  typeof StateLabel
>
export default meta
type Story = StoryObj<typeof meta>
export const Gallery: Story = {
  args: { label: "Ready" },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("Blocked")).toBeVisible()
    await expect(canvasElement.querySelectorAll("[data-state-label-tone]")).toHaveLength(5)
    await expect(canvasElement.querySelectorAll("[data-state-label-size]")).toHaveLength(2)
  },
  render: () => <StateLabelGallery />
}
