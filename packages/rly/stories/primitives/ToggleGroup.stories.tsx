import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { ToggleGroup, type ToggleGroupProps } from "../../src/primitives/ToggleGroup.js"

const ranges = [
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" }
]

const Controlled = (props: Omit<ToggleGroupProps, "onValueChange" | "value"> & { readonly initial: string }) => {
  const { initial, ...rest } = props
  const [value, setValue] = useState(initial)
  return <ToggleGroup {...rest} onValueChange={setValue} value={value} />
}

const meta = {
  component: ToggleGroup,
  tags: ["autodocs"],
  title: "Primitives/ToggleGroup"
} satisfies Meta<typeof ToggleGroup>
export default meta
type Story = StoryObj<typeof meta>

export const Interaction: Story = {
  args: { "aria-label": "Range", items: ranges, onValueChange: () => undefined, value: "7d" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getAllByRole("radio", { name: "30d" })[0] ?? canvasElement)
    await expect(canvas.getAllByRole("radio", { name: "30d" })[0]).toHaveAttribute("aria-checked", "true")
  },
  render: (args) => (
    <div style={{ display: "grid", gap: "var(--rly-space-16)" }}>
      <Controlled aria-label={args["aria-label"]} initial="7d" items={args.items} />
      <Controlled aria-label={`${args["aria-label"]} (compact)`} initial="24h" items={args.items} size="compact" />
      <Controlled aria-label={`${args["aria-label"]} (default)`} initial="30d" items={args.items} size="default" />
    </div>
  )
}
