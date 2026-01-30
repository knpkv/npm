import type { Meta, StoryObj } from "@storybook/react"
import { Spinner } from "./Spinner"

const meta: Meta<typeof Spinner> = {
  component: Spinner,
  title: "Components/Spinner"
}

export default meta
type Story = StoryObj<typeof Spinner>

export const Active: Story = {
  args: {
    active: true,
    label: "Loading data..."
  }
}

export const Inactive: Story = {
  args: {
    active: false,
    label: "Hidden"
  }
}
