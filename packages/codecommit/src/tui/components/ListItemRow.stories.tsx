import type { Meta, StoryObj } from "@storybook/react"
import { ListItemRow } from "./ListItemRow"
import { mockPR } from "../mocks"

const meta: Meta<typeof ListItemRow> = {
  component: ListItemRow,
  title: "Components/ListItemRow"
}

export default meta
type Story = StoryObj<typeof ListItemRow>

export const Header: Story = {
  args: {
    item: { type: "header", label: "My Pull Requests", count: 5 },
    selected: false,
    isFirst: true
  }
}

export const Empty: Story = {
  args: {
    item: { type: "empty" },
    selected: false
  }
}

export const PRItem: Story = {
  args: {
    item: { type: "pr", pr: mockPR },
    selected: false
  }
}

export const PRItemSelected: Story = {
  args: {
    item: { type: "pr", pr: mockPR },
    selected: true
  }
}

export const PRConflict: Story = {
  args: {
    item: { type: "pr", pr: { ...mockPR, isMergeable: false } },
    selected: false
  }
}
