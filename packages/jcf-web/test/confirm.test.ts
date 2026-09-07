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
  return buildWeekPlan({ createdAtMillis: 0, monday: period.from, planId: "plan-1", report, scope: "both" })
})

/** The same week read as a Jira-only week: Clockify is neither read nor written. */
const readJiraOnlyPlan = Effect.gen(function*() {
  const reconcile = yield* ReconcileService.ReconcileService
  const period = Time.isoWeekPeriod(new Date(at(12, 0)))
  const report = yield* reconcile.proposeFromSessions(period, { sides: { clockify: false, jira: true } })
  return buildWeekPlan({ createdAtMillis: 0, monday: period.from, planId: "plan-jira", report, scope: "jira" })
})

/** No Jira lookup in these tests: a title is provenance, not behaviour. */
const noSummary = () => Effect.succeed(null)

const confirm = (plan: HeldPlan, request: Partial<ConfirmRequest> = {}) =>
  Effect.gen(function*() {
    const reconcile = yield* ReconcileService.ReconcileService
    return yield* confirmProposal({
      plan,
      request: {
        blocks: undefined,
        note: undefined,
        rowId: rowId(TICKET, DAY),
        seconds: undefined,
        targets: undefined,
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

/**
 * A day's evidence arrives in stretches, and a person may accept them one at a time.
 *
 * Two properties matter here and nothing else does: a chosen block writes its own seconds at its own
 * time, and accepting the rest afterwards still works — the arithmetic must not read the morning's
 * entry as evidence that the afternoon was written too.
 */
describe("writing one block at a time", () => {
  /** The same ticket worked on again after lunch, so its row has two blocks. */
  const twoBlocks: FakeHeadlessOptions = {
    transcripts: {
      "repo/session-b.jsonl": transcript({
        branch: `feature/${TICKET}-otel`,
        minutes: 30,
        sessionId: "session-b",
        startMs: at(15, 0)
      })
    }
  }

  it.effect("writes only the block that was chosen, at the time it happened", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.gen(function*() {
          const plan = yield* readPlan
          const blocks = rowFor(plan, TICKET, DAY)?.proposal?.blocks ?? []
          return { blocks, outcome: yield* confirm(plan, { blocks: [1] }) }
        }),
        twoBlocks
      )
      expect(value.blocks).toHaveLength(2)
      const afternoon = value.blocks[1]!
      expect(value.outcome._tag).toBe("Written")
      expect(world.jiraWorklogs).toHaveLength(1)
      expect(world.jiraWorklogs[0]!.timeSpentSeconds).toBe(afternoon.seconds)
      // At the block's own start. Anchoring past what the day already holds is right for a row
      // written in instalments and wrong here: the person pointed at this stretch.
      expect(new Date(world.jiraWorklogs[0]!.started).getHours()).toBe(15)
      expect(world.createdClockifyEntries).toHaveLength(1)
    }))

  it.effect("still writes the other block afterwards, rather than reporting nothing owed", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.gen(function*() {
          const plan = yield* readPlan
          const blocks = rowFor(plan, TICKET, DAY)?.proposal?.blocks ?? []
          yield* confirm(plan, { blocks: [1] })
          // A fresh read, as the page reloads after a write, then the morning.
          const reread = yield* readPlan
          const second = yield* confirm(reread, { blocks: [0] })
          return { blocks, second }
        }),
        twoBlocks
      )
      expect(value.second._tag).toBe("Written")
      expect(world.jiraWorklogs).toHaveLength(2)
      // Both blocks, and no more than the day's credit between them.
      const written = world.jiraWorklogs.reduce((sum, worklog) => sum + worklog.timeSpentSeconds, 0)
      expect(written).toBe(value.blocks.reduce((sum, block) => sum + block.seconds, 0))
      expect(new Date(world.jiraWorklogs[1]!.started).getHours()).toBe(10)
    }))

  it.effect("refuses an amount larger than the blocks that were ticked", () =>
    Effect.gen(function*() {
      const { value } = yield* run(
        Effect.gen(function*() {
          const plan = yield* readPlan
          const blocks = rowFor(plan, TICKET, DAY)?.proposal?.blocks ?? []
          const chosen = blocks[1]?.seconds ?? 0
          return { chosen, outcome: yield* confirm(plan, { blocks: [1], seconds: chosen + 60 }) }
        }),
        twoBlocks
      )
      expect(value.outcome).toEqual({ _tag: "PastEvidence", maxSeconds: value.chosen })
    }))

  it.effect("refuses a block position this row does not have, and writes nothing", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.flatMap(readPlan, (plan) => confirm(plan, { blocks: [7] })),
        twoBlocks
      )
      expect(value._tag).toBe("UnknownBlocks")
      expect(world.jiraWorklogs).toEqual([])
      expect(world.createdClockifyEntries).toEqual([])
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
        targets: { clockify: true, jira: true },
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

describe("reconciling one system only", () => {
  it.effect("never reads Clockify, so time it holds does not shrink the Jira proposal", () =>
    Effect.gen(function*() {
      const { value } = yield* run(
        Effect.gen(function*() {
          const both = yield* readPlan
          const jiraOnly = yield* readJiraOnlyPlan
          return {
            bothClockify: rowFor(both, TICKET, DAY)?.clockifySeconds,
            bothJiraDelta: rowFor(both, TICKET, DAY)?.proposal?.jiraDelta,
            credited: rowFor(jiraOnly, TICKET, DAY)?.proposal?.maxSeconds,
            jiraOnlyClockifyDelta: rowFor(jiraOnly, TICKET, DAY)?.proposal?.clockifyDelta,
            jiraOnlyJiraDelta: rowFor(jiraOnly, TICKET, DAY)?.proposal?.jiraDelta
          }
        }),
        {
          // An hour already in Clockify. A both-sides week sees it; a Jira-only week must not, and
          // must not treat "not read" as "nothing there" either.
          clockifyEntries: [{
            description: `[${TICKET}] tracked with a timer`,
            end: iso(at(11, 0)),
            start: iso(at(10, 0))
          }]
        }
      )
      expect(value.bothClockify).toBe(3600)
      expect(value.jiraOnlyClockifyDelta).toBe(0)
      expect(value.jiraOnlyJiraDelta).toBe(value.credited)
      expect(value.bothJiraDelta).toBe(value.credited)
    }))

  it.effect("writes to Jira alone and says Clockify was not asked for", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.gen(function*() {
          const plan = yield* readJiraOnlyPlan
          return { credited: rowFor(plan, TICKET, DAY)?.proposal?.maxSeconds, outcome: yield* confirm(plan) }
        }),
        {}
      )
      expect(value.outcome._tag).toBe("Written")
      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toHaveLength(1)
      expect(world.jiraWorklogs[0]!.timeSpentSeconds).toBe(value.credited)
      if (value.outcome._tag === "Written") {
        expect(value.outcome.result.clockify).toEqual({ _tag: "Skipped" })
        expect(value.outcome.result.lines).toContain("· Clockify not asked for")
      }
    }))

  it.effect("lets one write override the week's scope", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        Effect.flatMap(readJiraOnlyPlan, (plan) => confirm(plan, { targets: { clockify: true, jira: false } })),
        {}
      )
      expect(world.createdClockifyEntries).toHaveLength(1)
      expect(world.jiraWorklogs).toEqual([])
    }))

  it.effect("refuses a write to neither system", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.flatMap(readPlan, (plan) => confirm(plan, { targets: { clockify: false, jira: false } })),
        {}
      )
      expect(value._tag).toBe("NoTargets")
      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toEqual([])
    }))

  it.effect("logs a manual entry to one system when that is all that was asked", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.gen(function*() {
          const reconcile = yield* ReconcileService.ReconcileService
          return yield* logManualEntry({
            request: {
              day: DAY,
              note: "Sprint planning",
              seconds: 1800,
              startClock: "14:00",
              targets: { clockify: false, jira: true },
              ticketKey: OTHER_TICKET
            },
            service: reconcile,
            summaryOf: noSummary
          })
        }),
        {}
      )
      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toHaveLength(1)
      expect(value.clockify).toEqual({ _tag: "Skipped" })
    }))
})
