import type { Meta, StoryObj } from "@storybook/react"
import { StatusRow } from "./StatusRow"
import { Badge } from "./Badge"

const meta: Meta<typeof StatusRow> = {
  component: StatusRow,
  title: "Components/StatusRow"
}

export default meta
type Story = StoryObj<typeof StatusRow>

export const Default: Story = {
  args: {
    label: "Status",
    children: "Active"
  }
}

export const WithBadge: Story = {
  args: {
    label: "State",
    children: <Badge variant="success">Running</Badge>
  }
}
