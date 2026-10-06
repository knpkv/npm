import { describe, expect, it } from "@effect/vitest"
import {
  answerForStatus,
  answerSettles,
  answerText,
  clockText,
  countdownText,
  crossedIntoLastMinute,
  DecisionAnswer,
  factsOf,
  pendingItems,
  tickInterval,
  urgencyOf,
  windowUsed
} from "../src/countdown-model.js"
import type { DashboardSnapshot } from "../src/dashboard-model.js"

type JobRecord = DashboardSnapshot["records"][number]

const record = (id: string, overrides: Partial<JobRecord> = {}): JobRecord => ({
  actor: "submitter@example.com",
  approvalAvailable: true,
  approvalExpiresAt: 600_000,
  approvalNonce: "nonce",
  approvedAt: null,
  approvedBy: null,
  createdAt: 1_000,
  error: null,
  expiredAt: null,
  hash: "hash",
  id,
  payload: { kind: "nix.apply", ref: "main" },
  rejectedAt: null,
  rejectedBy: null,
  result: null,
  status: "pending_approval",
  updatedAt: 1_000,
  ...overrides
})

const snapshot = (pending: DashboardSnapshot["pendingApprovals"]): DashboardSnapshot => ({
  approvalApp: { canonical: true, canonicalUrl: "https://hub.example.test/", chatEnabled: false, pushEnabled: false },
  approvalsEnabled: true,
  chat: null,
  directory: null,
  historyNextCursor: null,
  host: "ALPHA",
  observedAt: 0,
  pendingApprovals: pending,
  records: [],
  status: {
    applyConfigured: true,
    branch: "main",
    dirty: false,
    herdr: { agents: [], available: true, error: null },
    host: "ALPHA",
    repository: "/repo",
    revision: "abc"
  },
  work: null
})

describe("countdown model", () => {
  it("reads seconds only under five minutes and never goes negative", () => {
    expect(countdownText(52_000)).toBe("52s")
    expect(countdownText(4 * 60_000 + 12_000)).toBe("4m 12s")
    expect(countdownText(11 * 60_000 + 40_000)).toBe("11m")
    expect(countdownText(-5_000)).toBe("0s")
  })

  it("says expiring at zero instead of claiming the hub expired it", () => {
    expect(clockText(10_000, 10_000)).toBe("expiring")
    expect(clockText(70_000, 10_000)).toBe("1m 00s")
    expect(clockText(null, 10_000)).toBeNull()
  })

  it("grades urgency by the minute and the five minutes", () => {
    expect([10 * 60_000, 4 * 60_000, 30_000, 0].map(urgencyOf)).toEqual(["calm", "soon", "imminent", "due"])
  })

  it("orders local and remote requests by soonest expiry, those without one last", () => {
    const items = pendingItems(
      snapshot({
        failures: [],
        local: [record("late", { approvalExpiresAt: 900_000 }), record("open", { approvalExpiresAt: null })],
        nextCursors: [],
        remote: [
          {
            approval: {
              actor: "ops@example.com",
              approvalExpiresAt: 120_000,
              createdAt: 1_000,
              id: "soon",
              payload: { kind: "nix.check", ref: "main" },
              status: "pending_approval"
            },
            approvalUrl: "https://beta.example.test/approve/soon",
            host: "BETA"
          }
        ]
      })
    )
    expect(items.map((item) => [factsOf(item, "ALPHA").id, factsOf(item, "ALPHA").host])).toEqual([
      ["soon", "BETA"],
      ["late", "ALPHA"],
      ["open", "ALPHA"]
    ])
  })

  it("measures the used share of an approval window, near mark at five minutes left", () => {
    const used = windowUsed(0, 15 * 60_000, 5 * 60_000)
    expect(used?.near).toBeCloseTo(66.667, 2)
    expect(used?.value).toBeCloseTo(33.333, 2)
    expect(windowUsed(0, 15 * 60_000, 20 * 60_000)?.value).toBe(100)
    expect(windowUsed(0, 3 * 60_000, 0)?.near).toBe(0)
    expect(windowUsed(0, null, 0)).toBeNull()
    expect(windowUsed(10, 10, 0)).toBeNull()
  })

  it("ticks every second only while a clock shows seconds", () => {
    expect(tickInterval([10 * 60_000, null], 0)).toBe(15_000)
    expect(tickInterval([10 * 60_000, 4 * 60_000], 0)).toBe(1_000)
  })

  it("announces a request once, as it enters its last minute", () => {
    const facts = [
      { actor: "a", createdAt: 0, expiresAt: 100_000, host: "ALPHA", id: "one", kind: "nix.apply", title: "Apply" }
    ]
    expect(crossedIntoLastMinute(facts, 39_000, 41_000).map(({ id }) => id)).toEqual(["one"])
    expect(crossedIntoLastMinute(facts, 41_000, 42_000)).toEqual([])
    expect(crossedIntoLastMinute(facts, 30_000, 39_000)).toEqual([])
  })

  it("words the hub's answer by what it proves, never that nothing ran", () => {
    expect(answerText(DecisionAnswer.Refused({ status: 409 }))).toContain("approval session ended")
    expect(answerText(DecisionAnswer.Refused({ status: 409 }))).not.toContain("Nothing")
    expect(answerForStatus(409)._tag).toBe("Refused")
    expect(answerForStatus(503)._tag).toBe("Uncertain")
    expect(answerText(answerForStatus(503))).toContain("may have been recorded")
    expect(answerText(DecisionAnswer.Uncertain({ status: null }))).toContain("may not have arrived")
    expect(answerSettles(answerForStatus(503))).toBe(false)
    expect(answerSettles(answerForStatus(409))).toBe(true)
    expect(answerText(DecisionAnswer.Accepted({ decision: "approve", record: record("x", { status: "queued" }) })))
      .toBe("The hub recorded your approval; the job is queued.")
    expect(answerText(DecisionAnswer.Accepted({ decision: "reject", record: record("x", { status: "rejected" }) })))
      .toContain("Nothing will run")
  })
})
