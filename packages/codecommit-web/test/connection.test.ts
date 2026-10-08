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
      retryAt: 5_000,
      serverUp: false
    })
    expect(connectionAfterProbe({ _tag: "Status", status: 503 }, 5_000)).toEqual({
      _tag: "Failed",
      cause: "The CodeCommit server answered 503.",
      retryAt: 5_000,
      serverUp: false
    })
    expect(connectionAfterProbe({ _tag: "Status", status: 200 }, null)).toEqual({
      _tag: "Failed",
      cause: "The live update stream closed.",
      retryAt: null,
      serverUp: true
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
    expect(connectionLabel({ _tag: "Failed", cause: "x", retryAt: 1, serverUp: false })).toBe("Reconnecting")
    expect(connectionLabel({ _tag: "Failed", cause: "x", retryAt: null, serverUp: false })).toBe("Disconnected")
    expect(connectionDetail({ _tag: "Failed", cause: "Down.", retryAt: null, serverUp: false })).toBe(
      "Down. Retries stopped."
    )
    expect(connectionDetail({ _tag: "Live" })).toBeNull()
  })
})

describe("empty queue cause", () => {
  const live: Parameters<typeof emptyQueueCause>[0]["connection"] = { _tag: "Live" }
  const cause = (input: Partial<Parameters<typeof emptyQueueCause>[0]>) =>
    emptyQueueCause({
      cachedPullRequests: 0,
      connection: live,
      detectedAccounts: 0,
      enabledAccounts: 0,
      snapshotSeen: true,
      ...input
    })

  it("knows only the connection before the first snapshot, never 'no accounts'", () => {
    expect(cause({ connection: { _tag: "Unauthenticated", detail: null }, snapshotSeen: false })._tag).toBe(
      "Unauthenticated"
    )
    expect(cause({ snapshotSeen: false })._tag).toBe("Connecting")
  })

  it("keeps a lost or refused stream in front of the last snapshot's empty result", () => {
    expect(cause({ connection: { _tag: "Failed", cause: "Down.", retryAt: 1, serverUp: false }, enabledAccounts: 2 }))
      .toEqual({ _tag: "Failed", cause: "Down.", retrying: true })
    expect(
      cause({ connection: { _tag: "Failed", cause: "Closed.", retryAt: null, serverUp: true }, enabledAccounts: 2 })
        ._tag
    ).toBe("Failed")
    expect(cause({ cachedPullRequests: 3, connection: { _tag: "Unauthenticated", detail: null } })._tag).toBe(
      "Unauthenticated"
    )
    // Reconnecting to a server that still answers keeps explaining what the snapshot showed.
    expect(cause({ connection: { _tag: "Connecting" }, enabledAccounts: 2 })._tag).toBe("NothingOpen")
    expect(cause({ connection: { _tag: "Failed", cause: "Closed.", retryAt: 1, serverUp: true } })._tag).toBe(
      "NoAccounts"
    )
  })

  it("tells no profiles apart from profiles that are all switched off", () => {
    expect(cause({})).toEqual({ _tag: "NoAccounts" })
    expect(cause({ detectedAccounts: 3 })).toEqual({ _tag: "NoneSwitchedOn", detected: 3 })
  })

  it("sends an empty view to its filters, and otherwise says nothing is open", () => {
    expect(cause({ cachedPullRequests: 3, detectedAccounts: 1, enabledAccounts: 1 })).toEqual({
      _tag: "Filtered",
      cached: 3
    })
    expect(cause({ detectedAccounts: 2, enabledAccounts: 2 })).toEqual({ _tag: "NothingOpen", accounts: 2 })
  })
})
