// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PluginSynchronizationState } from "../../src/api/plugins.js"
import { ConnectionSynchronization } from "../../src/client/services/ConnectionSynchronization.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let root: Root | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe("ConnectionSynchronization", () => {
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
