import { describe, expect, it } from "@effect/vitest"
import type { JobRecord } from "@knpkv/herdr-fleet/model"
import { Exit } from "effect"
import type { FleetPendingApprovals } from "../src/dashboard-model.js"
import {
  dashboardHistoryState,
  dashboardPendingBadgeCount,
  dashboardPendingState,
  loadDashboardPendingPage,
  mergeDashboardHistoryPage,
  mergeDashboardPendingPage,
  rotateFailedDashboardPendingPage
} from "../src/internal/dashboard-pending-state.js"

const record = (id: string): JobRecord => ({
  actor: "andrey@example.com",
  approvalNonce: `nonce-${id}`,
  approvedBy: null,
  createdAt: 1,
  error: null,
  hash: id.padStart(64, "0"),
  id,
  payload: { kind: "nix.check" },
  result: null,
  status: "pending_approval",
  updatedAt: 1
})

const cursor = (host: string, id: string) => ({
  host,
  cursor: { createdAt: 1, id }
})

const emptyPage = (
  nextCursors: FleetPendingApprovals["nextCursors"]
): FleetPendingApprovals => ({
  failures: [],
  local: [],
  nextCursors,
  remote: []
})

describe("dashboard pending continuation state", () => {
  it("ignores a stale history page after a refreshed generation wins", () => {
    const requested = { cursor: { createdAt: 1, id: "job-old" }, generation: 1 }
    const refreshed = dashboardHistoryState(2, [record("job-new")], {
      createdAt: 2,
      id: "job-refreshed-cursor"
    })

    expect(
      mergeDashboardHistoryPage(refreshed, requested, {
        nextCursor: { createdAt: 0, id: "job-old-cursor" },
        records: [record("job-stale")]
      })
    ).toEqual(refreshed)
  })

  it("does not claim an exact badge count while pending pages remain", () => {
    const partial = {
      ...emptyPage([cursor("ALPHA", "cursor-a")]),
      local: Array.from({ length: 8 }, (_, index) => record(`job-${String(index)}`))
    }

    expect(dashboardPendingBadgeCount(partial)).toBeNull()
    expect(dashboardPendingBadgeCount(emptyPage([]))).toBe(0)
  })

  it("ignores a stale page after a refreshed generation wins", () => {
    const requested = cursor("ALPHA", "cursor-a")
    const refreshed = dashboardPendingState(2, emptyPage([cursor("ALPHA", "cursor-b")]))
    const stalePage = { ...emptyPage([cursor("ALPHA", "cursor-a2")]), local: [record("job-a")] }

    expect(
      mergeDashboardPendingPage(refreshed, { continuation: requested, generation: 1 }, stalePage)
    ).toEqual(refreshed)
  })

  it("consumes the matching cursor once and retains its successor beside other hosts", () => {
    const requested = cursor("ALPHA", "cursor-a")
    const other = cursor("SER8", "cursor-ser8")
    const initial = dashboardPendingState(1, emptyPage([requested, other]))
    const page = { ...emptyPage([cursor("ALPHA", "cursor-a2")]), local: [record("job-a")] }
    const merged = mergeDashboardPendingPage(
      initial,
      { continuation: requested, generation: 1 },
      page
    )

    expect(merged.local.map(({ id }) => id)).toEqual(["job-a"])
    expect(merged.nextCursors).toEqual([cursor("ALPHA", "cursor-a2"), other])
    expect(
      mergeDashboardPendingPage(
        merged,
        { continuation: requested, generation: 1 },
        page
      )
    ).toEqual(merged)
  })

  it("keeps a failed host retryable without starving the next host", () => {
    const offline = cursor("OFFLINE", "cursor-offline")
    const healthy = cursor("SER8", "cursor-ser8")
    const initial = dashboardPendingState(1, emptyPage([offline, healthy]))

    const rotated = rotateFailedDashboardPendingPage(initial, {
      continuation: offline,
      generation: 1
    })

    expect(rotated.nextCursors).toEqual([healthy, offline])
    expect(
      rotateFailedDashboardPendingPage(rotated, {
        continuation: offline,
        generation: 0
      })
    ).toEqual(rotated)
  })

  it("loads the healthy host after a controlled failure through the client loader", async () => {
    const offline = cursor("OFFLINE", "cursor-offline")
    const healthy = cursor("SER8", "cursor-ser8")
    let state = dashboardPendingState(1, emptyPage([offline, healthy]))
    const requested: Array<typeof offline> = []
    const first = Promise.withResolvers<Exit.Exit<FleetPendingApprovals, string>>()
    const second = Promise.withResolvers<Exit.Exit<FleetPendingApprovals, string>>()
    const update = (transition: (current: typeof state) => typeof state): void => {
      state = transition(state)
    }
    const load = (continuation: typeof offline) => {
      requested.push(continuation)
      return requested.length === 1 ? first.promise : second.promise
    }

    const failedLoad = loadDashboardPendingPage(state, load, update)
    expect(requested).toEqual([offline])
    first.resolve(Exit.fail("offline"))
    expect((await failedLoad)._tag).toBe("Failure")

    const healthyLoad = loadDashboardPendingPage(state, load, update)
    expect(requested).toEqual([offline, healthy])
    second.resolve(
      Exit.succeed({
        ...emptyPage([]),
        remote: [{ approval: record("job-healthy"), approvalUrl: "https://ser8.example.test", host: "SER8" }]
      })
    )
    expect((await healthyLoad)._tag).toBe("Success")
    expect(state.remote.map(({ approval }) => approval.id)).toEqual(["job-healthy"])
    expect(state.nextCursors).toEqual([offline])
  })
})
