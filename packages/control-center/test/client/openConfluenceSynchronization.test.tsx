// @vitest-environment happy-dom

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  type OpenConfluenceSynchronizationTransport,
  useOpenConfluenceSynchronization
} from "../../src/client/entities/useOpenConfluenceSynchronization.js"
import type { PluginSynchronizationResult, PluginSynchronizationState } from "../../src/api/plugins.js"
import { PluginConnectionId } from "../../src/domain/identifiers.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let root: Root | null = null
const PLUGIN_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000099")
const OTHER_PLUGIN_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000100")
const ignoreSessionExpiration = (): void => undefined
const synchronizationState = (result: PluginSynchronizationResult): PluginSynchronizationState => ({
  pluginConnectionId: PLUGIN_CONNECTION_ID,
  providerId: "confluence",
  streamKey: "pages",
  lastAttemptAt: null,
  lastSuccessAt: null,
  result,
  pagesCommitted: 0
})
const setDocumentVisibility = (visibilityState: DocumentVisibilityState): void => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: visibilityState })
}

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  localStorage.clear()
  setDocumentVisibility("visible")
  vi.useRealTimers()
})

const Harness = ({
  onSessionExpired = ignoreSessionExpiration,
  onSynchronized,
  pluginConnectionId = PLUGIN_CONNECTION_ID,
  sessionKey = "session-a",
  transport
}: {
  readonly onSessionExpired?: (sessionKey: string) => void
  readonly onSynchronized: () => void
  readonly pluginConnectionId?: PluginConnectionId
  readonly sessionKey?: string
  readonly transport: OpenConfluenceSynchronizationTransport
}): ReactElement => {
  const synchronization = useOpenConfluenceSynchronization({
    enabled: true,
    onSessionExpired,
    onSynchronized,
    pluginConnectionId,
    sessionKey,
    transport
  })
  return (
    <button onClick={synchronization.synchronizeAfterMutation} type="button">
      {synchronization.state}
    </button>
  )
}

describe("open Confluence page synchronization", () => {
  it("synchronizes on open and exposes an immediate post-mutation refresh", async () => {
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const onSynchronized = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () => root?.render(<Harness onSynchronized={onSynchronized} transport={transport} />))
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(onSynchronized).toHaveBeenCalledOnce())

    const button = host.querySelector<HTMLButtonElement>("button")
    if (button === null) throw new Error("Expected synchronization harness")
    await act(async () => button.click())
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(onSynchronized).toHaveBeenCalledTimes(2))
  })

  it("queues a post-mutation refresh behind active automatic synchronization", async () => {
    let resolveInitial = (_state: PluginSynchronizationState): void => {
      throw new Error("Expected the initial synchronization resolver")
    }
    const initial = new Promise<PluginSynchronizationState>((resolve) => {
      resolveInitial = resolve
    })
    let calls = 0
    const transport = {
      synchronize: vi.fn(() => {
        calls += 1
        return calls === 1 ? initial : Promise.resolve(synchronizationState("synchronized"))
      })
    } satisfies OpenConfluenceSynchronizationTransport
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () => root?.render(<Harness onSynchronized={() => undefined} transport={transport} />))
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledOnce())
    const button = host.querySelector<HTMLButtonElement>("button")
    if (button === null) throw new Error("Expected synchronization harness")
    await act(async () => button.click())
    expect(transport.synchronize).toHaveBeenCalledOnce()

    await act(async () => resolveInitial(synchronizationState("synchronized")))
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledTimes(2))
  })

  it("queues a post-mutation refresh behind synchronization active in another tab", async () => {
    setDocumentVisibility("hidden")
    const storageKey = `control-center:confluence-sync:${PLUGIN_CONNECTION_ID}`
    localStorage.setItem(
      storageKey,
      JSON.stringify({ recordedAt: Date.now(), sessionExpired: false, sessionKey: "session-a", state: "syncing" })
    )
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(<Harness onSynchronized={() => undefined} transport={transport} />))
    const button = host.querySelector<HTMLButtonElement>("button")
    if (button === null) throw new Error("Expected synchronization harness")

    await act(async () => button.click())
    expect(transport.synchronize).not.toHaveBeenCalled()

    const completed = JSON.stringify({
      recordedAt: Date.now(),
      sessionExpired: false,
      sessionKey: "session-a",
      state: "synchronized"
    })
    localStorage.setItem(storageKey, completed)
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: completed })))
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledOnce())
  })

  it("polls every 15 seconds only while visible and refreshes immediately when shown again", async () => {
    vi.useFakeTimers()
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () => root?.render(<Harness onSynchronized={() => undefined} transport={transport} />))
    await act(async () => Promise.resolve())
    expect(transport.synchronize).toHaveBeenCalledOnce()

    await act(async () => vi.advanceTimersByTimeAsync(14_999))
    expect(transport.synchronize).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(transport.synchronize).toHaveBeenCalledTimes(2)

    setDocumentVisibility("hidden")
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(transport.synchronize).toHaveBeenCalledTimes(2)

    setDocumentVisibility("visible")
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    expect(transport.synchronize).toHaveBeenCalledTimes(3)
  })

  it("restarts the cadence after synchronizing on visibility", async () => {
    vi.useFakeTimers()
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () => root?.render(<Harness onSynchronized={() => undefined} transport={transport} />))
    await act(async () => Promise.resolve())
    expect(transport.synchronize).toHaveBeenCalledOnce()
    setDocumentVisibility("hidden")
    await act(async () => vi.advanceTimersByTimeAsync(14_999))
    setDocumentVisibility("visible")
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    expect(transport.synchronize).toHaveBeenCalledTimes(2)

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(transport.synchronize).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(14_999))
    expect(transport.synchronize).toHaveBeenCalledTimes(3)
  })

  it("shares automatic polling across controllers for the same connection", async () => {
    vi.useFakeTimers()
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const onSynchronized = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () =>
      root?.render(
        <>
          <Harness onSynchronized={onSynchronized} transport={transport} />
          <Harness onSynchronized={onSynchronized} transport={transport} />
          <Harness onSynchronized={onSynchronized} transport={transport} />
        </>
      )
    )
    await act(async () => Promise.resolve())

    expect(transport.synchronize).toHaveBeenCalledOnce()
    expect(onSynchronized).toHaveBeenCalledTimes(3)
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(transport.synchronize).toHaveBeenCalledTimes(2)
    expect(onSynchronized).toHaveBeenCalledTimes(6)
  })

  it("polls distinct connections independently", async () => {
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () =>
      root?.render(
        <>
          <Harness onSynchronized={() => undefined} transport={transport} />
          <Harness
            onSynchronized={() => undefined}
            pluginConnectionId={OTHER_PLUGIN_CONNECTION_ID}
            transport={transport}
          />
        </>
      )
    )

    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledTimes(2))
    expect(transport.synchronize).toHaveBeenCalledWith(PLUGIN_CONNECTION_ID, expect.any(AbortSignal))
    expect(transport.synchronize).toHaveBeenCalledWith(OTHER_PLUGIN_CONNECTION_ID, expect.any(AbortSignal))
  })

  it("reuses a recent same-origin tab synchronization without another provider request", async () => {
    localStorage.setItem(
      `control-center:confluence-sync:${PLUGIN_CONNECTION_ID}`,
      JSON.stringify({ recordedAt: Date.now(), sessionExpired: false, sessionKey: "session-a", state: "synchronized" })
    )
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const onSynchronized = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () => root?.render(<Harness onSynchronized={onSynchronized} transport={transport} />))

    await vi.waitFor(() => expect(onSynchronized).toHaveBeenCalledOnce())
    expect(transport.synchronize).not.toHaveBeenCalled()
    expect(host.textContent).toBe("synchronized")
  })

  it("applies synchronization results broadcast by another same-origin tab", async () => {
    setDocumentVisibility("hidden")
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const onSynchronized = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(<Harness onSynchronized={onSynchronized} transport={transport} />))

    await act(async () =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: `control-center:confluence-sync:${PLUGIN_CONNECTION_ID}`,
          newValue: JSON.stringify({
            recordedAt: Date.now(),
            sessionExpired: false,
            sessionKey: "session-a",
            state: "synchronized"
          })
        })
      )
    )

    expect(transport.synchronize).not.toHaveBeenCalled()
    expect(onSynchronized).toHaveBeenCalledOnce()
    expect(host.textContent).toBe("synchronized")
  })

  it("invalidates the exact browser session after an unauthorized synchronization", async () => {
    const transport = {
      synchronize: vi.fn(() => Promise.reject({ _tag: "UnauthorizedApiError" }))
    } satisfies OpenConfluenceSynchronizationTransport
    const onSessionExpired = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () =>
      root?.render(
        <Harness onSessionExpired={onSessionExpired} onSynchronized={() => undefined} transport={transport} />
      )
    )

    await vi.waitFor(() => expect(onSessionExpired).toHaveBeenCalledWith("session-a"))
    expect(host.textContent).toBe("failed")
  })

  it("does not replay another tab's expired session into a replacement session", async () => {
    setDocumentVisibility("hidden")
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const onSessionExpired = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <Harness
          onSessionExpired={onSessionExpired}
          onSynchronized={() => undefined}
          sessionKey="session-b"
          transport={transport}
        />
      )
    )

    const storageKey = `control-center:confluence-sync:${PLUGIN_CONNECTION_ID}`
    const expired = JSON.stringify({
      recordedAt: Date.now(),
      sessionExpired: true,
      sessionKey: "session-a",
      state: "failed"
    })
    setDocumentVisibility("visible")
    localStorage.setItem(storageKey, expired)
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: expired })))

    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledOnce())
    expect(onSessionExpired).not.toHaveBeenCalled()
    expect(host.textContent).toBe("synchronized")
  })

  it("fails without refreshing when synchronization returns a non-success result", async () => {
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("source-unavailable")))
    } satisfies OpenConfluenceSynchronizationTransport
    const onSynchronized = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () => root?.render(<Harness onSynchronized={onSynchronized} transport={transport} />))

    await vi.waitFor(() => expect(host.textContent).toBe("failed"))
    expect(onSynchronized).not.toHaveBeenCalled()
  })
})
