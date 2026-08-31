import { PortalProvider } from "@knpkv/rly/foundations"
import { describe, expect, it } from "@effect/vitest"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"

import {
  PullRequestConversation,
  RelayProductDock,
  type RelayProductDockHost,
  type RelayPullRequestDockRegistration,
  RelaySelectorState,
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
  it("renders on the host page collapsed, then exposes the profile and model selectors", async () => {
    const rendered = await renderDock(<RelayProductDock host={host}>Host page</RelayProductDock>)
    try {
      expect(rendered.container.textContent).toContain("Host page")
      expect(rendered.portal.querySelector('[role="dialog"]')).toBeNull()

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
})
