import { PortalProvider } from "@knpkv/rly/foundations"
import { describe, expect, it } from "@effect/vitest"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"

import {
  type ContinuePullRequestConversationRequest,
  PullRequestConversation,
  RelayProductDock,
  RelayProductDockChromeBoundary,
  type RelayProductDockHost,
  type RelayPullRequestDockRegistration,
  RelaySelectorState,
  relaySelectionMatchesRegistration,
  useRelayPullRequestDock
} from "../src/index.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

const selection = {
  modelId: "configured-default",
  models: [{ id: "configured-default", label: "Configured default" }],
  profileId: "security",
  profiles: [{ id: "security", label: "Security review" }]
}

const host: RelayProductDockHost = {
  context: [{ id: "product", label: "Product", value: "CodeCommit" }],
  locatePullRequestConversation: () => Effect.void,
  product: "codecommit",
  selection
}

interface RenderedDock {
  readonly container: HTMLDivElement
  readonly portal: HTMLDivElement
  readonly root: Root
}

const renderDock = async (element: ReactElement): Promise<RenderedDock> => {
  await import("@knpkv/rly/patterns")
  const container = document.createElement("div")
  const portal = document.createElement("div")
  document.body.append(container, portal)
  const root = createRoot(container)
  await act(async () => root.render(<PortalProvider container={portal}>{element}</PortalProvider>))
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

class MissingDockTestElement extends Data.TaggedError("MissingDockTestElement")<{
  readonly selector: string
}> {}

class DockChromeFailure extends Data.TaggedError("DockChromeFailure") {}

const ThrowingDockChrome = (): ReactElement => {
  throw new DockChromeFailure()
}

const queryRequired = <ElementType extends Element>(parent: ParentNode, selector: string): ElementType => {
  const element = parent.querySelector<ElementType>(selector)
  if (element === null) throw new MissingDockTestElement({ selector })
  return element
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

describe("RelayProductDock", () => {
  it("contains a rejected lazy dock without unmounting routed content", async () => {
    const rendered = await renderDock(
      <>
        <output data-routed-page="true">page</output>
        <RelayProductDockChromeBoundary>
          <ThrowingDockChrome />
        </RelayProductDockChromeBoundary>
      </>
    )
    try {
      expect(rendered.container.querySelector("[data-routed-page]")?.textContent).toBe("page")
    } finally {
      await disposeDock(rendered)
    }
  })

  it("renders on the host page collapsed, then exposes the profile and model selectors", async () => {
    const rendered = await renderDock(
      <RelayProductDock host={host}>
        <div style={{ minHeight: "100dvh" }}>Host page</div>
      </RelayProductDock>
    )
    try {
      expect(rendered.container.textContent).toContain("Host page")
      expect(rendered.portal.querySelector('[role="dialog"]')).toBeNull()
      expect(queryRequired<HTMLElement>(rendered.container, "[data-relay-product-dock-chrome]").style.position).toBe(
        "fixed"
      )

      await click(queryRequired(rendered.container, "[data-rly-relay-dock-trigger]"))

      expect(rendered.portal.textContent).toContain("Profile")
      expect(rendered.portal.textContent).toContain("Model")
      expect(rendered.portal.textContent).toContain("Find a pull request conversation")
    } finally {
      await disposeDock(rendered)
    }
  })

  it("adopts a loaded selector catalog without resetting later dock-owned choices", async () => {
    const conversation = await Effect.runPromise(
      Schema.decodeUnknownEffect(PullRequestConversation)({
        _tag: "codecommit",
        route: {
          accountId: "123456789012",
          href: "/accounts/123456789012/prs/184",
          pullRequestId: "184"
        },
        selection,
        thread: {
          accountId: "123456789012",
          pullRequestId: "184",
          region: "eu-west-1",
          repositoryName: "payments"
        }
      })
    )
    const loading: RelayPullRequestDockRegistration = {
      context: [{ id: "pull-request", label: "Pull request", value: "#184" }],
      conversation,
      selection,
      status: "loading"
    }
    const loadedSelection = Schema.decodeUnknownSync(RelaySelectorState)({
      modelId: "sonnet",
      models: [
        { id: "sonnet", label: "Sonnet" },
        { id: "opus", label: "Opus" }
      ],
      profileId: "security",
      profiles: [
        { id: "security", label: "Security" },
        { id: "architecture", label: "Architecture" }
      ]
    })
    const ready: RelayPullRequestDockRegistration = {
      context: [{ id: "pull-request", label: "Pull request", value: "#184" }],
      conversation,
      continuePullRequestConversation: () => Effect.void,
      messages: [],
      selection: loadedSelection,
      status: "ready"
    }
    const rendered = await renderDock(
      <RelayProductDock host={host}>
        <RegisteredThread registration={loading} />
      </RelayProductDock>
    )
    try {
      await act(async () =>
        rendered.root.render(
          <PortalProvider container={rendered.portal}>
            <RelayProductDock host={host}>
              <RegisteredThread registration={ready} />
            </RelayProductDock>
          </PortalProvider>
        )
      )
      await click(queryRequired(rendered.container, "[data-rly-relay-dock-trigger]"))

      const selectedOptions = Array.from(
        rendered.portal.querySelectorAll<HTMLButtonElement>('[role="combobox"]'),
        ({ textContent }) => textContent
      )
      expect(selectedOptions).toEqual(["Security", "Sonnet"])
    } finally {
      await disposeDock(rendered)
    }
  })

  it("registers one PR thread and continues that exact conversation", async () => {
    const conversation = await Effect.runPromise(
      Schema.decodeUnknownEffect(PullRequestConversation)({
        _tag: "codecommit",
        route: {
          accountId: "123456789012",
          href: "/accounts/123456789012/prs/184",
          pullRequestId: "184"
        },
        selection,
        thread: {
          accountId: "123456789012",
          pullRequestId: "184",
          region: "eu-west-1",
          repositoryName: "payments"
        }
      })
    )
    const continuations: Array<string> = []
    const registration: RelayPullRequestDockRegistration = {
      context: [
        { id: "repository", label: "Repository", value: "payments" },
        { id: "pull-request", label: "PR", value: "#184" }
      ],
      conversation,
      continuePullRequestConversation: ({ message }) =>
        Effect.sync(() => {
          continuations.push(message)
        }),
      messages: [
        { id: "operator-1", role: "operator", text: "Check the retry boundary." },
        { id: "relay-1", role: "relay", text: "The retry lacks an idempotency key." }
      ],
      selection,
      status: "ready"
    }
    const rendered = await renderDock(
      <RelayProductDock host={host}>
        <RegisteredThread registration={registration} />
      </RelayProductDock>
    )
    try {
      await click(queryRequired(rendered.container, "[data-rly-relay-dock-trigger]"))
      expect(rendered.portal.textContent).toContain("Check the retry boundary.")
      expect(rendered.portal.textContent).toContain("The retry lacks an idempotency key.")

      const input = queryRequired<HTMLTextAreaElement>(rendered.portal, "textarea")
      await setTextareaValue(input, "Verify the fix on the current head.")
      await click(queryRequired(rendered.portal, 'button[type="submit"]'))

      expect(continuations).toEqual(["Verify the fix on the current head."])
    } finally {
      await disposeDock(rendered)
    }
  })

  it("allows an advertised alternate profile and model to continue the registered PR", async () => {
    const conversation = await Effect.runPromise(
      Schema.decodeUnknownEffect(PullRequestConversation)({
        _tag: "control-center",
        route: {
          entityId: "019c3df0-2222-7000-8000-000000000002",
          href: "/w/019c3df0-1111-7000-8000-000000000001/items/019c3df0-2222-7000-8000-000000000002"
        },
        selection: {
          modelId: "security",
          models: [
            { id: "security", label: "Security" },
            { id: "architecture", label: "Architecture" }
          ],
          profileId: "security",
          profiles: [
            { id: "security", label: "Security" },
            { id: "architecture", label: "Architecture" }
          ]
        },
        thread: {
          pluginConnectionId: "019c3df0-3333-7000-8000-000000000003",
          pullRequestId: "184",
          repositoryName: "payments",
          workspaceId: "019c3df0-1111-7000-8000-000000000001"
        }
      })
    )
    const delivered: Array<typeof ContinuePullRequestConversationRequest.Type> = []
    const registration: RelayPullRequestDockRegistration = {
      context: [{ id: "pull-request", label: "PR", value: "#184" }],
      conversation,
      continuePullRequestConversation: (request) =>
        Effect.sync(() => {
          delivered.push(request)
        }),
      messages: [],
      selection: conversation.selection,
      status: "ready"
    }
    const rendered = await renderDock(
      <RelayProductDock host={host}>
        <RegisteredThread registration={registration} />
      </RelayProductDock>
    )
    try {
      await click(queryRequired(rendered.container, "[data-rly-relay-dock-trigger]"))
      const selectors = rendered.portal.querySelectorAll<HTMLButtonElement>('[role="combobox"]')
      expect(selectors).toHaveLength(2)
      const profileSelector = selectors.item(0)
      const modelSelector = selectors.item(1)
      if (profileSelector === null || modelSelector === null) {
        throw new MissingDockTestElement({ selector: '[role="combobox"]' })
      }
      await click(profileSelector)
      await click(queryRequired(rendered.portal, '[role="option"]:nth-of-type(2)'))
      await click(modelSelector)
      await click(queryRequired(rendered.portal, '[role="option"]:nth-of-type(2)'))
      expect(
        relaySelectionMatchesRegistration(
          {
            modelId: "architecture",
            models: conversation.selection.models,
            profileId: "architecture",
            profiles: conversation.selection.profiles
          },
          registration
        )
      ).toBe(true)

      await setTextareaValue(
        queryRequired<HTMLTextAreaElement>(rendered.portal, "textarea"),
        "Continue with architecture."
      )
      await click(queryRequired(rendered.portal, 'button[type="submit"]'))

      expect(delivered).toHaveLength(1)
      expect(delivered[0]?.selection).toMatchObject({ modelId: "architecture", profileId: "architecture" })
    } finally {
      await disposeDock(rendered)
    }
  })

  it("clears a continuation draft when the registered PR changes", async () => {
    const conversationFor = (pullRequestId: string) =>
      Effect.runPromise(
        Schema.decodeUnknownEffect(PullRequestConversation)({
          _tag: "codecommit",
          route: {
            accountId: "123456789012",
            href: `/accounts/123456789012/prs/${pullRequestId}`,
            pullRequestId
          },
          selection,
          thread: {
            accountId: "123456789012",
            pullRequestId,
            region: "eu-west-1",
            repositoryName: "payments"
          }
        })
      )
    const conversation184 = await conversationFor("184")
    const conversation185 = await conversationFor("185")
    const delivered: Array<string> = []
    const registrationFor = (
      conversation: typeof conversation184,
      label: string
    ): RelayPullRequestDockRegistration => ({
      context: [{ id: "pull-request", label: "PR", value: label }],
      conversation,
      continuePullRequestConversation: ({ message }) =>
        Effect.sync(() => {
          delivered.push(`${label}:${message}`)
        }),
      messages: [],
      selection,
      status: "ready"
    })
    const rendered = await renderDock(
      <RelayProductDock host={host}>
        <RegisteredThread registration={registrationFor(conversation184, "#184")} />
      </RelayProductDock>
    )
    try {
      await click(queryRequired(rendered.container, "[data-rly-relay-dock-trigger]"))
      const input = queryRequired<HTMLTextAreaElement>(rendered.portal, "textarea")
      await setTextareaValue(input, "Do not send this to PR 185.")

      await act(async () =>
        rendered.root.render(
          <PortalProvider container={rendered.portal}>
            <RelayProductDock host={host}>
              <RegisteredThread registration={registrationFor(conversation185, "#185")} />
            </RelayProductDock>
          </PortalProvider>
        )
      )

      expect(queryRequired<HTMLTextAreaElement>(rendered.portal, "textarea").value).toBe("")
      await setTextareaValue(queryRequired<HTMLTextAreaElement>(rendered.portal, "textarea"), "Continue PR 185.")
      await click(queryRequired(rendered.portal, 'button[type="submit"]'))
      expect(delivered).toEqual(["#185:Continue PR 185."])
    } finally {
      await disposeDock(rendered)
    }
  })
})
