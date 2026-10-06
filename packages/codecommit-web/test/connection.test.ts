import { describe, expect, it } from "@effect/vitest"
import {
  connectionAfterProbe,
  connectionDetail,
  connectionLabel,
  emptyQueueCause,
  retryDelayMs
} from "../src/client/connection.js"

describe("stream connection", () => {
  it("treats a refused session as not signed in, which retrying can't fix", () => {
    expect(connectionAfterProbe({ _tag: "Status", status: 401 }, 5_000)).toEqual({
      _tag: "Unauthenticated",
      detail: null
    })
    expect(connectionAfterProbe({ _tag: "Status", status: 403 }, 5_000)._tag).toBe("Unauthenticated")
  })

  it("names what broke for any other failure and keeps the next try", () => {
    expect(connectionAfterProbe({ _tag: "Unreachable" }, 5_000)).toEqual({
      _tag: "Failed",
      cause: "The CodeCommit server isn't reachable.",
      retryAt: 5_000
    })
    expect(connectionAfterProbe({ _tag: "Status", status: 503 }, 5_000)).toEqual({
      _tag: "Failed",
      cause: "The CodeCommit server answered 503.",
      retryAt: 5_000
    })
    expect(connectionAfterProbe({ _tag: "Status", status: 200 }, null)).toEqual({
      _tag: "Failed",
      cause: "The live update stream closed.",
      retryAt: null
    })
  })

  it("backs off 1s, 2s, 4s up to 30s", () => {
    expect([0, 1, 2, 5, 10].map(retryDelayMs)).toEqual([1_000, 2_000, 4_000, 30_000, 30_000])
  })

  it("labels each state and says how to recover", () => {
    expect(connectionLabel({ _tag: "Unauthenticated", detail: null })).toBe("Not signed in")
    expect(connectionDetail({ _tag: "Unauthenticated", detail: null })).toBe(
      "Run codecommit web again and open the link it prints; each link works once, within 60 seconds."
    )
    expect(connectionLabel({ _tag: "Failed", cause: "x", retryAt: 1 })).toBe("Reconnecting")
    expect(connectionLabel({ _tag: "Failed", cause: "x", retryAt: null })).toBe("Disconnected")
    expect(connectionDetail({ _tag: "Failed", cause: "Down.", retryAt: null })).toBe("Down. Retries stopped.")
    expect(connectionDetail({ _tag: "Live" })).toBeNull()
  })
})

describe("empty queue cause", () => {
  const live: Parameters<typeof emptyQueueCause>[0]["connection"] = { _tag: "Live" }

  it("knows only the connection before the first snapshot, never 'no accounts'", () => {
    expect(
      emptyQueueCause({
        cachedPullRequests: 0,
        connection: { _tag: "Unauthenticated", detail: null },
        enabledAccounts: 0,
        snapshotSeen: false
      })._tag
    ).toBe("Unauthenticated")
    expect(
      emptyQueueCause({ cachedPullRequests: 0, connection: live, enabledAccounts: 0, snapshotSeen: false })._tag
    ).toBe("Connecting")
  })

  it("sends a first run with no accounts to setup, and an empty view to its filters", () => {
    expect(emptyQueueCause({ cachedPullRequests: 0, connection: live, enabledAccounts: 0, snapshotSeen: true }))
      .toEqual({
        _tag: "NoAccounts"
      })
    expect(emptyQueueCause({ cachedPullRequests: 3, connection: live, enabledAccounts: 1, snapshotSeen: true }))
      .toEqual({
        _tag: "Filtered",
        cached: 3
      })
    expect(emptyQueueCause({ cachedPullRequests: 0, connection: live, enabledAccounts: 2, snapshotSeen: true }))
      .toEqual({
        _tag: "NothingOpen",
        accounts: 2
      })
  })
})
