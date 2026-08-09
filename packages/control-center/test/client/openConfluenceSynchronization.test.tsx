// @vitest-environment happy-dom

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import { act, type ReactElement, useRef } from "react"
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
const SYNCHRONIZATION_LEASE_MILLIS = 15 * 60_000
const ignoreSessionExpiration = (): void => undefined
const currentTimeMillis = (): Promise<number> => Effect.runPromise(Clock.currentTimeMillis)
const navigatorLocksDescriptor = Object.getOwnPropertyDescriptor(navigator, "locks")
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
  vi.restoreAllMocks()
  if (navigatorLocksDescriptor === undefined) Reflect.deleteProperty(navigator, "locks")
  else Object.defineProperty(navigator, "locks", navigatorLocksDescriptor)
})

const Harness = ({
  action = "afterMutation",
  enabled = true,
  onSessionExpired = ignoreSessionExpiration,
  onSynchronized,
  pluginConnectionId = PLUGIN_CONNECTION_ID,
  readSynchronizationRevision,
  sessionKey = "session-a",
  synchronizationRevision = 0,
  transport
}: {
  readonly action?: "afterMutation" | "now"
  readonly enabled?: boolean
  readonly onSessionExpired?: (sessionKey: string) => void
  readonly onSynchronized: () => void
  readonly pluginConnectionId?: PluginConnectionId
  readonly readSynchronizationRevision?: (signal: AbortSignal) => Promise<number | null>
  readonly sessionKey?: string
  readonly synchronizationRevision?: number
  readonly transport: OpenConfluenceSynchronizationTransport
}): ReactElement => {
  const defaultRevision = useRef(synchronizationRevision)
  const synchronization = useOpenConfluenceSynchronization({
    enabled,
    onSessionExpired,
    onSynchronized,
    pluginConnectionId,
    readSynchronizationRevision:
      readSynchronizationRevision ??
      (() => {
        defaultRevision.current += 1
        return Promise.resolve(defaultRevision.current)
      }),
    sessionKey,
    synchronizationRevision,
    transport
  })
  return (
    <button
      onClick={action === "afterMutation" ? synchronization.synchronizeAfterMutation : synchronization.synchronizeNow}
      type="button"
    >
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

  it("does not mark the open page current until its exact source synchronization advances", async () => {
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const readSynchronizationRevision = vi
      .fn<(signal: AbortSignal) => Promise<number | null>>()
      .mockResolvedValue(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
    const onSynchronized = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () =>
      root?.render(
        <Harness
          onSynchronized={onSynchronized}
          readSynchronizationRevision={readSynchronizationRevision}
          transport={transport}
        />
      )
    )
    await vi.waitFor(() => expect(readSynchronizationRevision).toHaveBeenCalledOnce())
    expect(onSynchronized).not.toHaveBeenCalled()
    expect(host.textContent).toBe("idle")

    const button = host.querySelector<HTMLButtonElement>("button")
    if (button === null) throw new Error("Expected synchronization harness")
    await act(async () => button.click())
    await vi.waitFor(() => expect(readSynchronizationRevision).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(onSynchronized).toHaveBeenCalledOnce())
    expect(host.textContent).toBe("synchronized")
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
    const readSynchronizationRevision = vi
      .fn<(signal: AbortSignal) => Promise<number | null>>()
      .mockResolvedValue(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
    const onSynchronized = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () =>
      root?.render(
        <Harness
          onSynchronized={onSynchronized}
          readSynchronizationRevision={readSynchronizationRevision}
          transport={transport}
        />
      )
    )
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledOnce())
    const button = host.querySelector<HTMLButtonElement>("button")
    if (button === null) throw new Error("Expected synchronization harness")
    await act(async () => button.click())
    expect(transport.synchronize).toHaveBeenCalledOnce()

    await act(async () => resolveInitial(synchronizationState("synchronized")))
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(onSynchronized).toHaveBeenCalledTimes(2))
    expect(host.textContent).toBe("synchronized")
  })

  it("rebases queued post-mutation verification after the preceding synchronization", async () => {
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
    const readSynchronizationRevision = vi.fn().mockResolvedValue(1)
    const onSynchronized = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () =>
      root?.render(
        <Harness
          onSynchronized={onSynchronized}
          readSynchronizationRevision={readSynchronizationRevision}
          transport={transport}
        />
      )
    )
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledOnce())
    const button = host.querySelector<HTMLButtonElement>("button")
    if (button === null) throw new Error("Expected synchronization harness")
    await act(async () => button.click())

    await act(async () => resolveInitial(synchronizationState("synchronized")))
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(readSynchronizationRevision).toHaveBeenCalledTimes(2))

    expect(onSynchronized).toHaveBeenCalledOnce()
    expect(host.textContent).toBe("idle")
  })

  it("clears a canceled lease and refreshes immediately after remount", async () => {
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

    await act(async () => root?.unmount())
    expect(localStorage.getItem(`control-center:confluence-sync:${PLUGIN_CONNECTION_ID}`)).toBeNull()
    root = createRoot(host)
    await act(async () => root?.render(<Harness onSynchronized={() => undefined} transport={transport} />))
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledTimes(2))
    await act(async () => resolveInitial(synchronizationState("synchronized")))
    await act(async () => Promise.resolve())
  })

  it("does not start cross-tab waits while an in-document synchronization is active", async () => {
    let resolveInitial = (_state: PluginSynchronizationState): void => {
      throw new Error("Expected the initial synchronization resolver")
    }
    const initial = new Promise<PluginSynchronizationState>((resolve) => {
      resolveInitial = resolve
    })
    const transport = {
      synchronize: vi.fn(() => initial)
    } satisfies OpenConfluenceSynchronizationTransport
    const storageListeners = vi.spyOn(window, "addEventListener")
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () => root?.render(<Harness onSynchronized={() => undefined} transport={transport} />))
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledOnce())
    const listenerCount = storageListeners.mock.calls.filter(([event]) => event === "storage").length
    const button = host.querySelector<HTMLButtonElement>("button")
    if (button === null) throw new Error("Expected synchronization harness")
    await act(async () => {
      button.click()
      button.click()
      button.click()
    })

    expect(storageListeners.mock.calls.filter(([event]) => event === "storage")).toHaveLength(listenerCount)
    await act(async () => resolveInitial(synchronizationState("synchronized")))
  })

  it("queues a post-mutation refresh behind synchronization active in another tab", async () => {
    setDocumentVisibility("hidden")
    const storageKey = `control-center:confluence-sync:${PLUGIN_CONNECTION_ID}`
    const recordedAt = await currentTimeMillis()
    localStorage.setItem(
      storageKey,
      JSON.stringify({ ownerKey: "other-tab", recordedAt, sessionExpired: false, state: "syncing" })
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
      ownerKey: "other-tab",
      recordedAt: await currentTimeMillis(),
      sessionExpired: false,
      state: "synchronized"
    })
    localStorage.setItem(storageKey, completed)
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: completed })))
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledOnce())
  })

  it("queues a manual refresh behind synchronization active in another tab", async () => {
    setDocumentVisibility("hidden")
    const storageKey = `control-center:confluence-sync:${PLUGIN_CONNECTION_ID}`
    const recordedAt = await currentTimeMillis()
    localStorage.setItem(
      storageKey,
      JSON.stringify({ ownerKey: "other-tab", recordedAt, sessionExpired: false, state: "syncing" })
    )
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(<Harness action="now" onSynchronized={() => undefined} transport={transport} />))
    const button = host.querySelector<HTMLButtonElement>("button")
    if (button === null) throw new Error("Expected synchronization harness")

    await act(async () => button.click())
    expect(transport.synchronize).not.toHaveBeenCalled()

    const completed = JSON.stringify({
      ownerKey: "other-tab",
      recordedAt: await currentTimeMillis(),
      sessionExpired: false,
      state: "synchronized"
    })
    localStorage.setItem(storageKey, completed)
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: completed })))
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledOnce())
  })

  it("starts a manual refresh immediately when no synchronization is active", async () => {
    setDocumentVisibility("hidden")
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(<Harness action="now" onSynchronized={() => undefined} transport={transport} />))
    const button = host.querySelector<HTMLButtonElement>("button")
    if (button === null) throw new Error("Expected synchronization harness")

    await act(async () => button.click())
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledOnce())
  })

  it("queues a post-mutation refresh until a contended Web Lock becomes available", async () => {
    setDocumentVisibility("hidden")
    let acquire = (): void => {
      throw new Error("Expected a queued Web Lock callback")
    }
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: vi.fn(
          (_name: string, _options: LockOptions, callback: LockGrantedCallback<unknown>) =>
            new Promise<unknown>((resolve, reject) => {
              acquire = () =>
                Promise.resolve(callback({ name: "control-center:confluence-sync", mode: "exclusive" })).then(
                  resolve,
                  reject
                )
            })
        )
      }
    })
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
    expect(localStorage.getItem(`control-center:confluence-sync:${PLUGIN_CONNECTION_ID}`)).toBeNull()
    expect(transport.synchronize).not.toHaveBeenCalled()

    const storageKey = `control-center:confluence-sync:${PLUGIN_CONNECTION_ID}`
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ownerKey: "other-tab",
        recordedAt: await currentTimeMillis(),
        sessionExpired: false,
        state: "synchronized"
      })
    )
    await act(async () => acquire())

    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledOnce())
  })

  it("starts a manual refresh immediately when the Web Lock is available", async () => {
    setDocumentVisibility("hidden")
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: vi.fn((_name: string, _options: LockOptions, callback: LockGrantedCallback<unknown>) =>
          Promise.resolve(callback({ name: "control-center:confluence-sync", mode: "exclusive" }))
        )
      }
    })
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(<Harness action="now" onSynchronized={() => undefined} transport={transport} />))
    const button = host.querySelector<HTMLButtonElement>("button")
    if (button === null) throw new Error("Expected synchronization harness")

    await act(async () => button.click())

    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledOnce())
  })

  it("keeps the cadence serialized behind an active manual refresh", async () => {
    vi.useFakeTimers()
    let resolveManual = (_state: PluginSynchronizationState): void => {
      throw new Error("Expected the manual synchronization resolver")
    }
    const manual = new Promise<PluginSynchronizationState>((resolve) => {
      resolveManual = resolve
    })
    let calls = 0
    const transport = {
      synchronize: vi.fn(() => {
        calls += 1
        return calls === 2 ? manual : Promise.resolve(synchronizationState("synchronized"))
      })
    } satisfies OpenConfluenceSynchronizationTransport
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(<Harness action="now" onSynchronized={() => undefined} transport={transport} />))
    await act(async () => Promise.resolve())
    expect(transport.synchronize).toHaveBeenCalledOnce()

    await act(async () => vi.advanceTimersByTimeAsync(14_999))
    const button = host.querySelector<HTMLButtonElement>("button")
    if (button === null) throw new Error("Expected synchronization harness")
    await act(async () => button.click())
    expect(transport.synchronize).toHaveBeenCalledTimes(2)

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(transport.synchronize).toHaveBeenCalledTimes(2)
    await act(async () => resolveManual(synchronizationState("synchronized")))
    expect(transport.synchronize).toHaveBeenCalledTimes(2)
  })

  it("waits beyond one cadence for a live cross-tab lease", async () => {
    vi.useFakeTimers()
    setDocumentVisibility("hidden")
    const storageKey = `control-center:confluence-sync:${PLUGIN_CONNECTION_ID}`
    const recordedAt = await currentTimeMillis()
    localStorage.setItem(
      storageKey,
      JSON.stringify({ ownerKey: "other-tab", recordedAt, sessionExpired: false, state: "syncing" })
    )
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(<Harness action="now" onSynchronized={() => undefined} transport={transport} />))
    const button = host.querySelector<HTMLButtonElement>("button")
    if (button === null) throw new Error("Expected synchronization harness")
    await act(async () => button.click())

    await act(async () => vi.advanceTimersByTimeAsync(15_001))
    expect(transport.synchronize).not.toHaveBeenCalled()

    const completed = JSON.stringify({
      ownerKey: "other-tab",
      recordedAt: await currentTimeMillis(),
      sessionExpired: false,
      state: "synchronized"
    })
    localStorage.setItem(storageKey, completed)
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: completed })))
    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledOnce())
  })

  it("refreshes after an orphaned cross-tab lease expires", async () => {
    setDocumentVisibility("hidden")
    const recordedAt = (await currentTimeMillis()) - SYNCHRONIZATION_LEASE_MILLIS - 1
    localStorage.setItem(
      `control-center:confluence-sync:${PLUGIN_CONNECTION_ID}`,
      JSON.stringify({ ownerKey: "other-tab", recordedAt, sessionExpired: false, state: "syncing" })
    )
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(<Harness action="now" onSynchronized={() => undefined} transport={transport} />))
    const button = host.querySelector<HTMLButtonElement>("button")
    if (button === null) throw new Error("Expected synchronization harness")

    await act(async () => button.click())
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
    const recordedAt = await currentTimeMillis()
    localStorage.setItem(
      `control-center:confluence-sync:${PLUGIN_CONNECTION_ID}`,
      JSON.stringify({ ownerKey: "other-tab", recordedAt, sessionExpired: false, state: "synchronized" })
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

  it("ignores a synchronization record beyond the forward clock-skew tolerance", async () => {
    const recordedAt = (await currentTimeMillis()) + 60_000
    localStorage.setItem(
      `control-center:confluence-sync:${PLUGIN_CONNECTION_ID}`,
      JSON.stringify({ ownerKey: "other-tab", recordedAt, sessionExpired: false, state: "synchronized" })
    )
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
    } satisfies OpenConfluenceSynchronizationTransport
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)

    await act(async () => root?.render(<Harness onSynchronized={() => undefined} transport={transport} />))

    await vi.waitFor(() => expect(transport.synchronize).toHaveBeenCalledOnce())
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
            ownerKey: "other-tab",
            recordedAt: await currentTimeMillis(),
            sessionExpired: false,
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
    const persisted = localStorage.getItem(`control-center:confluence-sync:${PLUGIN_CONNECTION_ID}`)
    expect(persisted).not.toBeNull()
    expect(persisted).not.toContain("session-a")
  })

  it("attributes lock-coordinator failures to the initiating browser session", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: vi.fn(() => Promise.reject({ _tag: "UnauthorizedApiError" })) }
    })
    const transport = {
      synchronize: vi.fn(() => Promise.resolve(synchronizationState("synchronized")))
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
    expect(transport.synchronize).not.toHaveBeenCalled()
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
      ownerKey: "other-tab",
      recordedAt: await currentTimeMillis(),
      sessionExpired: true,
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

    await act(async () => root?.unmount())
    root = createRoot(host)
    await act(async () => root?.render(<Harness onSynchronized={onSynchronized} transport={transport} />))
    await vi.waitFor(() => expect(host.textContent).toBe("failed"))
    expect(transport.synchronize).toHaveBeenCalledOnce()
  })
})
