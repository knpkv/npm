import type { Meta, StoryObj } from "@storybook/react"
import { Badge } from "./Badge"

const meta: Meta<typeof Badge> = {
  component: Badge,
  title: "Components/Badge"
}

export default meta
type Story = StoryObj<typeof Badge>

export const Success: Story = {
  args: {
    children: "Approved",
    variant: "success"
  }
}

export const Error: Story = {
  args: {
    children: "Failed",
    variant: "error"
  }
}

export const Info: Story = {
  args: {
    children: "In Progress",
    variant: "info"
  }
}

export const Outline: Story = {
  args: {
    children: "Draft",
    variant: "outline"
  }
}
