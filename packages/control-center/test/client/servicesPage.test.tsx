// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PluginConnectionSummary, PluginConnectionTestResult } from "../../src/api/plugins.js"
import { CsrfToken, SessionSummary } from "../../src/api/session.js"
import { BrowserSessionProvider, useBrowserSession } from "../../src/client/BrowserSession.js"
import type { ConnectionTestTransport } from "../../src/client/services/connectionTestTransport.js"
import { ServicesPage } from "../../src/client/services/ServicesPage.js"
import { PersonId, WorkspaceId } from "../../src/domain/identifiers.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const workspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000141")
const connection = Schema.decodeSync(PluginConnectionSummary)({
  pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000142",
  providerId: "jira",
  displayName: "Payments Jira",
  isEnabled: true,
  health: null,
  updatedAt: "2026-07-14T10:00:00.000Z"
})
const session = Schema.decodeSync(SessionSummary)({
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000143",
  workspaceId,
  actor: {
    _tag: "human",
    personId: Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000144")
  },
  permission: "workspace-owner",
  createdAt: "2026-07-14T10:00:00.000Z",
  lastSeenAt: "2026-07-14T10:01:00.000Z",
  idleExpiresAt: "2026-07-14T22:00:00.000Z",
  absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
  revokedAt: null
})
const csrfToken = Schema.decodeSync(CsrfToken)("ab".repeat(32))

let root: Root | undefined
let sessionControls: ReturnType<typeof useBrowserSession> | undefined

const Harness = ({ transport }: { readonly transport: ConnectionTestTransport }): ReactElement => {
  sessionControls = useBrowserSession()
  return <ServicesPage transport={transport} />
}

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  sessionControls = undefined
  document.body.replaceChildren()
  sessionStorage.clear()
})

const renderServices = async (transport: ConnectionTestTransport): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <MemoryRouter>
        <BrowserSessionProvider>
          <Harness transport={transport} />
        </BrowserSessionProvider>
      </MemoryRouter>
    )
  )
  await act(async () => sessionControls?.establishSession(csrfToken, session))
  return host
}

describe("ServicesPage connection tests", () => {
  it("shows testing, failure, retry, and the provider identity returned by success", async () => {
    const failed = Schema.decodeSync(PluginConnectionTestResult)({
      _tag: "failed",
      pluginConnectionId: connection.pluginConnectionId,
      providerId: "jira",
      checkedAt: "2026-07-14T10:02:00.000Z",
      latencyMilliseconds: 250,
      failureClass: "authentication",
      retryAt: null,
      safeMessage: "The provider rejected these credentials."
    })
    const healthy = Schema.decodeSync(PluginConnectionTestResult)({
      _tag: "healthy",
      pluginConnectionId: connection.pluginConnectionId,
      providerId: "jira",
      checkedAt: "2026-07-14T10:03:00.000Z",
      latencyMilliseconds: 84,
      identity: {
        kind: "user",
        label: "Atlassian user",
        displayName: "Avery Bell",
        providerImmutableId: "atlassian-account-123"
      }
    })
    let finishFirst: ((result: PluginConnectionTestResult) => void) | undefined
    const first = new Promise<PluginConnectionTestResult>((resolve) => {
      finishFirst = resolve
    })
    const test = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(healthy)
    const transport: ConnectionTestTransport = {
      list: () => Promise.resolve([connection]),
      test
    }
    const host = await renderServices(transport)
    await act(async () => undefined)

    const serviceMark = host.querySelector('[data-rly-service="jira"]')
    expect(serviceMark?.getAttribute("aria-label")).toBe("Jira")

    const action = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Test connection")
    )
    expect(action).toBeDefined()
    await act(async () => action?.click())
    expect(action?.disabled).toBe(true)

    await act(async () => finishFirst?.(failed))
    expect(host.textContent).toContain("The provider rejected these credentials.")
    expect(action?.textContent).toContain("Retry test")

    await act(async () => action?.click())
    expect(test).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain("Connection healthy")
    expect(host.textContent).toContain("Atlassian user")
    expect(host.textContent).toContain("Avery Bell")
    expect(host.textContent).toContain("atlassian-account-123")
    expect(host.textContent).toContain("84 ms")
  })
})
