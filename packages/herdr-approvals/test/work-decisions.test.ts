import { describe, expect, it } from "@effect/vitest"
import { DecisionAnswer } from "../src/countdown-model.js"
import type { DecisionStatus } from "../src/countdown-view.js"
import type { DashboardSnapshot } from "../src/dashboard-model.js"
import { answerOutcome, decidableExpiry, workRequestDecisionsFor } from "../src/work-decisions.js"

type JobRecord = DashboardSnapshot["pendingApprovals"]["local"][number]

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
  payload: { kind: "work.admit", ref: "main" },
  rejectedAt: null,
  rejectedBy: null,
  result: null,
  status: "pending_approval",
  updatedAt: 1_000,
  ...overrides
})

const snapshot = (local: ReadonlyArray<JobRecord>, approvalsEnabled = true): DashboardSnapshot => ({
  approvalApp: {
    canonical: true,
    canonicalUrl: "https://hub.example.test/",
    chatEnabled: false,
    pushEnabled: false,
    workEnabled: false
  },
  approvalsEnabled,
  chat: null,
  directory: null,
  historyNextCursor: null,
  host: "ALPHA",
  observedAt: 0,
  pendingApprovals: { failures: [], local: [...local], remote: [] },
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

const status = (overrides: Partial<DecisionStatus> = {}): DecisionStatus => ({
  expiresAt: 600_000,
  jobId: "job-1",
  observedAt: 0,
  outcome: "accepted",
  settles: true,
  text: "The hub recorded your approval.",
  ...overrides
})

const decisionsFor = (local: ReadonlyArray<JobRecord>, answer: DecisionStatus | null) =>
  workRequestDecisionsFor({ now: 0, onDecision: () => {}, sending: null, snapshot: snapshot(local), status: answer })

describe("Work board decisions", () => {
  it("lists only jobs this host can decide now, with their expiry", () => {
    const listed = snapshot([record("job-1"), record("job-2", { approvalExpiresAt: null })])
    expect(decidableExpiry(listed, "job-1")).toBe(600_000)
    expect(decidableExpiry(listed, "job-2")).toBeNull()
    expect(decidableExpiry(listed, "job-3")).toBeUndefined()
    expect(decidableExpiry(snapshot([record("job-1", { approvalAvailable: false })]), "job-1")).toBeUndefined()
    expect(decidableExpiry(snapshot([record("job-1")], false), "job-1")).toBeUndefined()
  })

  it("names the hub's answer in the board's words", () => {
    expect(answerOutcome(DecisionAnswer.Accepted({ decision: "approve", record: record("job-1") }))).toBe("accepted")
    expect(answerOutcome(DecisionAnswer.Refused({ status: 409 }))).toBe("refused")
    expect(answerOutcome(DecisionAnswer.Uncertain({ status: null }))).toBe("uncertain")
    expect(answerOutcome(DecisionAnswer.Unreadable())).toBe("uncertain")
  })

  it("keeps the answer while its request is listed or gone, and drops it for a new request on the job", () => {
    const answered = status()
    // Still listed with the expiry it was decided at: the board shows the answer.
    expect(decisionsFor([record("job-1")], answered).answer).toEqual({
      jobId: "job-1",
      outcome: "accepted",
      text: "The hub recorded your approval."
    })
    // Left the queue: the answer stays, so the bar can say how it ended.
    expect(decisionsFor([], answered).answer?.outcome).toBe("accepted")
    // The same job asks again with a new expiry: a new request starts with a ready bar.
    expect(decisionsFor([record("job-1", { approvalExpiresAt: 900_000 })], answered).answer).toBeNull()
  })
})
