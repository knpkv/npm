// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PluginSynchronizationState } from "../../src/api/plugins.js"
import { ConnectionSynchronization } from "../../src/client/services/ConnectionSynchronization.js"
import type { ConnectionSynchronizationViewState } from "../../src/client/services/ConnectionSynchronizationView.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let root: Root | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe("ConnectionSynchronization", () => {
  it("starts and stops the details clock without replacing the focused sync control", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-08T19:35:00Z") })
    const synchronization = Schema.decodeUnknownSync(PluginSynchronizationState)({
      pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000201",
      providerId: "codecommit",
      streamKey: "pull-requests",
      lastAttemptAt: null,
      lastSuccessAt: null,
      result: "never",
      pagesCommitted: 0
    })
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    const render = (state: ConnectionSynchronizationViewState) =>
      act(async () =>
        root?.render(
          <ConnectionSynchronization canSynchronize onRefresh={vi.fn()} onSynchronize={vi.fn()} state={state} />
        )
      )
    await render({ _tag: "failed" })
    const control = host.querySelector<HTMLButtonElement>("button")
    control?.focus()
    expect(vi.getTimerCount()).toBe(0)
    await render({ _tag: "ready", synchronization })
    expect(host.querySelector("button")).toBe(control)
    expect(document.activeElement).toBe(control)
    expect(vi.getTimerCount()).toBe(1)
    await render({ _tag: "failed" })
    expect(vi.getTimerCount()).toBe(0)
  })

  // "Synced just now" must not stay on an idle page for hours.
  it("keeps the relative sync time current while the page stays open", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-08T19:35:00Z") })
    const synchronization = Schema.decodeUnknownSync(PluginSynchronizationState)({
      pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000201",
      providerId: "codecommit",
      streamKey: "pull-requests",
      lastAttemptAt: "2026-10-08T19:34:50.000Z",
      lastSuccessAt: "2026-10-08T19:34:50.000Z",
      result: "synchronized",
      pagesCommitted: 1
    })
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <ConnectionSynchronization
          canSynchronize
          onRefresh={() => undefined}
          onSynchronize={() => undefined}
          state={{ _tag: "ready", synchronization }}
        />
      )
    )
    expect(host.textContent).toContain("Synced just now")
    await act(async () => vi.advanceTimersByTime(3 * 60_000))
    expect(host.textContent).toContain("Synced 3 min ago")
  })
})

describe("server-owned synchronization presentation", () => {
  const results: ReadonlyArray<PluginSynchronizationState["result"]> = ["queued", "running", "never", "synchronized"]
  for (const result of results) {
    it(`${result} shows its server state and permits Sync only when idle`, async () => {
      const host = document.createElement("div")
      document.body.append(host)
      root = createRoot(host)
      const onSynchronize = vi.fn()
      const synchronization = Schema.decodeUnknownSync(PluginSynchronizationState)({
        pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000171",
        providerId: "jira",
        streamKey: "project-issues",
        lastAttemptAt: null,
        lastSuccessAt: null,
        result,
        pagesCommitted: 0
      })
      await act(async () =>
        root?.render(
          <ConnectionSynchronization
            canSynchronize
            onRefresh={vi.fn()}
            onSynchronize={onSynchronize}
            state={{ _tag: "ready", synchronization }}
          />
        )
      )
      const button = host.querySelector<HTMLButtonElement>("button")
      expect(button).not.toBeNull()
      expect(button?.disabled).toBe(result === "queued" || result === "running")
      if (result === "queued") expect(host.textContent).toContain("First sync queued")
      if (result === "running") expect(host.textContent).toContain("Syncing")
      await act(async () => button?.click())
      expect(onSynchronize).toHaveBeenCalledTimes(result === "queued" || result === "running" ? 0 : 1)
    })
  }
})
