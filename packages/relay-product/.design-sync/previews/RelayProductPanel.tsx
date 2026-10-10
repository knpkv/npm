// Fixtures from packages/relay-product/test/relay-product-panel.test.tsx, packages/relay-product/test/relay-product-dock.test.tsx.
import {
  PullRequestConversation,
  RelayProductDockProvider,
  RelayProductLauncher,
  RelayProductPanel,
  RelaySelectorState,
  useRelayProductOpen,
  useRelayPullRequestDock
} from "@knpkv/relay-app-design-system"
import type { RelayProductDockHost, RelayPullRequestDockRegistration } from "@knpkv/relay-product"
import * as Effect from "effect/Effect"
import { useEffect } from "react"

// The fixtures are already in decoded form. Decoding them here would run this preview's own copy
// of effect against the bundle's schemas, which Schema rejects.
const fixture = <A,>(value: unknown): A => value as A
const noop = () => undefined
const coupled = fixture<typeof RelaySelectorState.Type>({
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
const host: RelayProductDockHost = {
  context: [{ id: "product", label: "Product", value: "CodeCommit" }],
  locatePullRequestConversation: () => Effect.void,
  product: "codecommit",
  selection: coupled
}
const conversation = fixture<typeof PullRequestConversation.Type>({
  _tag: "codecommit",
  route: { accountId: "123456789012", href: "/accounts/123456789012/prs/184", pullRequestId: "184" },
  selection: coupled,
  thread: { accountId: "123456789012", pullRequestId: "184", region: "eu-west-1", repositoryName: "payments" }
})
const ready: Extract<RelayPullRequestDockRegistration, { readonly status: "ready" }> = {
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
  selection: coupled,
  status: "ready"
}
const loading: RelayPullRequestDockRegistration = {
  context: [{ id: "pull-request", label: "Pull request", value: "#184" }],
  conversation,
  selection: coupled,
  status: "loading"
}
const empty: RelayPullRequestDockRegistration = { ...ready, messages: [] }
const about: RelayPullRequestDockRegistration = {
  ...ready,
  about: { id: "F1", label: "Finding: Trailing line", onClear: noop },
  notice: "Also on this page: the review composer."
}
const Registered = ({ registration }: { readonly registration: RelayPullRequestDockRegistration }) => {
  useRelayPullRequestDock(registration)
  return null
}

/** Start in the test's open state through the bundle's shared product provider. */
const OpenPanel = ({ alternate = false }: { readonly alternate?: boolean }) => {
  const { setOpen } = useRelayProductOpen()
  useEffect(() => setOpen(true), [setOpen])
  return (
    <RelayProductPanel
      host={
        alternate
          ? {
              ...host,
              alternate: { label: "Open the Release 2.18 conversation, full page", onOpen: noop }
            }
          : host
      }
      pin={{ _tag: "Unavailable" }}
    />
  )
}
const Panel = ({ registration }: { readonly registration?: RelayPullRequestDockRegistration }) => (
  <div style={{ minBlockSize: "44rem" }}>
    <RelayProductDockProvider>
      <RelayProductLauncher />
      {registration === undefined ? null : <Registered registration={registration} />}
      <OpenPanel alternate={registration === undefined} />
    </RelayProductDockProvider>
  </div>
)

export const Default = () => <Panel registration={ready} />
export const Loading = () => <Panel registration={loading} />
export const EmptyThread = () => <Panel registration={empty} />
export const FindingContext = () => <Panel registration={about} />
export const FindConversation = () => <Panel />
