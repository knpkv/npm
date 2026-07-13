import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { Divider } from "../../src/primitives/Divider.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, rowStyle, stackStyle, swatchStyle } from "./storyStyles.js"

const DividerGallery = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Content boundaries
    </Text>
    <div style={stackStyle}>
      <Text>First region</Text>
      <Divider data-divider-orientation="horizontal" data-divider-strength="subtle" />
      <Text>Second region</Text>
      <Divider data-divider-strength="strong" strength="strong" />
      <Text>Third region</Text>
    </div>
    <div style={{ ...rowStyle, ...swatchStyle, minHeight: "8rem" }}>
      <Text>Before</Text>
      <Divider
        data-divider-orientation="vertical"
        decorative={false}
        label="Comparison boundary"
        orientation="vertical"
      />
      <Text>After</Text>
    </div>
  </main>
)

const meta = { component: Divider, tags: ["autodocs"], title: "Primitives/Divider" } satisfies Meta<typeof Divider>
export default meta
type Story = StoryObj<typeof meta>
export const Gallery: Story = {
  args: { decorative: true },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("separator", { name: "Comparison boundary" })).toBeVisible()
    await expect(canvasElement.querySelectorAll("[data-divider-orientation]")).toHaveLength(2)
    await expect(canvasElement.querySelectorAll("[data-divider-strength]")).toHaveLength(2)
  },
  render: () => <DividerGallery />
}
