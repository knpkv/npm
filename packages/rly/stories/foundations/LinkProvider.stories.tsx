import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { LinkProvider, RlyLink, type RlyLinkComponent, type RlyLinkProps } from "../../src/foundations/LinkProvider.js"

const FakeRouterLink: RlyLinkComponent = (props: RlyLinkProps) => <a {...props} data-router-destination={props.href} />

const LinkBridgeExample = () => (
  <LinkProvider component={FakeRouterLink}>
    <RlyLink href="/w/engineering/releases/payments" rel="bookmark" target="release-detail">
      Open payments release
    </RlyLink>
  </LinkProvider>
)

const meta = {
  component: LinkBridgeExample,
  tags: ["autodocs"],
  title: "Foundations/LinkProvider"
} satisfies Meta<typeof LinkBridgeExample>

export default meta
type Story = StoryObj<typeof meta>

export const FrameworkBridge: Story = {
  play: async ({ canvas }) => {
    const link = canvas.getByRole("link", { name: "Open payments release" })

    await expect(link).toHaveAttribute("data-router-destination", "/w/engineering/releases/payments")
    await expect(link).toHaveAttribute("href", "/w/engineering/releases/payments")
    await expect(link).toHaveAttribute("rel", "bookmark")
    await expect(link).toHaveAttribute("target", "release-detail")
  }
}
