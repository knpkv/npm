import { PortalProvider } from "@knpkv/rly/foundations"
import { describe, expect, it } from "@effect/vitest"
import { beforeAll, vi } from "vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { act, Component, type ReactElement, type ReactNode, useState } from "react"
import { createRoot, type Root } from "react-dom/client"

import {
  type ContinuePullRequestConversationRequest,
  PullRequestConversation,
  RelayProductDockProvider,
  type RelayProductDockHost,
  RelayProductLauncher,
  RelayProductPanel,
  RelayAuthenticationRequired,
  type RelayProductPin,
  useRelayProductOpen,
  type RelayPullRequestDockRegistration,
  RelaySelectorState,
  useRelayPullRequestDock
} from "../src/index.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

// happy-dom's viewport control, which drives the panel's width media queries.
declare global {
  interface Window {
    readonly happyDOM?: {
      readonly setViewport: (viewport: { readonly height: number; readonly width: number }) => void
    }
  }
}

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
const twoSelects = Schema.decodeUnknownSync(RelaySelectorState)({
  modelId: "configured-default",
  models: [{ id: "configured-default", label: "Configured default" }],
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

const conversationFor = (selection: RelaySelectorState, pullRequestId = "184") =>
  Schema.decodeUnknownSync(PullRequestConversation)({
    _tag: "codecommit",
    route: { accountId: "123456789012", href: `/accounts/123456789012/prs/${pullRequestId}`, pullRequestId },
    selection,
    thread: { accountId: "123456789012", pullRequestId, region: "eu-west-1", repositoryName: "payments" }
  })

type Ready = Extract<RelayPullRequestDockRegistration, { readonly status: "ready" }>

const ready = (
  selection: RelaySelectorState,
  continuePullRequestConversation: Ready["continuePullRequestConversation"],
  pullRequestId = "184"
): Ready => ({
  context: [
    { id: "repository", label: "Repository", value: "payments" },
    { id: "pull-request", label: "Pull request", value: "#184" },
    { id: "head", label: "Current head", value: "bbbbbbb" }
  ],
  continuePullRequestConversation,
  conversation: conversationFor(selection, pullRequestId),
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

let swap: (registration: RelayPullRequestDockRegistration) => void = () => undefined
/** A route whose registration a test replaces in place, as navigation under one provider does. */
const Swappable = ({ initial }: { readonly initial: RelayPullRequestDockRegistration }): null => {
  const [registration, setRegistration] = useState(initial)
  swap = setRegistration
  useRelayPullRequestDock(registration)
  return null
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
        <RelayProductPanel host={host} pin={{ _tag: "Available", minHostWidth: 960 }} />
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
        <RelayProductPanel host={host} pin={{ _tag: "Available", minHostWidth: 960 }} />
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
        <RelayProductPanel host={host} pin={{ _tag: "Available", minHostWidth: 960 }} />
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
        <RelayProductPanel host={host} pin={{ _tag: "Available", minHostWidth: 960 }} />
        <Registered registration={ready(twoSelects, () => Effect.void)} />
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
        <RelayProductPanel host={host} pin={{ _tag: "Available", minHostWidth: 960 }} />
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
          <RelayProductPanel host={host} pin={{ _tag: "Available", minHostWidth: 960 }} />
          <RelayProductPanel host={host} pin={{ _tag: "Available", minHostWidth: 960 }} />
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
        <RelayProductPanel host={host} pin={{ _tag: "Available", minHostWidth: 960 }} />
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
        <RelayProductPanel host={host} pin={{ _tag: "Available", minHostWidth: 960 }} />
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

  it("leaves find mode when the located pull request registers", async () => {
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={host} pin={{ _tag: "Available", minHostWidth: 960 }} />
        <Swappable initial={ready(coupled, () => Effect.void)} />
      </RelayProductDockProvider>
    )
    try {
      await open()
      await act(async () => button("Find another pull request")?.click())
      expect(document.querySelector("form[aria-label='Find a pull request conversation']")).not.toBeNull()
      // A message update on the same thread keeps find mode.
      await act(async () => swap({ ...ready(coupled, () => Effect.void), messages: [] }))
      expect(document.querySelector("form[aria-label='Find a pull request conversation']")).not.toBeNull()
      await act(async () => swap(ready(coupled, () => Effect.void, "185")))
      expect(document.querySelector("form[aria-label='Find a pull request conversation']")).toBeNull()
      expect(document.querySelector("textarea")).not.toBeNull()
    } finally {
      await unmount()
    }
  })

  it("starts a newly registered pull request with its own failure and selector state", async () => {
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={host} pin={{ _tag: "Available", minHostWidth: 960 }} />
        <Swappable initial={ready(coupled, () => Effect.die("transport"))} />
      </RelayProductDockProvider>
    )
    try {
      await open()
      await setText("Fails on A.")
      await act(async () => button("Send")?.click())
      expect(document.querySelector("[role='alert']")).not.toBeNull()
      await act(async () => swap(ready(twoSelects, () => Effect.void, "185")))
      expect(document.querySelector("[role='alert']")).toBeNull()
      expect(document.querySelector("[aria-label='Profile']")).not.toBeNull()
      expect(document.querySelector("[aria-label='Model']")).not.toBeNull()
    } finally {
      await unmount()
    }
  })

  it("names a single profile and its differently named model as one preset", async () => {
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={host} pin={{ _tag: "Unavailable" }} />
        <Registered registration={ready(uncoupled, () => Effect.void)} />
      </RelayProductDockProvider>
    )
    try {
      await open()
      expect(document.querySelector("[aria-label='Model']")).toBeNull()
      expect(document.querySelector("[aria-label='Run with']")?.textContent).toBe("Security review, Configured default")
    } finally {
      await unmount()
    }
  })

  it("keeps both selects when an extra or differing model would be hidden by one preset", async () => {
    const extra = Schema.decodeUnknownSync(RelaySelectorState)({
      modelId: "m2",
      models: [
        { id: "p1", label: "P1 model" },
        { id: "m2", label: "Other model" }
      ],
      profileId: "p1",
      profiles: [{ id: "p1", label: "P1" }]
    })
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={{ ...host, selection: extra }} pin={{ _tag: "Available", minHostWidth: 960 }} />
        <Registered registration={ready(extra, () => Effect.void)} />
      </RelayProductDockProvider>
    )
    try {
      await open()
      expect(document.querySelector("[aria-label='Run with']")).toBeNull()
      expect(document.querySelector("[aria-label='Model']")).not.toBeNull()
    } finally {
      await unmount()
    }
  })

  it("names a typed send failure's reason instead of a generic retry", async () => {
    const unauthenticated = () =>
      Effect.fail(
        new RelayAuthenticationRequired({ operation: "continue-pull-request-conversation", product: "codecommit" })
      )
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={host} pin={{ _tag: "Available", minHostWidth: 960 }} />
        <Registered registration={ready(coupled, unauthenticated)} />
      </RelayProductDockProvider>
    )
    try {
      await open()
      await setText("Needs auth.")
      await act(async () => button("Send")?.click())
      expect(document.querySelector("[role='alert']")?.textContent).toBe(
        "Authenticate with this product before using its Relay conversations. Your message is kept."
      )
    } finally {
      await unmount()
    }
  })

  it("offers the pin only on an available layout where the host stays usable beside the column", async () => {
    const available: RelayProductPin = { _tag: "Available", minHostWidth: 1100 }
    const pinnable = async (width: number, layout: RelayProductPin = available): Promise<boolean> => {
      await act(async () => window.happyDOM?.setViewport({ height: 900, width }))
      await mount(
        <RelayProductDockProvider>
          <RelayProductLauncher />
          <RelayProductPanel host={host} pin={layout} />
          <Registered registration={ready(coupled, () => Effect.void)} />
        </RelayProductDockProvider>
      )
      try {
        await open()
        return button("Pin beside the page") !== undefined
      } finally {
        await unmount()
      }
    }
    try {
      expect(await pinnable(1600)).toBe(true)
      expect(await pinnable(1500)).toBe(false)
      // A layout not yet measured never offers the pin, however wide.
      expect(await pinnable(1920, { _tag: "Unavailable" })).toBe(false)
    } finally {
      await act(async () => window.happyDOM?.setViewport({ height: 768, width: 1024 }))
    }
  })

  it("shows what the next message is about as a removable reference, and says when it changes under a draft", async () => {
    const cleared = vi.fn()
    const about = (id: string, label: string) => ({ about: { id, label, onClear: cleared } })
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={host} pin={{ _tag: "Unavailable" }} />
        <Swappable initial={{ ...ready(coupled, () => Effect.void), ...about("F1", "Finding: Trailing line") }} />
      </RelayProductDockProvider>
    )
    try {
      await open()
      expect(document.body.textContent).toContain("Finding: Trailing line")
      await setText("About the trailing line.")
      await act(async () => swap({ ...ready(coupled, () => Effect.void), ...about("F2", "Finding: Header parse") }))
      expect(document.body.textContent).toContain("Context changed to Finding: Header parse. Your draft is kept.")
      expect(document.querySelector("textarea")?.value).toBe("About the trailing line.")
      // Closing and reopening Relay still says it.
      await act(async () => button("Close Relay")?.click())
      await open()
      expect(document.body.textContent).toContain("Context changed to Finding: Header parse. Your draft is kept.")
      const remove = [...document.querySelectorAll("button")].find((element) =>
        (element.getAttribute("aria-label") ?? "").startsWith("Remove")
      )
      await act(async () => remove?.click())
      expect(cleared).toHaveBeenCalledTimes(1)
    } finally {
      await unmount()
    }
  })

  it("returns focus on close to the page control that opened Relay", async () => {
    const Discuss = (): ReactElement => {
      const { openFrom } = useRelayProductOpen()
      return (
        <button data-discuss="" onClick={(event) => openFrom(event.currentTarget)} type="button">
          Discuss in Relay
        </button>
      )
    }
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={host} pin={{ _tag: "Unavailable" }} />
        <Registered registration={ready(coupled, () => Effect.void)} />
        <Discuss />
        <button data-other="" type="button">
          Elsewhere
        </button>
      </RelayProductDockProvider>
    )
    try {
      const discuss = document.querySelector<HTMLButtonElement>("[data-discuss]")
      await act(async () => discuss?.click())
      expect(document.querySelector("[data-rly-relay-panel]")).not.toBeNull()
      await act(async () => button("Close Relay")?.click())
      expect(document.activeElement).toBe(discuss)
      await open()
      await act(async () => button("Close Relay")?.click())
      expect(document.activeElement).toBe(launcher())
      // A shortcut open from another control returns there, not to the earlier Discuss.
      const other = document.querySelector<HTMLButtonElement>("[data-other]")
      other?.focus()
      await act(async () =>
        other?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "KeyJ", ctrlKey: true, key: "j" }))
      )
      expect(document.querySelector("[data-rly-relay-panel]")).not.toBeNull()
      await act(async () => button("Close Relay")?.click())
      expect(document.activeElement).toBe(other)
    } finally {
      await unmount()
    }
  })

  it("says a changed preset applies to the next message, and keeps it across an equal re-registration", async () => {
    const choose = async (label: string): Promise<void> => {
      const trigger = document.querySelector<HTMLElement>("[aria-label='Run with']")
      await act(async () =>
        trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))
      )
      const option = [...document.querySelectorAll<HTMLElement>("[role='option']")].find(
        (item) => item.textContent?.startsWith(label) === true
      )
      expect(option).toBeDefined()
      await act(async () => option?.click())
    }
    await mount(
      <RelayProductDockProvider>
        <RelayProductLauncher />
        <RelayProductPanel host={host} pin={{ _tag: "Unavailable" }} />
        <Swappable initial={ready(coupled, () => Effect.void)} />
      </RelayProductDockProvider>
    )
    try {
      await open()
      expect(document.body.textContent).not.toContain("Applies to your next message.")
      await choose("Thorough review")
      expect(document.body.textContent).toContain("Applies to your next message.")
      // The host re-allocates an equal selector (a progress update): the pending choice stays.
      const equal = Schema.decodeUnknownSync(RelaySelectorState)(JSON.parse(JSON.stringify(coupled)))
      await act(async () => swap(ready(equal, () => Effect.void)))
      expect(document.body.textContent).toContain("Applies to your next message.")
      // A selector that means something different resets it.
      const changed = Schema.decodeUnknownSync(RelaySelectorState)({
        ...JSON.parse(JSON.stringify(coupled)),
        profiles: [
          { id: "security", label: "Security review, revised" },
          { id: "thorough", label: "Thorough review" }
        ]
      })
      await act(async () => swap(ready(changed, () => Effect.void)))
      expect(document.body.textContent).not.toContain("Applies to your next message.")
    } finally {
      await unmount()
    }
  })
})
