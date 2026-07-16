import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { Avatar } from "../../src/primitives/Avatar.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, rowStyle } from "./storyStyles.js"

const AvatarGallery = () => (
  <main style={pageStyle}>
    <Text as="h1" variant="section-title">
      Identity fallbacks
    </Text>
    <div style={rowStyle}>
      <Avatar data-avatar-shape="circle" data-avatar-size="small" fallback="AD" label="Avery Diaz" size="small" />
      <Avatar data-avatar-size="default" fallback="BK" label="Blake Kim" />
      <Avatar data-avatar-size="large" fallback="CS" label="Casey Singh" size="large" />
      <Avatar
        data-avatar-shape="rounded-square"
        data-avatar-size="hero"
        fallback="DT"
        label="Delivery team"
        shape="rounded-square"
        size="hero"
      />
    </div>
    <div style={rowStyle}>
      <Avatar decorative fallback="+3" />
      <Text tone="secondary">Three additional reviewers</Text>
    </div>
  </main>
)

const meta = { component: Avatar, tags: ["autodocs"], title: "Primitives/Avatar" } satisfies Meta<typeof Avatar>
export default meta
type Story = StoryObj<typeof meta>
export const Gallery: Story = {
  args: { fallback: "AD", label: "Avery Diaz" },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("img", { name: "Avery Diaz" })).toBeVisible()
    await expect(canvas.getByRole("img", { name: "Delivery team" })).toBeVisible()
    await expect(canvasElement.querySelectorAll("[data-avatar-size]")).toHaveLength(4)
    await expect(canvasElement.querySelectorAll("[data-avatar-shape]")).toHaveLength(2)
  },
  render: () => <AvatarGallery />
}
