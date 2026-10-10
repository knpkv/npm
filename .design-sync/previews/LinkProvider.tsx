// Mirrors stories/foundations/LinkProvider.stories.tsx. The story renders the internal RlyLink,
// which is not a public export; a native anchor through the same bridge component renders the same.
import * as React from "react"
import { LinkProvider, type RlyLinkComponent, type RlyLinkProps } from "@knpkv/rly"

const FakeRouterLink: RlyLinkComponent = (props: RlyLinkProps) => <a {...props} data-router-destination={props.href} />

export const FrameworkBridge = () => (
  <div data-registry-state="framework-bridge">
    <LinkProvider component={FakeRouterLink}>
      <FakeRouterLink href="/w/engineering/releases/payments" rel="bookmark" target="release-detail">
        Open payments release
      </FakeRouterLink>
    </LinkProvider>
  </div>
)
