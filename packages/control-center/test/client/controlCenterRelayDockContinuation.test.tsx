// @vitest-environment happy-dom

import { PortalProvider } from "@knpkv/rly/foundations"
import {
  ContinuePullRequestConversationRequest,
  PullRequestConversation,
  RelayProductDock,
  RelaySelectorState,
  type RelayProductDockHost,
  type RelayPullRequestDockRegistration,
  useRelayPullRequestDock
} from "@knpkv/relay-product"
import { describe, expect, it } from "@effect/vitest"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"

import { DurableAgentProviderId } from "../../src/api/agent.js"
import { continueControlCenterRelayConversation } from "../../src/client/controlCenterRelayThread.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

const selection = Schema.decodeUnknownSync(RelaySelectorState)({
  modelId: "configured-model",
  models: [{ id: "configured-model", label: "Configured model" }],
  profileId: "configured-profile",
  profiles: [{ id: "configured-profile", label: "Configured profile" }]
})

const conversation = Schema.decodeUnknownSync(PullRequestConversation)({
  _tag: "control-center",
  route: {
    entityId: "019c3df0-2222-7000-8000-000000000002",
    href: "/w/019c3df0-2222-7000-8000-000000000001/items/019c3df0-2222-7000-8000-000000000002"
  },
  selection,
  thread: {
    pluginConnectionId: "019c3df0-3333-7000-8000-000000000003",
    pullRequestId: "42",
    repositoryName: "payments",
    workspaceId: "019c3df0-2222-7000-8000-000000000001"
  }
})

const request = Schema.decodeUnknownSync(ContinuePullRequestConversationRequest)({
  conversation,
  message: "Continue this pull-request thread.",
  selection
})

const host: RelayProductDockHost = {
  context: [{ id: "product", label: "Product", value: "Control Center" }],
  locatePullRequestConversation: () => Effect.void,
  product: "control-center",
  selection
}

class MissingDockTestElement extends Data.TaggedError("MissingDockTestElement")<{
  readonly selector: string
}> {}

class EnqueueFailure extends Data.TaggedError("EnqueueFailure") {}

interface RenderedDock {
  readonly container: HTMLDivElement
  readonly portal: HTMLDivElement
  readonly root: Root
}

const queryRequired = <ElementType extends Element>(parent: ParentNode, selector: string): ElementType => {
  const element = parent.querySelector<ElementType>(selector)
  if (element === null) throw new MissingDockTestElement({ selector })
  return element
}

const renderDock = async (registration: RelayPullRequestDockRegistration): Promise<RenderedDock> => {
  await import("@knpkv/rly/patterns")
  const container = document.createElement("div")
  const portal = document.createElement("div")
  document.body.append(container, portal)
  const root = createRoot(container)
  const registered = createElement(RegisteredThread, { registration })
  await act(async () =>
    root.render(
      createElement(PortalProvider, {
        children: createElement(RelayProductDock, { children: registered, host }),
        container: portal
      })
    )
  )
  return { container, portal, root }
}

const disposeDock = async ({ container, portal, root }: RenderedDock): Promise<void> => {
  await act(async () => root.unmount())
  container.remove()
  portal.remove()
}

const click = async (element: Element): Promise<void> => {
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })))
}

const setTextareaValue = async (input: HTMLTextAreaElement, value: string): Promise<void> => {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
    if (valueSetter === undefined) throw new MissingDockTestElement({ selector: "HTMLTextAreaElement.value setter" })
    valueSetter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const RegisteredThread = ({ registration }: { readonly registration: RelayPullRequestDockRegistration }): null => {
  useRelayPullRequestDock(registration)
  return null
}

const registrationFor = (startReview: () => Promise<void>): RelayPullRequestDockRegistration => ({
  context: [{ id: "pull-request", label: "Pull request", value: "#42" }],
  conversation,
  continuePullRequestConversation: (submitted) =>
    continueControlCenterRelayConversation({
      conversation,
      providerId: DurableAgentProviderId.make("openai-compatible"),
      request: submitted,
      startReview
    }),
  messages: [],
  selection,
  status: "ready"
})

describe("Control Center Relay continuation dock", () => {
  it("retains submitted text and displays the typed failure when enqueue rejects", async () => {
    const rendered = await renderDock(registrationFor(() => Promise.reject(new EnqueueFailure())))
    try {
      await click(queryRequired(rendered.container, "[data-rly-relay-dock-trigger]"))
      const input = queryRequired<HTMLTextAreaElement>(rendered.portal, "textarea")
      await setTextareaValue(input, request.message)
      await click(queryRequired(rendered.portal, 'button[type="submit"]'))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(input.value).toBe(request.message)
      expect(queryRequired(rendered.portal, '[role="alert"]').textContent).toContain(
        "could not continue this pull-request conversation"
      )
    } finally {
      await disposeDock(rendered)
    }
  })

  it("clears submitted text after enqueue is acknowledged", async () => {
    const rendered = await renderDock(registrationFor(() => Promise.resolve()))
    try {
      await click(queryRequired(rendered.container, "[data-rly-relay-dock-trigger]"))
      const input = queryRequired<HTMLTextAreaElement>(rendered.portal, "textarea")
      await setTextareaValue(input, request.message)
      await click(queryRequired(rendered.portal, 'button[type="submit"]'))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(input.value).toBe("")
      expect(rendered.portal.querySelector('[role="alert"]')).toBeNull()
    } finally {
      await disposeDock(rendered)
    }
  })
})
