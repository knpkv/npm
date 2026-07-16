import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn } from "storybook/test"
import { IconButton } from "../../src/primitives/IconButton.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, rowStyle, stackStyle } from "./storyStyles.js"

const IconButtonStates = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Icon actions
    </Text>
    <div style={stackStyle}>
      <div style={rowStyle}>
        <IconButton
          data-icon-button-size="compact"
          data-icon-button-variant="secondary"
          icon="plus"
          label="Add item"
          size="compact"
        />
        <IconButton data-icon-button-size="default" icon="search" label="Search" />
        <IconButton
          data-icon-button-size="principal"
          data-icon-button-variant="primary"
          icon="arrow-right"
          label="Continue"
          size="principal"
          variant="primary"
        />
      </div>
      <div style={rowStyle}>
        <IconButton disabled icon="menu" label="Menu unavailable" />
        <IconButton icon="loader" label="Loading item" loading />
        <IconButton data-icon-button-variant="quiet" icon="close" label="Close" variant="quiet" />
      </div>
    </div>
  </main>
)

const meta = { component: IconButton, tags: ["autodocs"], title: "Primitives/IconButton" } satisfies Meta<
  typeof IconButton
>
export default meta
type Story = StoryObj<typeof meta>
export const States: Story = {
  args: { icon: "search", label: "Search", onClick: fn() },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("button", { name: "Loading item" })).toBeDisabled()
    await expect(canvas.getByRole("button", { name: "Continue" })).toBeVisible()
    await expect(canvasElement.querySelectorAll("[data-icon-button-variant]")).toHaveLength(3)
    await expect(canvasElement.querySelectorAll("[data-icon-button-size]")).toHaveLength(3)
  },
  render: () => <IconButtonStates />
}
