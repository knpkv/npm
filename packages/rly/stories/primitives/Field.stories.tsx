import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { Field } from "../../src/primitives/Field.js"
import { Select, type RlySelectOption } from "../../src/primitives/Select.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "./storyStyles.js"

const environments = [
  { label: "Development", value: "development" },
  { label: "Staging", value: "staging" },
  { label: "Production", value: "production" }
] satisfies ReadonlyArray<RlySelectOption>

const FieldStates = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Field composition
    </Text>
    <div style={stackStyle}>
      <Field controlId="release-name" description="Shown across release views." label="Release name" required>
        {(controlProps) => <input {...controlProps} defaultValue="Payments 2.4.0" />}
      </Field>
      <Field controlId="release-notes" error="Add a concise summary before continuing." label="Release notes">
        {(controlProps) => <textarea {...controlProps} defaultValue="" />}
      </Field>
      <Field controlId="environment" description="Choose the deployment target." label="Environment" size="compact">
        {(controlProps) => <Select {...controlProps} options={environments} size="compact" />}
      </Field>
    </div>
  </main>
)

const meta = {
  component: Field,
  tags: ["autodocs"],
  title: "Primitives/Field"
} satisfies Meta<typeof Field>

export default meta
type Story = StoryObj<typeof meta>

export const States: Story = {
  args: { children: (controlProps) => <input {...controlProps} />, label: "Release name" },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("textbox", { name: /Release name/ })).toHaveAttribute("aria-required", "true")
    await expect(canvas.getByRole("alert")).toHaveTextContent("Add a concise summary")
    await expect(canvas.getByRole("combobox", { name: "Environment" })).toBeVisible()
  },
  render: () => <FieldStates />
}
