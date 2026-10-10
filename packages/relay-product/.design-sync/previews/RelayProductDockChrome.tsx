// Fixtures from packages/relay-product/test/relay-product-dock.test.tsx.
import {
  PullRequestConversation,
  RelayProductDockChrome,
  RelayProductDockProvider,
  RelaySelectorState,
  useRelayPullRequestDock
} from "@knpkv/relay-app-design-system"
import type { RelayProductDockHost, RelayPullRequestDockRegistration } from "@knpkv/relay-product"
import * as Effect from "effect/Effect"

// The fixtures are already in decoded form. Decoding them here would run this preview's own copy
// of effect against the bundle's schemas, which Schema rejects.
const fixture = <A,>(value: unknown): A => value as A

const selection = fixture<typeof RelaySelectorState.Type>({
  modelId: "configured-default",
  models: [{ id: "configured-default", label: "Configured default" }],
  profileId: "security",
  profiles: [{ id: "security", label: "Security review" }]
})
const host: RelayProductDockHost = {
  context: [{ id: "product", label: "Product", value: "CodeCommit" }],
  locatePullRequestConversation: () => Effect.void,
  product: "codecommit",
  selection
}
const conversation = fixture<typeof PullRequestConversation.Type>({
  _tag: "codecommit",
  route: { accountId: "123456789012", href: "/accounts/123456789012/prs/184", pullRequestId: "184" },
  selection,
  thread: { accountId: "123456789012", pullRequestId: "184", region: "eu-west-1", repositoryName: "payments" }
})
const registration: RelayPullRequestDockRegistration = {
  context: [],
  conversation,
  selection,
  status: "loading",
  working: true
}
const Registered = () => {
  useRelayPullRequestDock(registration)
  return null
}

export const Default = () => (
  <div style={{ contain: "layout", minBlockSize: "12rem" }}>
    <RelayProductDockProvider>
      <RelayProductDockChrome host={host} />
    </RelayProductDockProvider>
  </div>
)
