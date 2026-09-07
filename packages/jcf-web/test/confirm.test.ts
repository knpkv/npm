/**
 * Confirming a row, end to end through the engine's own fake world.
 *
 * These assert what was written, what was refused, and what the entries say — never how attribution
 * was implemented. Every one runs against the real `ReconcileService` over faked Clockify, Jira and
 * transcripts, so a passing test means the write path actually ran.
 */
import { describe, expect, it } from "@effect/vitest"
import { ReconcileService, Time } from "@knpkv/jira-clockify"
import { FAKE_HOME, type FakeHeadlessOptions, makeFakeHeadless } from "@knpkv/jira-clockify/testing.js"
import { Effect } from "effect"
import { confirmProposal, type ConfirmRequest, logManualEntry } from "../src/server/Confirm.js"
import { buildWeekPlan, type HeldPlan, rowId } from "../src/server/WeekPlan.js"

// Each case composes exactly the layer it needs and provides it at its own entry point.
// @effect-diagnostics strictEffectProvide:off

const WORK_ROOT = `${FAKE_HOME}/dev/work`
const TICKET = "PROJ-5662"
const OTHER_TICKET = "PROJ-9001"
const DAY = "2026-07-01"

/** Local components, so a day boundary is a local midnight wherever this suite runs. */
const at = (hour: number, minute: number): number => new Date(2026, 6, 1, hour, minute, 0, 0).getTime()

const iso = (atMs: number): string => new Date(atMs).toISOString()

/** A transcript whose branch names the ticket, with a prompt every minute for `minutes`. */
const transcript = (options: {
  readonly sessionId: string
  readonly branch: string
  readonly startMs: number
  readonly minutes: number
}): string =>
  Array.from({ length: options.minutes + 1 }, (_, index) =>
    JSON.stringify({
      cwd: `${WORK_ROOT}/repo`,
      gitBranch: options.branch,
      isSidechain: false,
      message: { content: "working", role: "user" },
      sessionId: options.sessionId,
      timestamp: iso(options.startMs + index * 60_000),
      type: "user",
      uuid: `${options.sessionId}-${index}`,
      version: "9.9.9"
    })).join("\n")

const baseOptions = (overrides: FakeHeadlessOptions = {}): FakeHeadlessOptions => ({
  ...overrides,
  config: { sessionRoots: [WORK_ROOT], ...overrides.config },
  transcripts: {
    "repo/session-a.jsonl": transcript({
      branch: `feature/${TICKET}-otel`,
      minutes: 60,
      sessionId: "session-a",
      startMs: at(10, 0)
    }),
    ...overrides.transcripts
  }
})

/** The plan the browser would have been looking at. */
const readPlan = Effect.gen(function*() {
  const reconcile = yield* ReconcileService.ReconcileService
  const period = Time.isoWeekPeriod(new Date(at(12, 0)))
  const report = yield* reconcile.proposeFromSessions(period)
  return buildWeekPlan({ createdAtMillis: 0, monday: period.from, planId: "plan-1", report })
})

/** No Jira lookup in these tests: a title is provenance, not behaviour. */
const noSummary = () => Effect.succeed(null)

const confirm = (plan: HeldPlan, request: Partial<ConfirmRequest> = {}) =>
  Effect.gen(function*() {
    const reconcile = yield* ReconcileService.ReconcileService
    return yield* confirmProposal({
      plan,
      request: {
        note: undefined,
        rowId: rowId(TICKET, DAY),
        seconds: undefined,
        ticketKey: undefined,
        ...request
      },
      service: reconcile,
      summaryOf: noSummary
    })
  })

const run = <A, E>(effect: Effect.Effect<A, E, ReconcileService.ReconcileService>, options: FakeHeadlessOptions) => {
  const fake = makeFakeHeadless(baseOptions(options))
  return effect.pipe(Effect.provide(fake.layer), Effect.map((value) => ({ value, world: fake.world })))
}

const rowFor = (plan: HeldPlan, ticketKey: string, day: string) =>
  plan.plan.rows.find((row) => row.rowId === rowId(ticketKey, day))

describe("confirming a proposed row", () => {
  it.effect("writes the credited time to both systems, once", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.gen(function*() {
          const plan = yield* readPlan
          const outcome = yield* confirm(plan)
          return { credited: rowFor(plan, TICKET, DAY)?.proposal?.maxSeconds, outcome }
        }),
        {}
      )
      const credited = value.credited
      expect(credited).toBeGreaterThan(0)
      expect(value.outcome._tag).toBe("Written")
      expect(world.createdClockifyEntries).toHaveLength(1)
      expect(world.createdClockifyEntries[0]!.description).toContain(`[${TICKET}]`)
      expect(world.createdClockifyEntries[0]!.description).toContain("Reconciled from Claude Agent Session")
      expect(world.jiraWorklogs).toHaveLength(1)
      expect(world.jiraWorklogs[0]!.issueKey).toBe(TICKET)
      expect(world.jiraWorklogs[0]!.timeSpentSeconds).toBe(credited)
    }))

  it.effect("anchors the write to when the work happened, not to local noon", () =>
    Effect.gen(function*() {
      const { world } = yield* run(Effect.flatMap(readPlan, (plan) => confirm(plan)), {})
      expect(new Date(world.jiraWorklogs[0]!.started).getHours()).toBe(10)
    }))

  it.effect("proposes nothing the second time, because both sides now hold the time", () =>
    Effect.gen(function*() {
      const { value } = yield* run(
        Effect.gen(function*() {
          yield* Effect.flatMap(readPlan, (plan) => confirm(plan))
          // A fresh read, exactly as the browser reloads after a write.
          const reread = yield* readPlan
          return { row: rowFor(reread, TICKET, DAY), second: yield* confirm(reread) }
        }),
        {}
      )
      expect(value.row?.proposal).toBeUndefined()
      expect(value.second._tag).toBe("UnknownRow")
    }))

  it.effect("tops up only the side that is short", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.gen(function*() {
          const plan = yield* readPlan
          const credited = rowFor(plan, TICKET, DAY)?.proposal?.maxSeconds ?? 0
          return { credited, outcome: yield* confirm(plan) }
        }),
        { jiraWorklogs: { [TICKET]: [{ started: iso(at(10, 0)), timeSpentSeconds: 1800 }] } }
      )
      // Jira already held half an hour of it, so only the remainder went there.
      expect(world.jiraWorklogs).toHaveLength(1)
      expect(world.jiraWorklogs[0]!.timeSpentSeconds).toBe(value.credited - 1800)
      expect(world.createdClockifyEntries).toHaveLength(1)
      expect(value.outcome._tag).toBe("Written")
    }))
})

describe("overruling a row", () => {
  it.effect("refuses more time than the sessions evidence, and names the ceiling", () =>
    Effect.gen(function*() {
      const { value } = yield* run(
        Effect.gen(function*() {
          const plan = yield* readPlan
          const credited = rowFor(plan, TICKET, DAY)?.proposal?.maxSeconds ?? 0
          return { credited, outcome: yield* confirm(plan, { seconds: credited + 3600 }) }
        }),
        {}
      )
      expect(value.outcome).toEqual({ _tag: "PastEvidence", maxSeconds: value.credited })
    }))

  it.effect("writes nothing when it refuses an amount", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        Effect.flatMap(readPlan, (plan) => confirm(plan, { seconds: 24 * 60 * 60 })),
        {}
      )
      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toEqual([])
    }))

  it.effect("accepts a smaller amount and says a person chose it", () =>
    Effect.gen(function*() {
      const { world } = yield* run(Effect.flatMap(readPlan, (plan) => confirm(plan, { seconds: 900 })), {})
      expect(world.jiraWorklogs[0]!.timeSpentSeconds).toBe(900)
      expect(world.createdClockifyEntries[0]!.description).toContain("amount set by hand")
    }))

  it.effect("re-tallies the bucket an override moves the row to", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.gen(function*() {
          const plan = yield* readPlan
          const credited = rowFor(plan, TICKET, DAY)?.proposal?.maxSeconds ?? 0
          return { credited, outcome: yield* confirm(plan, { ticketKey: OTHER_TICKET }) }
        }),
        {
          // The target already holds twenty minutes that the row's own bucket knew nothing about.
          clockifyEntries: [{
            description: `[${OTHER_TICKET}] earlier work`,
            end: iso(at(9, 20)),
            start: iso(at(9, 0))
          }]
        }
      )
      expect(value.outcome._tag).toBe("Written")
      expect(world.createdClockifyEntries).toHaveLength(1)
      // Sized against the target's existing time, not against the row's empty one.
      expect(world.jiraWorklogs[0]!.issueKey).toBe(OTHER_TICKET)
      expect(world.jiraWorklogs[0]!.timeSpentSeconds).toBe(value.credited)
      expect(world.createdClockifyEntries[0]!.description).toContain(`[${OTHER_TICKET}]`)
      expect(world.createdClockifyEntries[0]!.description).toContain("ticket set by hand")
    }))

  it.effect("refuses a row that is not in the plan rather than guessing at one", () =>
    Effect.gen(function*() {
      const { value } = yield* run(
        Effect.flatMap(readPlan, (plan) => confirm(plan, { rowId: "2026-07-01:PROJ-0000" })),
        {}
      )
      expect(value._tag).toBe("UnknownRow")
    }))
})

describe("logging time by hand", () => {
  const manual = Effect.gen(function*() {
    const reconcile = yield* ReconcileService.ReconcileService
    return yield* logManualEntry({
      request: {
        day: DAY,
        note: "Sprint planning",
        seconds: 1800,
        startClock: "14:00",
        ticketKey: OTHER_TICKET
      },
      service: reconcile,
      summaryOf: noSummary
    })
  })

  it.effect("adds what was typed to both systems and claims no evidence for it", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(manual, {})
      expect(value.clockify).toEqual({ _tag: "Written", seconds: 1800 })
      expect(value.jira).toEqual({ _tag: "Written", seconds: 1800 })
      expect(value.description).toBe("Sprint planning (Entered by hand)")
      expect(value.description).not.toContain("Agent Session")
      expect(new Date(world.jiraWorklogs[0]!.started).getHours()).toBe(14)
    }))

  it.effect("adds rather than tops up, so existing time is not subtracted from it", () =>
    Effect.gen(function*() {
      const { world } = yield* run(manual, {
        jiraWorklogs: { [OTHER_TICKET]: [{ started: iso(at(9, 0)), timeSpentSeconds: 3600 }] }
      })
      expect(world.jiraWorklogs).toHaveLength(1)
      expect(world.jiraWorklogs[0]!.timeSpentSeconds).toBe(1800)
    }))
})
