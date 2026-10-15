import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { classifyAgentTask } from "@knpkv/herdr-fleet"
import {
  makeWorkService,
  type WorkObservedChecks,
  WorkPullRequestObservation,
  type WorkReviewState,
  WorkStore
} from "@knpkv/herdr-work"
import { Effect, FileSystem, Path, Schema } from "effect"
import { TestClock } from "effect/testing"
import { branchTaskFacts, decodeTaskBranchTarget, type TaskWorkObservation } from "../src/internal/agent-task-work.js"

const observed = (
  checks: WorkObservedChecks,
  review: WorkReviewState,
  branch = "feat/fixture"
): TaskWorkObservation => ({
  stale: false,
  unknown: null,
  pullRequest: {
    observedAt: 1,
    confirmedAt: 1,
    fact: Schema.decodeUnknownSync(WorkPullRequestObservation)({
      _tag: "pull_request",
      repository: "fixture/project",
      pullRequest: 12,
      state: "open",
      branch,
      head: "a".repeat(40),
      review,
      checks,
      closedAt: null
    })
  }
})
const target = { repository: "fixture/project", branch: "feat/fixture" }

const facts = (observations: ReadonlyArray<TaskWorkObservation>, target: { repository: string; branch: string }) =>
  branchTaskFacts({ observed: observations }, target, 10)

describe("existing branch PR task evidence", () => {
  it.each([
    ["pending", "not_requested", "waiting"],
    ["failing", "approved", "failing"],
    ["passing", "requested", "waiting"],
    ["passing", "approved", "idle"],
    ["none", "changes_requested", "idle"]
  ])("CI %s and review %s", (checks, review, expected) => {
    const row = observed(
      Schema.decodeUnknownSync(WorkPullRequestObservation.fields.checks)(checks),
      Schema.decodeUnknownSync(WorkPullRequestObservation.fields.review)(review)
    )
    expect(classifyAgentTask({ status: "idle", ...facts([row], target) })).toBe(expected)
  })

  it("requires exact branch/repository identity and ignores stale or failed observations", () => {
    const row = observed("failing", "requested")
    const unknown = { ci: "unknown", review: "unknown" }
    expect(facts([row], { repository: "other/project", branch: target.branch })).toEqual(unknown)
    expect(facts([row], { repository: target.repository, branch: "other-branch" })).toEqual(unknown)
    expect(facts([{ ...row, stale: true }], target)).toEqual(unknown)
    expect(
      facts(
        [{ ...row, unknown: { source: "github", reason: "unavailable", since: 2, lastGoodAt: 1 } }],
        target
      )
    ).toEqual(unknown)
    expect(facts([row], { ...target, repository: "FIXTURE/PROJECT" })).toEqual({
      ci: "failed",
      review: "pending"
    })
  })

  it("does not guess between two open PRs on the same branch, but deduplicates the same PR", () => {
    const first = observed("failing", "requested")
    const second = observed("pending", "approved")
    const other = second.pullRequest === null
      ? second
      : { ...second, pullRequest: { ...second.pullRequest, fact: { ...second.pullRequest.fact, pullRequest: 13 } } }
    expect(facts([first, other], target)).toEqual({ ci: "unknown", review: "unknown" })
    expect(facts([first, first], target)).toEqual({ ci: "failed", review: "pending" })
  })
})

describe("host-private Git branch identity", () => {
  it.each([
    "https://github.com/Fixture/Project.git",
    "git@github.com:Fixture/Project.git",
    "ssh://git@github.com/Fixture/Project"
  ])("normalizes supported origin %s", (origin) => {
    expect(decodeTaskBranchTarget(origin, "feat/fixture")).toEqual({
      repository: "fixture/project",
      branch: "feat/fixture"
    })
  })
  it.each([
    "/local/repo",
    "https://github.com.evil.example/fixture/project",
    "https://credential@github.com/fixture/project",
    "https://github.com/fixture/project/pull/1"
  ])("does not guess from unsupported origin %s", (origin) => {
    expect(decodeTaskBranchTarget(origin, "feat/fixture")).toBeUndefined()
  })
  it("rejects absent and malformed branch names", () => {
    expect(decodeTaskBranchTarget("https://github.com/fixture/project", "")).toBeUndefined()
    expect(decodeTaskBranchTarget("https://github.com/fixture/project", "branch\nother")).toBeUndefined()
  })
})

describe("lossy Work source health", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("rejects retained PR facts behind an older Herdr failure until both sources recover", () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "task-work-health-" })
        const store = yield* Effect.acquireRelease(
          WorkStore.open(path.join(root, "work.sqlite")),
          (store) => Effect.sync(() => store.close())
        )
        const work = yield* makeWorkService(store)
        yield* TestClock.setTime(10)
        yield* work.record({
          version: "herdr.work.event.v1",
          eventId: "fixture-created",
          occurredAt: 1,
          goal: {
            id: "fixture-goal",
            title: "Fixture delivery",
            summary: "fixture",
            detail: "fixture",
            state: "review",
            owner: { id: "fixture-owner", name: "Owner" },
            repository: target,
            spend: null,
            delivery: "pull_request",
            blocker: null,
            connectTarget: {
              host: "fixture-host",
              agentId: "agent-owner",
              url: "/connect/?agent=agent-owner&host=fixture-host"
            },
            review: {
              state: "requested",
              summary: null,
              updatedAt: 1,
              url: "https://github.com/fixture/project/pull/12"
            },
            createdAt: 1,
            updatedAt: 1
          }
        })
        const pullRequest = Schema.decodeUnknownSync(WorkPullRequestObservation)({
          _tag: "pull_request",
          ...target,
          pullRequest: 12,
          state: "open",
          head: "a".repeat(40),
          review: "requested",
          checks: "failing",
          closedAt: null
        })
        yield* work.observe([
          { observedAt: 2, observation: pullRequest },
          {
            observedAt: 2,
            observation: { _tag: "agent", host: "fixture-host", agentId: "agent-owner", status: "working" }
          }
        ])
        const healthy = (yield* work.snapshots(2)).now.observed ?? []
        expect(facts(healthy, target)).toEqual({ ci: "failed", review: "pending" })
        yield* work.observe([
          {
            observedAt: 3,
            observation: {
              _tag: "unknown",
              source: "herdr",
              subject: "herdr:fixture-host/agent-owner",
              reason: "unavailable"
            }
          },
          {
            observedAt: 4,
            observation: {
              _tag: "unknown",
              source: "github",
              subject: "github:fixture/project#12",
              reason: "unavailable"
            }
          }
        ])
        const failed = (yield* work.snapshots(4)).now.observed ?? []
        expect(failed).toHaveLength(1)
        expect(failed[0]?.unknown?.source).toBe("herdr")
        expect(failed[0]?.pullRequest?.fact.checks).toBe("failing")
        expect(failed[0]?.stale).toBe(false)
        expect(facts(failed, target)).toEqual({ ci: "unknown", review: "unknown" })
        yield* work.observe([{ observedAt: 5, observation: pullRequest }])
        // The display projection still cannot prove which other sources have recovered.
        expect(facts((yield* work.snapshots(5)).now.observed ?? [], target))
          .toEqual({ ci: "unknown", review: "unknown" })
        yield* work.observe([{
          observedAt: 6,
          observation: { _tag: "agent", host: "fixture-host", agentId: "agent-owner", status: "working" }
        }])
        const recovered = (yield* work.snapshots(6)).now.observed ?? []
        expect(recovered[0]?.unknown).toBeNull()
        expect(facts(recovered, target)).toEqual({ ci: "failed", review: "pending" })
        // Five minutes is the producer's maximum evidence age, independent of Work's owner-stale flag.
        yield* TestClock.setTime(300_005)
        expect(branchTaskFacts((yield* work.snapshots()).now, target, 300_005))
          .toEqual({ ci: "failed", review: "pending" })
        yield* TestClock.setTime(300_006)
        const expired = (yield* work.snapshots()).now
        expect(expired.observed?.[0]?.stale).toBe(false)
        expect(branchTaskFacts(expired, target, 300_006)).toEqual({ ci: "unknown", review: "unknown" })
        const thirtyDays = 30 * 24 * 60 * 60 * 1000
        yield* TestClock.setTime(thirtyDays)
        expect(branchTaskFacts((yield* work.snapshots()).now, target, thirtyDays))
          .toEqual({ ci: "unknown", review: "unknown" })
        yield* work.observe([{ observedAt: thirtyDays, observation: pullRequest }])
        const reconfirmed = (yield* work.snapshots()).now
        expect(reconfirmed.observed?.[0]?.pullRequest?.observedAt).toBe(2)
        expect(reconfirmed.observed?.[0]?.pullRequest?.confirmedAt).toBe(thirtyDays)
        expect(branchTaskFacts(reconfirmed, target, thirtyDays)).toEqual({ ci: "failed", review: "pending" })
      }).pipe(Effect.scoped))
  })
})
