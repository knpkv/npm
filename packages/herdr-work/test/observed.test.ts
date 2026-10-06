import { describe, expect, it } from "@effect/vitest"
import { fleetResponseBodyMaxBytes } from "@knpkv/herdr-fleet"
import type {
  WorkAgentObservation,
  WorkGoal,
  WorkObservedFact,
  WorkObservedFailure,
  WorkPullRequestObservation
} from "../src/model.js"
import { observationSubject, observeGoal, staleOwnerAfterMillis, workSnapshotBudgetBytes } from "../src/observed.js"

const hour = 60 * 60 * 1_000
const head = "a".repeat(40)

const goal = (overrides: Partial<WorkGoal> = {}): WorkGoal => ({
  blocker: null,
  connectTarget: { agentId: "agent-owner", host: "SER8", url: "/connect/?agent=agent-owner&host=SER8" },
  agentHierarchy: { agent: { agentId: "agent-owner", host: "SER8", name: "Owner", paneId: "w1:p1" } },
  createdAt: 0,
  delivery: "pull_request",
  detail: "Durable review checkpoint",
  id: "goal-pr",
  owner: { id: "owner", name: "Owner" },
  repository: { branch: "feat/x", repository: "knpkv/npm" },
  review: { state: "requested", summary: null, updatedAt: 10, url: "https://github.com/knpkv/npm/pull/7" },
  spend: null,
  state: "review",
  summary: "Ship x",
  title: "Ship x",
  updatedAt: 10,
  ...overrides
})

const pullRequest = (overrides: Partial<WorkPullRequestObservation> = {}): WorkPullRequestObservation => ({
  _tag: "pull_request",
  branch: "feat/x",
  checks: "passing",
  closedAt: null,
  head,
  pullRequest: 7,
  repository: "knpkv/npm",
  review: "requested",
  state: "open",
  ...overrides
})

const agent = (
  status: WorkAgentObservation["status"],
  overrides: Partial<WorkAgentObservation> = {}
): WorkAgentObservation => ({
  _tag: "agent",
  agentId: "agent-owner",
  host: "ser8",
  status,
  ...overrides
})

const fact = (observation: WorkObservedFact["observation"], observedAt: number): WorkObservedFact => ({
  confirmedAt: observedAt,
  observation,
  observationId: "0".repeat(64),
  observedAt,
  subject: observationSubject(observation)
})

describe("observeGoal", () => {
  it("keeps the recorded state when nothing was observed", () => {
    expect(observeGoal(goal(), [], [], 100)).toEqual({
      agent: null,
      displayState: "review",
      pullRequest: null,
      stale: false,
      unknown: null
    })
  })

  it("shows a merged pull request as completed before any checkpoint records it", () => {
    const merged = pullRequest({ closedAt: 50, state: "merged" })
    const observed = observeGoal(goal(), [fact(merged, 60)], [], 100)
    expect(observed.displayState).toBe("completed")
    expect(observed.pullRequest).toEqual({ confirmedAt: 60, fact: merged, observedAt: 60 })
  })

  it("shows a pull request closed without merging as abandoned", () => {
    expect(observeGoal(goal(), [fact(pullRequest({ closedAt: 50, state: "closed" }), 60)], [], 100).displayState)
      .toBe("abandoned")
  })

  it("never shows a recorded terminal goal as open again", () => {
    const completed = goal({ delivery: "merged", state: "completed" })
    expect(observeGoal(completed, [fact(pullRequest(), 60), fact(agent("working"), 60)], [], 100).displayState)
      .toBe("completed")
  })

  it("keeps the owner's blocker over an agent that reports working", () => {
    const blocked = goal({ blocker: { since: 10, summary: "Waiting on review" }, state: "blocked" })
    expect(observeGoal(blocked, [fact(agent("working"), 60)], [], 100).displayState).toBe("blocked")
  })

  it("shows the agent's working or blocked status over the pull request's review state", () => {
    expect(observeGoal(goal(), [fact(pullRequest(), 60), fact(agent("working"), 60)], [], 100).displayState)
      .toBe("working")
    expect(observeGoal(goal(), [fact(agent("blocked"), 60)], [], 100).displayState).toBe("blocked")
  })

  it("does not change the display state for a settled agent", () => {
    expect(observeGoal(goal({ state: "working" }), [fact(agent("idle"), 60)], [], 100).displayState).toBe("working")
  })

  it("shows an open pull request as review", () => {
    expect(observeGoal(goal({ state: "working" }), [fact(pullRequest(), 60)], [], 100).displayState).toBe("review")
  })

  it("flags an owner gone for more than a day on unfinished work, and only then", () => {
    const gone = [fact(agent("gone"), 1_000)]
    expect(observeGoal(goal(), gone, [], 1_000 + staleOwnerAfterMillis).stale).toBe(false)
    expect(observeGoal(goal(), gone, [], 1_000 + staleOwnerAfterMillis + 1).stale).toBe(true)
    expect(observeGoal(goal({ delivery: "merged", state: "completed" }), gone, [], 1_000 + 48 * hour).stale).toBe(false)
  })

  it("ignores facts about other pull requests and other agents", () => {
    const facts = [
      fact(pullRequest({ closedAt: 50, pullRequest: 8, state: "merged" }), 60),
      fact(agent("working", { agentId: "agent-other" }), 60),
      fact(agent("working", { host: "pi5" }), 60)
    ]
    expect(observeGoal(goal(), facts, [], 100)).toEqual({
      agent: null,
      displayState: "review",
      pullRequest: null,
      stale: false,
      unknown: null
    })
  })

  it("matches the agent's host case-insensitively", () => {
    expect(observeGoal(goal(), [fact(agent("working", { host: "Ser8" }), 60)], [], 100).agent?.fact.status).toBe(
      "working"
    )
  })

  it("reports the oldest current read failure among the goal's own subjects, with its last good read", () => {
    const failure = (subject: string, since: number): WorkObservedFailure => ({
      lastAt: since,
      reason: "gh: rate limited",
      since,
      source: subject.startsWith("github:") ? "github" : "herdr",
      subject
    })
    const facts = [{ ...fact(pullRequest(), 60), confirmedAt: 90 }]
    const failures = [failure("github:knpkv/npm#7", 120), failure("herdr:ser8/agent-owner", 110)]
    expect(observeGoal(goal(), facts, failures, 200).unknown).toEqual({
      lastGoodAt: null,
      reason: "gh: rate limited",
      since: 110,
      source: "herdr"
    })
    expect(observeGoal(goal(), facts, failures.slice(0, 1), 200).unknown).toEqual({
      lastGoodAt: 90,
      reason: "gh: rate limited",
      since: 120,
      source: "github"
    })
    expect(observeGoal(goal({ review: null }), facts, failures.slice(0, 1), 200).unknown).toBeNull()
    expect(observeGoal(goal(), facts, [failure("github:knpkv/npm#8", 120)], 200).unknown).toBeNull()
  })

  it("matches agent facts through the connect target of an older goal without an agent hierarchy", () => {
    const older = goal({
      agentHierarchy: undefined,
      connectTarget: { agentId: "agent-owner", host: "SER8", url: "/connect/?agent=agent-owner&host=SER8" }
    })
    expect(observeGoal(older, [fact(agent("working"), 60)], [], 100).agent?.fact.status).toBe("working")
    expect(observeGoal(older, [fact(agent("working", { agentId: "agent-other" }), 60)], [], 100).agent).toBeNull()
  })

  it("leaves room for the newline the HTTP route appends after the snapshot", () => {
    expect(workSnapshotBudgetBytes + "\n".length).toBe(fleetResponseBodyMaxBytes)
  })
})
