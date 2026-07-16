import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { ThemeProvider } from "../../src/foundations/ThemeProvider.js"

const meta = {
  argTypes: {
    theme: { control: "inline-radio", options: ["system", "light", "dark"] }
  },
  component: ThemeProvider,
  tags: ["autodocs"],
  title: "Foundations/ThemeProvider"
} satisfies Meta<typeof ThemeProvider>

export default meta
type Story = StoryObj<typeof meta>

export const Controlled: Story = {
  args: {
    children: <p>Theme is application state, never hidden provider state.</p>,
    theme: "system"
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Theme is application state, never hidden provider state.")).toBeVisible()
    await expect(canvas.getByText("Light theme")).toBeVisible()
    await expect(canvas.getByText("Dark theme")).toBeVisible()
  },
  render: () => (
    <div>
      <ThemeProvider theme="system">
        <p>Theme is application state, never hidden provider state.</p>
      </ThemeProvider>
      <ThemeProvider theme="light">
        <p>Light theme</p>
      </ThemeProvider>
      <ThemeProvider theme="dark">
        <p>Dark theme</p>
      </ThemeProvider>
    </div>
  )
}
