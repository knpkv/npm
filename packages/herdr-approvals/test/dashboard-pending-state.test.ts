import { describe, expect, it } from "@effect/vitest"
import type { JobRecord } from "@knpkv/herdr-fleet/model"
import type { FleetPendingApprovals } from "../src/dashboard-model.js"
import { dashboardPendingState, mergeDashboardPendingPage } from "../src/internal/dashboard-pending-state.js"

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
})
