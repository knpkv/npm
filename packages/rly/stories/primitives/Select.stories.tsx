import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactElement, useState } from "react"
import { expect, fn, userEvent } from "storybook/test"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import { Select, type RlySelectOption } from "../../src/primitives/Select.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "./storyStyles.js"

const options = [
  { label: "Development", value: "development" },
  { label: "Staging", value: "staging" },
  { disabled: true, label: "Production unavailable", value: "production" }
] satisfies ReadonlyArray<RlySelectOption>
const longOption = [
  {
    label: "Integration verification environment with an intentionally unbroken identifier 4f9bb31a92cb47cba",
    value: "long"
  }
] satisfies ReadonlyArray<RlySelectOption>

const ControlledSelect = (): ReactElement => {
  const [value, setValue] = useState<string | undefined>(undefined)
  return (
    <PortalProvider>
      <main style={pageStyle}>
        <Text as="h1" variant="section-title">
          Controlled selection
        </Text>
        <div style={stackStyle}>
          <Select aria-label="Environment" onValueChange={setValue} options={options} value={value} />
          <Select aria-label="Compact environment" defaultValue="development" options={options} size="compact" />
          <Select aria-label="Disabled environment" disabled options={options} />
          <Select aria-label="Long environment" defaultValue="long" options={longOption} />
        </div>
      </main>
    </PortalProvider>
  )
}

const meta = {
  component: Select,
  tags: ["autodocs"],
  title: "Primitives/Select"
} satisfies Meta<typeof Select>

export default meta
type Story = StoryObj<typeof meta>

export const States: Story = {
  args: { "aria-label": "Environment", onValueChange: fn(), options, value: undefined },
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole("combobox", { name: "Environment" })
    await userEvent.click(trigger)
    await expect(canvas.getByRole("option", { name: "Production unavailable" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    await userEvent.click(canvas.getByRole("option", { name: "Staging" }))
    await expect(trigger).toHaveTextContent("Staging")
    await expect(canvas.getByRole("combobox", { name: "Disabled environment" })).toBeDisabled()
    await expect(canvas.getByRole("combobox", { name: "Long environment" })).toBeVisible()
  },
  render: () => <ControlledSelect />
}
