// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  CreatePluginConnectionResponse,
  PluginConnectionSummary,
  PluginConnectionTestResult,
  PluginOverviewResponse
} from "../../src/api/plugins.js"
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
const catalogEntry = (providerId: "codecommit" | "codepipeline" | "jira" | "confluence" | "clockify") => ({
  providerId,
  displayName: providerId,
  description: `Configure ${providerId}.`,
  configurationFields: [
    {
      key: "profile",
      label: "Profile",
      description: "Local configuration value.",
      kind: "text",
      scope: "adapter",
      required: true,
      defaultValue: "default",
      isReadOnly: false,
      minimum: null,
      maximum: null
    }
  ]
})
const overview = Schema.decodeUnknownSync(PluginOverviewResponse)({
  catalog: [
    catalogEntry("codecommit"),
    catalogEntry("codepipeline"),
    catalogEntry("jira"),
    catalogEntry("confluence"),
    catalogEntry("clockify")
  ],
  connections: [Schema.encodeSync(PluginConnectionSummary)(connection)]
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
  it("does not present stale disabled health as current for an enabled connection", async () => {
    const enabledWithStaleHealth = Schema.decodeSync(PluginConnectionSummary)({
      ...Schema.encodeSync(PluginConnectionSummary)(connection),
      isEnabled: true,
      health: {
        _tag: "disabled",
        checkedAt: "2026-07-14T10:00:00.000Z"
      }
    })
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      overview: () => Promise.resolve({ ...overview, connections: [enabledWithStaleHealth] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    const connectionCard = [...host.querySelectorAll<HTMLElement>("article")].find((card) =>
      card.textContent?.includes("Payments Jira")
    )
    expect(connectionCard?.textContent).toContain("Not checked")
    expect(connectionCard?.textContent).not.toContain("Disabled")
  })

  it("renders the fresh five, opens setup, submits, and shows the immediate identity", async () => {
    const created = Schema.decodeUnknownSync(CreatePluginConnectionResponse)({
      connection: {
        pluginConnectionId: connection.pluginConnectionId,
        providerId: "codecommit",
        displayName: "Payments CodeCommit",
        isEnabled: true,
        health: null,
        updatedAt: "2026-07-14T10:03:00.000Z"
      },
      configuration: {
        pluginConnectionId: connection.pluginConnectionId,
        revision: 1,
        values: [{ _tag: "text", key: "profile", value: "default" }],
        updatedAt: "2026-07-14T10:03:00.000Z"
      },
      test: {
        _tag: "healthy",
        pluginConnectionId: connection.pluginConnectionId,
        providerId: "codecommit",
        checkedAt: "2026-07-14T10:03:00.000Z",
        latencyMilliseconds: 42,
        identity: {
          kind: "account",
          label: "AWS account",
          displayName: "Production account",
          providerImmutableId: "123456789012"
        }
      }
    })
    const create = vi.fn().mockResolvedValue(created)
    const transport: ConnectionTestTransport = {
      create,
      overview: () => Promise.resolve({ ...overview, connections: [] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    expect(host.querySelectorAll("article")).toHaveLength(5)

    const configure = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable service")
    )
    await act(async () => configure?.click())
    const name = host.querySelector<HTMLInputElement>('input[aria-labelledby*="label"]')
    expect(name).not.toBeNull()
    if (name !== null) {
      await act(async () => {
        name.value = "Payments CodeCommit"
        name.dispatchEvent(new Event("input", { bubbles: true }))
      })
    }
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable and test")
    )
    await act(async () => submit?.click())
    expect(create).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain("Production account")
    expect(host.textContent).toContain("123456789012")
  })

  it("keeps a correction form visible when the initial connection test fails", async () => {
    const created = Schema.decodeUnknownSync(CreatePluginConnectionResponse)({
      connection: {
        pluginConnectionId: connection.pluginConnectionId,
        providerId: "codecommit",
        displayName: "Rejected CodeCommit",
        isEnabled: true,
        health: {
          _tag: "unavailable",
          checkedAt: "2026-07-14T10:03:00.000Z",
          failureClass: "authentication",
          retryAt: null,
          safeMessage: "The provider rejected these credentials."
        },
        updatedAt: "2026-07-14T10:03:00.000Z"
      },
      configuration: {
        pluginConnectionId: connection.pluginConnectionId,
        revision: 1,
        values: [{ _tag: "text", key: "profile", value: "default" }],
        updatedAt: "2026-07-14T10:03:00.000Z"
      },
      test: {
        _tag: "failed",
        pluginConnectionId: connection.pluginConnectionId,
        providerId: "codecommit",
        checkedAt: "2026-07-14T10:03:00.000Z",
        latencyMilliseconds: 42,
        failureClass: "authentication",
        retryAt: null,
        safeMessage: "The provider rejected these credentials."
      }
    })
    const transport: ConnectionTestTransport = {
      create: vi.fn().mockResolvedValue(created),
      overview: () => Promise.resolve({ ...overview, connections: [] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    const configure = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable service")
    )
    await act(async () => configure?.click())
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable and test")
    )
    await act(async () => submit?.click())

    expect(host.textContent).toContain("The provider rejected these credentials.")
    expect(host.textContent).toContain("Needs correction")
    expect(host.textContent).toContain("Enable and test")
    expect(host.querySelector("form")).not.toBeNull()
  })

  it("keeps setup open and announces an inline error when creation fails", async () => {
    const transport: ConnectionTestTransport = {
      create: vi.fn().mockRejectedValue(new Error("unavailable")),
      overview: () => Promise.resolve({ ...overview, connections: [] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    const configure = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable service")
    )
    await act(async () => configure?.click())
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable and test")
    )
    await act(async () => submit?.click())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not create")
    expect(host.textContent).toContain("Enable and test")
  })

  it("aborts an in-flight setup request when the browser session changes", async () => {
    let setupSignal: AbortSignal | undefined
    const transport: ConnectionTestTransport = {
      create: (_request, signal) => {
        setupSignal = signal
        return new Promise(() => undefined)
      },
      overview: () => Promise.resolve({ ...overview, connections: [] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    const configure = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable service")
    )
    await act(async () => configure?.click())
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable and test")
    )
    await act(async () => submit?.click())
    await act(async () => undefined)
    expect(setupSignal?.aborted).toBe(false)
    await act(async () => sessionControls?.invalidateSession(session.sessionId))
    expect(setupSignal?.aborted).toBe(true)
    await act(async () => sessionControls?.establishSession(csrfToken, session))
    await act(async () => undefined)
    const configureAfterReconnect = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable service")
    )
    await act(async () => configureAfterReconnect?.click())
    const submitAfterReconnect = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable and test")
    )
    expect(submitAfterReconnect?.disabled).toBe(false)
  })

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
      create: vi.fn(),
      overview: () => Promise.resolve(overview),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
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

  it("enables and tests a disabled connection, then lets the owner disable it again", async () => {
    const disabled = Schema.decodeSync(PluginConnectionSummary)({
      ...Schema.encodeSync(PluginConnectionSummary)(connection),
      isEnabled: false,
      health: {
        _tag: "healthy",
        checkedAt: "2026-07-14T10:00:00.000Z"
      }
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
    const setEnabled = vi.fn((pluginConnectionId, isEnabled) =>
      Promise.resolve(
        Schema.decodeSync(PluginConnectionSummary)({
          ...Schema.encodeSync(PluginConnectionSummary)(disabled),
          pluginConnectionId,
          isEnabled,
          updatedAt: "2026-07-14T10:04:00.000Z"
        })
      )
    )
    const test = vi.fn().mockResolvedValue(healthy)
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      overview: () => Promise.resolve({ ...overview, connections: [disabled] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled,
      test
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    const connectionCard = [...host.querySelectorAll<HTMLElement>("article")].find((card) =>
      card.textContent?.includes("Payments Jira")
    )
    expect(connectionCard?.textContent).toContain("Disabled")
    expect(connectionCard?.textContent).not.toContain("Healthy")

    const enable = [...(connectionCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(({ textContent }) =>
      textContent?.includes("Enable service")
    )
    await act(async () => enable?.click())
    expect(setEnabled).toHaveBeenLastCalledWith(connection.pluginConnectionId, true, expect.any(AbortSignal))
    expect(test).toHaveBeenCalledWith(connection.pluginConnectionId, expect.any(AbortSignal))
    expect(connectionCard?.textContent).toContain("Connection healthy")

    const disable = [...(connectionCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(({ textContent }) =>
      textContent?.includes("Disable")
    )
    await act(async () => disable?.click())
    expect(setEnabled).toHaveBeenLastCalledWith(connection.pluginConnectionId, false, expect.any(AbortSignal))
    expect(connectionCard?.textContent).toContain("Disabled")
    expect(connectionCard?.textContent).not.toContain("Connection healthy")
  })

  it("recovers the test action when disabling aborts a test but the mutation fails", async () => {
    let testSignal: AbortSignal | undefined
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      overview: () => Promise.resolve(overview),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn().mockRejectedValue(new Error("conflict")),
      test: (_pluginConnectionId, signal) => {
        testSignal = signal
        return new Promise(() => undefined)
      }
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    const connectionCard = [...host.querySelectorAll<HTMLElement>("article")].find((card) =>
      card.textContent?.includes("Payments Jira")
    )
    const test = [...(connectionCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(({ textContent }) =>
      textContent?.includes("Test connection")
    )
    await act(async () => test?.click())
    expect(testSignal?.aborted).toBe(false)

    const disable = [...(connectionCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(({ textContent }) =>
      textContent?.includes("Disable")
    )
    await act(async () => disable?.click())
    expect(testSignal?.aborted).toBe(true)
    expect(connectionCard?.textContent).toContain("could not change this service")
    const recoveredTest = [...(connectionCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      ({ textContent }) => textContent?.includes("Test connection")
    )
    expect(recoveredTest?.disabled).toBe(false)
  })
})
