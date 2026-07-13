import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn } from "storybook/test"
import { Button } from "../../src/primitives/Button.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, rowStyle, stackStyle } from "./storyStyles.js"

const ButtonStates = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Text actions
    </Text>
    <div style={stackStyle}>
      <div style={rowStyle}>
        <Button data-button-size="compact" data-button-variant="primary" size="compact" variant="primary">
          Approve
        </Button>
        <Button data-button-size="default" data-button-variant="secondary" leadingIcon="plus">
          Add note
        </Button>
        <Button data-button-variant="quiet" trailingIcon="arrow-right" variant="quiet">
          View detail
        </Button>
      </div>
      <div style={rowStyle}>
        <Button disabled>Unavailable</Button>
        <Button loading>Checking changes</Button>
        <Button data-button-size="principal" size="principal" variant="primary">
          Approve and continue
        </Button>
      </div>
      <Button stretch>This deliberately long action label wraps without losing its accessible target</Button>
    </div>
  </main>
)

const meta = { component: Button, tags: ["autodocs"], title: "Primitives/Button" } satisfies Meta<typeof Button>
export default meta
type Story = StoryObj<typeof meta>
export const States: Story = {
  args: { children: "Approve", onClick: fn() },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("button", { name: "Checking changes" })).toBeDisabled()
    await expect(canvas.getByRole("button", { name: "Approve and continue" })).toBeVisible()
    await expect(canvasElement.querySelectorAll("[data-button-variant]")).toHaveLength(3)
    await expect(canvasElement.querySelectorAll("[data-button-size]")).toHaveLength(3)
  },
  render: () => <ButtonStates />
}
