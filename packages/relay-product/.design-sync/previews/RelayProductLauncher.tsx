// Fixtures from packages/relay-product/test/relay-product-panel.test.tsx.
import {
  PullRequestConversation,
  RelayProductDockProvider,
  RelayProductLauncher,
  RelaySelectorState,
  useRelayPullRequestDock
} from "@knpkv/relay-app-design-system"
import type { RelayPullRequestDockRegistration } from "@knpkv/relay-product"
import * as Effect from "effect/Effect"

// The fixtures are already in decoded form. Decoding them here would run this preview's own copy
// of effect against the bundle's schemas, which Schema rejects.
const fixture = <A,>(value: unknown): A => value as A

const selection = fixture<typeof RelaySelectorState.Type>({
  modelId: "security",
  models: [
    { id: "security", label: "Security, Codex" },
    { id: "thorough", label: "Thorough, Claude" }
  ],
  profileId: "security",
  profiles: [
    { id: "security", label: "Security review" },
    { id: "thorough", label: "Thorough review" }
  ]
})
const conversation = fixture<typeof PullRequestConversation.Type>({
  _tag: "codecommit",
  route: { accountId: "123456789012", href: "/accounts/123456789012/prs/184", pullRequestId: "184" },
  selection,
  thread: { accountId: "123456789012", pullRequestId: "184", region: "eu-west-1", repositoryName: "payments" }
})
const registration: RelayPullRequestDockRegistration = {
  context: [
    { id: "repository", label: "Repository", value: "payments" },
    { id: "pull-request", label: "Pull request", value: "#184" },
    { id: "head", label: "Current head", value: "bbbbbbb" }
  ],
  continuePullRequestConversation: () => Effect.void,
  conversation,
  messages: [
    { id: "m1", role: "operator", text: "Why is the trailing context line skipped?" },
    { id: "m2", role: "relay", text: "The hunk loop stops one line early." },
    { id: "m3", role: "system", text: "Rerun required before continuing." }
  ],
  selection,
  status: "ready",
  working: true
}
const Registered = () => {
  useRelayPullRequestDock(registration)
  return null
}

export const Default = () => (
  <RelayProductDockProvider>
    <RelayProductLauncher />
  </RelayProductDockProvider>
)
