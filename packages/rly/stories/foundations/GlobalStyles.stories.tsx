import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { GlobalStyles } from "../../src/foundations/GlobalStyles.js"

const meta = {
  component: GlobalStyles,
  tags: ["autodocs"],
  title: "Foundations/GlobalStyles"
} satisfies Meta<typeof GlobalStyles>

export default meta
type Story = StoryObj<typeof meta>

export const Scope: Story = {
  args: {
    children: <p>One explicit scope. No runtime style injection.</p>
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("One explicit scope. No runtime style injection.")).toBeVisible()
  }
}
