import { PortalProvider } from "@knpkv/rly/foundations"
import { describe, expect, it } from "@effect/vitest"
import { beforeAll, vi } from "vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { act, Component, type ReactElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"

import {
  type ContinuePullRequestConversationRequest,
  PullRequestConversation,
  RelayProductDockProvider,
  type RelayProductDockHost,
  RelayProductLauncher,
  RelayProductPanel,
  type RelayPullRequestDockRegistration,
  RelaySelectorState,
  useRelayPullRequestDock
} from "../src/index.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

const coupled = Schema.decodeUnknownSync(RelaySelectorState)({
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
const uncoupled = Schema.decodeUnknownSync(RelaySelectorState)({
  modelId: "configured-default",
  models: [{ id: "configured-default", label: "Configured default" }],
  profileId: "security",
  profiles: [{ id: "security", label: "Security review" }]
})

const host: RelayProductDockHost = {
  context: [{ id: "product", label: "Product", value: "CodeCommit" }],
  locatePullRequestConversation: () => Effect.void,
  product: "codecommit",
  selection: coupled
}

const conversationFor = (selection: RelaySelectorState) =>
  Schema.decodeUnknownSync(PullRequestConversation)({
    _tag: "codecommit",
    route: { accountId: "123456789012", href: "/accounts/123456789012/prs/184", pullRequestId: "184" },
    selection,
    thread: { accountId: "123456789012", pullRequestId: "184", region: "eu-west-1", repositoryName: "payments" }
  })

const ready = (
  selection: RelaySelectorState,
  continuePullRequestConversation: (request: typeof ContinuePullRequestConversationRequest.Type) => Effect.Effect<void>
): RelayPullRequestDockRegistration => ({
  context: [
    { id: "repository", label: "Repository", value: "payments" },
    { id: "pull-request", label: "Pull request", value: "#184" },
    { id: "head", label: "Current head", value: "bbbbbbb" }
  ],
  continuePullRequestConversation,
  conversation: conversationFor(selection),
  messages: [
    { id: "m1", role: "operator", text: "Why is the trailing context line skipped?" },
    { id: "m2", role: "relay", text: "The hunk loop stops one line early." },
    { id: "m3", role: "system", text: "Rerun required before continuing." }
  ],
  selection,
  status: "ready"
})

const Registered = ({ registration }: { readonly registration: RelayPullRequestDockRegistration }): null => {
  useRelayPullRequestDock(registration)
  return null
}

class Catch extends Component<{ readonly children: ReactNode }, { readonly error: string | null }> {
  override state = { error: null }
  static getDerivedStateFromError(error: { readonly _tag?: string }) {
    return { error: error._tag ?? "error" }
  }
  override render(): ReactNode {
    return this.state.error === null ? this.props.children : <output data-caught={this.state.error} />
  }
}

let root: Root | undefined
const mount = async (element: ReactElement): Promise<void> => {
  const container = document.createElement("div")
  const portal = document.createElement("div")
  document.body.append(container, portal)
  root = createRoot(container)
  await act(async () => root?.render(<PortalProvider container={portal}>{element}</PortalProvider>))
}
const unmount = async (): Promise<void> => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
}
const launcher = (): HTMLButtonElement | null => document.querySelector("[data-rly-relay-launcher]")
const open = async (): Promise<void> => {
  await act(async () => launcher()?.click())
}
const setText = async (value: string): Promise<void> => {
  const input = document.querySelector("textarea")
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, value)
    input?.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (element) => element.textContent === name || element.getAttribute("aria-label") === name
  )

describe("RelayProductPanel", () => {
  beforeAll(async () => {
    await import("@knpkv/rly/patterns")
  }, 60_000)

  it("names its pull-request-only scope with the locator when no pull request is registered", async () => {
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={host} minHostWidth={960} />
      </RelayProductDockProvider>
    )
    try {
      expect(document.querySelector("[data-rly-relay-panel]")).toBeNull()
      await open()
      expect(document.body.textContent).toContain("Relay works on pull requests here. Open one, or find it:")
      expect(document.querySelector("form[aria-label='Find a pull request conversation']")).not.toBeNull()
      expect(document.querySelector("textarea")).toBeNull()
    } finally {
      await unmount()
    }
  })

  it("opens a registered pull request straight into its conversation and sends on the PR contract", async () => {
    const continued = vi.fn<(request: typeof ContinuePullRequestConversationRequest.Type) => Effect.Effect<void>>(
      () => Effect.void
    )
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={host} minHostWidth={960} />
        <Registered registration={ready(coupled, continued)} />
      </RelayProductDockProvider>
    )
    try {
      await open()
      const turns = [...document.querySelectorAll("[data-rly-relay-panel] li")].map((item) => item.textContent)
      expect(turns).toEqual([
        "You: Why is the trailing context line skipped?",
        "Relay: The hunk loop stops one line early.",
        "Note: Rerun required before continuing."
      ])
      expect(document.body.textContent).toContain("payments #184 at bbbbbbb")
      await setText("Check the stacked view too.")
      await act(async () => button("Send")?.click())
      expect(continued).toHaveBeenCalledTimes(1)
      expect(continued.mock.calls[0]?.[0].message).toBe("Check the stacked view too.")
      expect(document.querySelector("textarea")?.value).toBe("")
    } finally {
      await unmount()
    }
  })

  it("offers one Run with preset when profiles and models are coupled, and two selects otherwise", async () => {
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={host} minHostWidth={960} />
        <Registered registration={ready(coupled, () => Effect.void)} />
      </RelayProductDockProvider>
    )
    try {
      await open()
      expect(document.querySelector("[aria-label='Run with']")).not.toBeNull()
      expect(document.querySelector("[aria-label='Model']")).toBeNull()
    } finally {
      await unmount()
    }
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={host} minHostWidth={960} />
        <Registered registration={ready(uncoupled, () => Effect.void)} />
      </RelayProductDockProvider>
    )
    try {
      await open()
      expect(document.querySelector("[aria-label='Profile']")).not.toBeNull()
      expect(document.querySelector("[aria-label='Model']")).not.toBeNull()
    } finally {
      await unmount()
    }
  })

  it("keeps the draft when sending fails, so nothing typed is lost", async () => {
    const failing = vi.fn(() => Effect.die("transport"))
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={host} minHostWidth={960} />
        <Registered registration={ready(coupled, failing)} />
      </RelayProductDockProvider>
    )
    try {
      await open()
      await setText("Keep me.")
      await act(async () => button("Send")?.click())
      expect(document.querySelector("textarea")?.value).toBe("Keep me.")
      expect(document.querySelector("[role='alert']")?.textContent).toContain("Your message is kept")
    } finally {
      await unmount()
    }
  })

  it("refuses a second panel under one provider, so Ctrl/⌘+J is bound once", async () => {
    await mount(
      <RelayProductDockProvider>
        <Catch>
          <RelayProductPanel host={host} minHostWidth={960} />
          <RelayProductPanel host={host} minHostWidth={960} />
        </Catch>
      </RelayProductDockProvider>
    )
    try {
      expect(document.querySelector("[data-caught]")?.getAttribute("data-caught")).toBe("RelayProductSummonClaimed")
    } finally {
      await unmount()
    }
  })

  it("keeps one draft per thread whatever order the identity's fields arrive in", async () => {
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={host} minHostWidth={960} />
        <Registered registration={ready(coupled, () => Effect.void)} />
      </RelayProductDockProvider>
    )
    try {
      await open()
      await setText("Same thread draft.")
    } finally {
      await unmount()
    }
    const reordered = ready(coupled, () => Effect.void)
    const thread = Schema.decodeUnknownSync(PullRequestConversation)({
      _tag: "codecommit",
      route: { accountId: "123456789012", href: "/accounts/123456789012/prs/184", pullRequestId: "184" },
      selection: coupled,
      thread: { repositoryName: "payments", region: "eu-west-1", pullRequestId: "184", accountId: "123456789012" }
    })
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={host} minHostWidth={960} />
        <Registered registration={{ ...reordered, conversation: thread }} />
      </RelayProductDockProvider>
    )
    try {
      await open()
      expect(document.querySelector("textarea")?.value).toBe("Same thread draft.")
    } finally {
      await unmount()
    }
  })
})
