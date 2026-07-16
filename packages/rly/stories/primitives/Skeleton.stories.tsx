import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { Skeleton } from "../../src/primitives/Skeleton.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle, swatchStyle } from "./storyStyles.js"

const SkeletonGallery = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Reserved content geometry
    </Text>
    <div style={{ ...stackStyle, ...swatchStyle }}>
      <Skeleton data-skeleton-variant="text" width="72%" />
      <Skeleton width="48%" />
      <Skeleton data-skeleton-variant="block" height="8rem" variant="block" />
      <Skeleton data-skeleton-variant="circle" decorative={false} label="Loading reviewer" variant="circle" />
    </div>
  </main>
)

const meta = { component: Skeleton, tags: ["autodocs"], title: "Primitives/Skeleton" } satisfies Meta<typeof Skeleton>
export default meta
type Story = StoryObj<typeof meta>
export const Gallery: Story = {
  args: { decorative: true },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("status", { name: "Loading reviewer" })).toBeVisible()
    await expect(canvasElement.querySelectorAll("[data-skeleton-variant]")).toHaveLength(3)
  },
  render: () => <SkeletonGallery />
}
