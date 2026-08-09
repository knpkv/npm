// @vitest-environment happy-dom

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  type OpenConfluenceSynchronizationTransport,
  useOpenConfluenceSynchronization
} from "../../src/client/entities/useOpenConfluenceSynchronization.js"
import { PluginConnectionId } from "../../src/domain/identifiers.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let root: Root | null = null
const ignoreSessionExpiration = (): void => undefined
const setDocumentVisibility = (visibilityState: DocumentVisibilityState): void => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: visibilityState })
}

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  setDocumentVisibility("visible")
  vi.useRealTimers()
})

const Harness = ({
  onSessionExpired = ignoreSessionExpiration,
  onSynchronized,
  transport
}: {
  readonly onSessionExpired?: (sessionKey: string) => void
  readonly onSynchronized: () => void
  readonly transport: OpenConfluenceSynchronizationTransport
}): ReactElement => {
  const synchronization = useOpenConfluenceSynchronization({
    enabled: true,
    onSessionExpired,
    onSynchronized,
    pluginConnectionId: PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000099"),
    sessionKey: "session-a",
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
      synchronize: vi.fn(() => Promise.resolve())
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

  it("polls every 15 seconds only while visible and refreshes immediately when shown again", async () => {
    vi.useFakeTimers()
    const transport = {
      synchronize: vi.fn(() => Promise.resolve())
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
})
