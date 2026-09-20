import { describe, expect, it } from "@effect/vitest"
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { JiraApiClient } from "@knpkv/jira-api-client"
import { Deferred, Effect, Fiber, Layer, Result } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ReconcileService } from "../src/services/ReconcileService.js"
import { layer as savedLayer, type RecordedEntry, SavedEntries } from "../src/services/SavedEntries.js"
import { FAKE_HOME, makeFakeHeadless } from "../src/testing/fakeHeadless.js"

// @effect-diagnostics strictEffectProvide:off
// @effect-diagnostics multipleEffectProvide:off

const startMs = new Date("2026-06-23T10:00:00Z").getTime()
const endMs = startMs + 3_661_000
const interval = { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() }
const period = { from: new Date("2026-06-22T00:00:00Z"), to: new Date("2026-06-26T00:00:00Z") }
const clockifyEntry: RecordedEntry = {
  id: "existing-0",
  source: "clockify",
  ticketKey: null,
  startMs,
  endMs,
  description: "  Meeting\nnotes  "
}
const jiraEntry: RecordedEntry = {
  id: "wl-0",
  source: "jira",
  ticketKey: "PROJ-1",
  startMs,
  endMs,
  description: "Hello world\n  Next line  "
}
const comment = {
  type: "doc",
  version: 1,
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Hello " }, { type: "text", text: "world", marks: [{ type: "strong" }] }]
    },
    { type: "paragraph", content: [{ type: "text", text: "  Next line  " }] }
  ]
}

describe("saved entries", () => {
  it.effect("refuses malformed Jira ADF before any provider update", () => {
    const fake = makeFakeHeadless({
      jiraWorklogs: {
        "PROJ-1": [{
          started: interval.start,
          timeSpentSeconds: 3661,
          comment: { type: "doc", content: [{ type: "text", text: 123 }] }
        }]
      }
    })
    return Effect.gen(function*() {
      const saved = yield* SavedEntries
      const result = yield* saved.update({ expected: jiraEntry, startMs, endMs, description: "changed" }).pipe(
        Effect.result
      )
      expect(Result.isFailure(result) && result.failure.reason).toBe("provider")
      expect(fake.world.updatedJiraWorklogs).toEqual([])
      expect(fake.world.updatedClockifyEntries).toEqual([])
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("reads ADF mention and emoji labels with exact whitespace and preserves raw ADF on time-only edits", () => {
    const richComment = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "  Discussed " },
            { type: "text", text: "with ", marks: [{ type: "strong" }] },
            { type: "mention", attrs: { id: "account", text: "@Andrey" } },
            { type: "emoji", attrs: { shortName: ":thumbsup:", text: "👍" } },
            { type: "hardBreak" },
            { type: "emoji", attrs: { id: "custom", shortName: ":shipit:" } },
            { type: "text", text: "  " }
          ]
        },
        { type: "paragraph", content: [] },
        { type: "paragraph", content: [{ type: "text", text: "  Done  " }] },
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: "unlabelled" } }, { type: "emoji", attrs: { id: "unlabelled" } }]
        }
      ]
    }
    const description = "  Discussed with @Andrey👍\n:shipit:  \n\n  Done  \n[mention][emoji]"
    const fake = makeFakeHeadless({
      jiraWorklogs: {
        "PROJ-1": [{
          started: interval.start,
          timeSpentSeconds: 3661,
          comment: richComment
        }]
      }
    })
    return Effect.gen(function*() {
      const reconcile = yield* ReconcileService
      const rows = yield* reconcile.compare(period, { sides: { jira: true, clockify: false } })
      expect(rows[0]?.intervals[0]?.entry?.description).toBe(description)
      const saved = yield* SavedEntries
      const actual = yield* saved.update({
        expected: { ...jiraEntry, description },
        startMs,
        endMs: endMs + 1000,
        description
      })
      expect(actual.description).toBe(description)
      expect(fake.world.updatedJiraWorklogs[0]?.payload).not.toHaveProperty("comment")
      const jira = yield* JiraApiClient
      expect((yield* jira.getWorklog("PROJ-1", "wl-0", undefined)).comment).toEqual(richComment)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("retains separate keyed and unlinked session windows through refresh", () => {
    const cwd = `${FAKE_HOME}/dev/work`
    const transcript = (sessionId: string, gitBranch: string | null, atMs: number) =>
      JSON.stringify({
        type: "user",
        sessionId,
        cwd,
        gitBranch,
        timestamp: new Date(atMs).toISOString(),
        message: { role: "user", content: "Implemented validation" }
      })
    const fake = makeFakeHeadless({
      config: { sessionRoots: [cwd] },
      transcripts: {
        "project/keyed.jsonl": transcript("keyed", "feat/PROJ-1", startMs),
        "project/unkeyed.jsonl": transcript("unkeyed", null, endMs)
      }
    })
    return Effect.gen(function*() {
      yield* TestClock.setTime(period.to.getTime())
      const reconcile = yield* ReconcileService
      const report = yield* reconcile.proposeFromSessions(period, { attribution: "deterministic" })
      expect(report.sessionEvidence).toEqual([
        { sessionId: "keyed", ticketKey: "PROJ-1", spans: [{ startMs, endMs: startMs + 300_000 }] },
        { sessionId: "unkeyed", ticketKey: null, spans: [{ startMs: endMs, endMs: endMs + 300_000 }] }
      ])
      expect((yield* reconcile.refreshRecordedTime(period, report)).sessionEvidence).toEqual(report.sessionEvidence)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("retains entire keyed and unkeyed Clockify entries across midnight slices, and exact Jira ADF text", () => {
    const start = "2026-06-23T23:30:00-04:00"
    const end = "2026-06-24T00:30:00-04:00"
    const fake = makeFakeHeadless({
      clockifyEntries: [{ start, end, description: "[PROJ-1]  exact\ntext  " }, { start, end, description: "unkeyed" }],
      jiraWorklogs: { "PROJ-1": [{ started: interval.start, timeSpentSeconds: 3661, comment }] }
    })
    return Effect.gen(function*() {
      const reconcile = yield* ReconcileService
      const report = yield* reconcile.proposeFromSessions(period, { attribution: "deterministic" })
      const keyed = report.recorded.flatMap((row) => row.intervals).filter((entry) => entry.source === "clockify")
      expect(keyed).toHaveLength(2)
      expect(keyed[0]?.entry).toEqual(keyed[1]?.entry)
      expect(keyed[0]?.entry).toMatchObject({
        startMs: new Date(start).getTime(),
        endMs: new Date(end).getTime(),
        description: "[PROJ-1]  exact\ntext  "
      })
      expect(report.unlinkedClockify).toHaveLength(2)
      expect(report.unlinkedClockify[0]?.entry).toEqual(report.unlinkedClockify[1]?.entry)
      expect(report.recorded.flatMap((row) => row.intervals).find((entry) => entry.source === "jira")?.entry).toEqual(
        jiraEntry
      )
      const refreshed = yield* reconcile.refreshRecordedTime(period, report)
      expect(refreshed.unlinkedClockify[0]?.entry).toEqual(report.unlinkedClockify[0]?.entry)
      expect(refreshed.sessionEvidence).toEqual(report.sessionEvidence)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("updates only unkeyed Clockify, preserving project/task/tags/billable and seconds", () => {
    const fake = makeFakeHeadless({
      clockifyEntries: [{
        ...interval,
        description: clockifyEntry.description ?? "",
        projectId: "project",
        taskId: "task",
        tagIds: ["tag"],
        billable: false
      }]
    })
    return Effect.gen(function*() {
      const saved = yield* SavedEntries
      const result = yield* saved.update({
        expected: clockifyEntry,
        startMs,
        endMs: endMs + 1000,
        description: "  changed\nexact  "
      })
      expect(result).toEqual({ ...clockifyEntry, endMs: endMs + 1000, description: "  changed\nexact  " })
      expect(fake.world.updatedClockifyEntries[0]?.payload).toMatchObject({
        projectId: "project",
        taskId: "task",
        tagIds: ["tag"],
        billable: false
      })
      expect(fake.world.createdClockifyEntries).toEqual([])
      expect(fake.world.updatedJiraWorklogs).toEqual([])
      const stale = yield* saved.update({ expected: clockifyEntry, startMs, endMs, description: "stale" }).pipe(
        Effect.result
      )
      expect(Result.isFailure(stale) && stale.failure.reason).toBe("conflict")
      expect(fake.world.updatedClockifyEntries).toHaveLength(1)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("updates Jira seconds without replacing long ADF, visibility or estimates; never creates", () => {
    const description = "long ".repeat(2000)
    const fake = makeFakeHeadless({
      jiraWorklogs: {
        "PROJ-1": [{
          started: interval.start,
          timeSpentSeconds: 3661,
          comment: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: description }] }]
          },
          visibility: { type: "group", value: "team" }
        }]
      }
    })
    return Effect.gen(function*() {
      const saved = yield* SavedEntries
      const result = yield* saved.update({
        expected: { ...jiraEntry, description },
        startMs,
        endMs: endMs + 2000,
        description
      })
      expect(result).toEqual({ ...jiraEntry, description, endMs: endMs + 2000 })
      expect(fake.world.updatedJiraWorklogs[0]).toMatchObject({
        adjustEstimate: "leave",
        payload: { timeSpentSeconds: 3663 }
      })
      expect(fake.world.updatedJiraWorklogs[0]?.payload).not.toHaveProperty("comment")
      expect(fake.world.updatedJiraWorklogs[0]?.payload).not.toHaveProperty("visibility")
      expect(fake.world.jiraWorklogs).toEqual([])
      expect(fake.world.updatedClockifyEntries).toEqual([])
      const result2 = yield* saved.update({
        expected: result,
        startMs,
        endMs: result.endMs,
        description: "new\n  exact  "
      })
      expect(result2.description).toBe("new\n  exact  ")
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("refuses another owner, running and deleted entries without writes", () => {
    const fake = makeFakeHeadless({
      clockifyEntries: [
        { ...interval, description: clockifyEntry.description ?? "", userId: "someone-else" },
        { start: interval.start, description: "running" }
      ],
      jiraWorklogs: {
        "PROJ-1": [{ started: interval.start, timeSpentSeconds: 3661, author: { accountId: "someone-else" } }]
      }
    })
    return Effect.gen(function*() {
      const saved = yield* SavedEntries
      for (
        const expected of [
          clockifyEntry,
          { ...clockifyEntry, id: "existing-1" },
          { ...clockifyEntry, id: "deleted" },
          jiraEntry,
          { ...jiraEntry, id: "deleted" }
        ]
      ) {
        const result = yield* saved.update({ expected, startMs, endMs, description: "changed" }).pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure.reason).toBe("conflict")
      }
      expect(fake.world.updatedClockifyEntries).toEqual([])
      expect(fake.world.updatedJiraWorklogs).toEqual([])
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("rejects invalid times and Jira sub-minute changes, while allowing description-only legacy short entries", () => {
    const fake = makeFakeHeadless({ jiraWorklogs: { "PROJ-1": [{ started: interval.start, timeSpentSeconds: 30 }] } })
    return Effect.gen(function*() {
      const saved = yield* SavedEntries
      for (const end of [startMs, startMs + 59_000, startMs + 60_001, Number.NaN]) {
        const result = yield* saved.update({ expected: jiraEntry, startMs, endMs: end, description: "x" }).pipe(
          Effect.result
        )
        expect(Result.isFailure(result) && result.failure.reason).toBe("validation")
      }
      const short = { ...jiraEntry, endMs: startMs + 30_000, description: null }
      expect((yield* saved.update({ expected: short, startMs, endMs: short.endMs, description: "note" })).endMs).toBe(
        short.endMs
      )
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("holds the permit across read and update so simultaneous stale writes cannot both save", () => {
    const fake = makeFakeHeadless({ clockifyEntries: [{ ...interval, description: clockifyEntry.description ?? "" }] })
    return Effect.gen(function*() {
      const original = yield* ClockifyApiClient
      const reachedUpdate = yield* Deferred.make<void>()
      const releaseUpdate = yield* Deferred.make<void>()
      const client = ClockifyApiClient.of({
        ...original,
        updateTimeEntry: (...args) =>
          Effect.gen(function*() {
            yield* Deferred.succeed(reachedUpdate, undefined)
            yield* Deferred.await(releaseUpdate)
            return yield* original.updateTimeEntry(...args)
          })
      })
      yield* Effect.gen(function*() {
        const saved = yield* SavedEntries
        const input = { expected: clockifyEntry, startMs, endMs, description: "first" }
        const first = yield* saved.update(input).pipe(Effect.forkChild)
        yield* Deferred.await(reachedUpdate)
        const second = yield* saved.update({ ...input, description: "second" }).pipe(Effect.result, Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(releaseUpdate, undefined)
        yield* Fiber.join(first)
        const result = yield* Fiber.join(second)
        expect(Result.isFailure(result) && result.failure.reason).toBe("conflict")
        expect(fake.world.updatedClockifyEntries).toHaveLength(1)
      }).pipe(Effect.provide(savedLayer.pipe(Layer.provide(Layer.succeed(ClockifyApiClient, client)), Layer.fresh)))
    }).pipe(Effect.provide(fake.layer))
  })
})
