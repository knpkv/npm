import type { Meta, StoryObj } from "@storybook/react"
import { DialogHelp } from "./DialogHelp"

const meta: Meta<typeof DialogHelp> = {
  component: DialogHelp,
  title: "Dialogs/Help"
}

export default meta
type Story = StoryObj<typeof DialogHelp>

export const Default: Story = {
  args: {
    onClose: () => console.log("Close")
  }
}
