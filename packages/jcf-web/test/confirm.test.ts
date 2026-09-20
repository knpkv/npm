/**
 * Confirming a row, end to end through the engine's own fake world.
 *
 * These assert what was written, what was refused, and what the entries say — never how attribution
 * was implemented. Every one runs against the real `ReconcileService` over faked Clockify, Jira and
 * transcripts, so a passing test means the write path actually ran.
 */
import { NodeCrypto } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ReconcileService, SourceConsumption, Time } from "@knpkv/jira-clockify"
import { FAKE_ACCOUNT_ID, FAKE_HOME, type FakeHeadlessOptions, makeFakeHeadless } from "@knpkv/jira-clockify/testing.js"
import { Effect, Layer, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import type { ConfirmRequest as PreviewRequest } from "../src/client/api.js"
import { previewWrite } from "../src/client/weekAtoms.js"
import { confirmProposal, type ConfirmRequest, logManualEntry } from "../src/server/Confirm.js"
import { buildWeekPlan, type HeldPlan, rowId } from "../src/server/WeekPlan.js"
import { layer as weekPlansLayer, WeekPlans } from "../src/server/WeekPlans.js"
import { WeekPlan } from "../src/shared/contracts.js"

// Each case composes exactly the layer it needs and provides it at its own entry point.
// @effect-diagnostics strictEffectProvide:off

const WORK_ROOT = `${FAKE_HOME}/dev/work`
const TICKET = "PROJ-5662"
const OTHER_TICKET = "PROJ-9001"
const DAY = "2026-07-01"
const HISTORICAL_NOW = new Date(2026, 6, 8).getTime()
const StoredConsumption = Schema.fromJsonString(Schema.Struct({
  pending: Schema.Array(Schema.Unknown),
  bindings: Schema.Array(Schema.Struct({
    provider: Schema.Literals(["clockify", "jira"]),
    entryId: Schema.String,
    seconds: Schema.Finite
  }))
}))

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

/** The same week read as a Clockify-only week: Jira is neither read nor written. */
const readClockifyOnlyPlan = Effect.gen(function*() {
  const reconcile = yield* ReconcileService.ReconcileService
  const period = Time.isoWeekPeriod(new Date(at(12, 0)))
  const report = yield* reconcile.proposeFromSessions(period, { sides: { clockify: true, jira: false } })
  return buildWeekPlan({ createdAtMillis: 0, monday: period.from, planId: "plan-clockify", report, scope: "clockify" })
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
  return TestClock.setTime(HISTORICAL_NOW).pipe(
    Effect.andThen(effect),
    Effect.provide(fake.layer),
    Effect.map((value) => ({ value, world: fake.world }))
  )
}

const rowFor = (plan: HeldPlan, ticketKey: string, day: string) =>
  plan.plan.rows.find((row) => row.rowId === rowId(ticketKey, day))

describe("preview and provider agreement", () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly request: Omit<PreviewRequest, "planId" | "rowId"> }> = [
    { name: "selected afternoon after recorded morning", request: { blocks: [1], seconds: 900 } },
    { name: "whole row with asymmetric provider totals", request: {} },
    { name: "overridden ticket with its own asymmetric totals", request: { ticketKey: OTHER_TICKET } },
    { name: "selected block on Jira alone", request: { blocks: [1], targets: { clockify: false, jira: true } } }
  ]

  // Both callers cross the same planning seam; the comparison reaches real provider encoding
  // through fake HTTP adapters so matching planner results alone cannot make this test pass.
  for (const scenario of cases) {
    it.effect(scenario.name, () =>
      Effect.gen(function*() {
        const ticketKey = scenario.request.ticketKey ?? TICKET
        const { value, world } = yield* run(
          Effect.gen(function*() {
            const plan = yield* readPlan
            const preview = previewWrite({ plan: plan.plan, entries: [] }, {
              kind: "confirm",
              request: { planId: plan.planId, rowId: rowId(TICKET, DAY), ...scenario.request }
            })
            return { preview, outcome: yield* confirm(plan, scenario.request) }
          }),
          {
            transcripts: {
              "repo/afternoon.jsonl": transcript({
                sessionId: "afternoon",
                branch: `feature/${TICKET}`,
                startMs: at(15, 0),
                minutes: 30
              })
            },
            clockifyEntries: [{ description: `[${ticketKey}] morning`, start: iso(at(8, 0)), end: iso(at(8, 30)) }],
            jiraWorklogs: { [ticketKey]: [{ started: iso(at(8, 0)), timeSpentSeconds: 900 }] }
          }
        )
        expect(value.outcome._tag).toBe("Written")
        expect(value.preview.length).toBeGreaterThan(0)
        for (const entry of value.preview) {
          expect(entry.ticketKey).toBe(ticketKey)
          const seconds = (entry.endMs - entry.startMs) / 1000
          if (entry.source === "clockify") {
            const created = world.createdClockifyEntries.find((candidate) => candidate.start === iso(entry.startMs))
            expect(created).toBeDefined()
            expect(created?.description).toContain(`[${ticketKey}]`)
            expect(
              (new Date(created?.end ?? created?.start ?? 0).getTime() - new Date(created?.start ?? 0).getTime()) /
                1000
            ).toBe(seconds)
          } else {
            const worklog = world.jiraWorklogs.find((candidate) =>
              new Date(candidate.started).getTime() === entry.startMs
            )
            expect(worklog).toMatchObject({ issueKey: ticketKey, timeSpentSeconds: seconds })
          }
          if (scenario.request.blocks !== undefined) {
            expect(entry.startMs).toBe(at(15, 0))
          }
        }
      }))
  }

  // A provider write between preview and confirmation must change both amount and anchor on
  // that side. The browser snapshot remains unchanged and has no authority over the new write.
  it.effect("fresh provider totals supersede cached preview amounts and starts", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.gen(function*() {
          const service = yield* ReconcileService.ReconcileService
          const plan = yield* readPlan
          const preview = previewWrite({ plan: plan.plan, entries: [] }, {
            kind: "confirm",
            request: { planId: plan.planId, rowId: rowId(TICKET, DAY) }
          })
          yield* logManualEntry({
            service,
            summaryOf: noSummary,
            request: {
              day: DAY,
              ticketKey: TICKET,
              seconds: 900,
              startClock: "10:00",
              note: undefined,
              targets: { clockify: true, jira: false }
            }
          })
          return { preview, outcome: yield* confirm(plan), cached: rowFor(plan, TICKET, DAY)?.clockifySeconds }
        }),
        {}
      )
      expect(value.outcome._tag).toBe("Written")
      expect(value.cached).toBe(0)
      expect(value.preview).toHaveLength(2)
      expect(world.createdClockifyEntries).toHaveLength(2)
      expect(world.jiraWorklogs).toHaveLength(1)
      const clockify = value.preview.find((entry) => entry.source === "clockify")
      const jira = value.preview.find((entry) => entry.source === "jira")
      expect(clockify).toBeDefined()
      expect(jira).toBeDefined()
      if (clockify === undefined || jira === undefined) return
      expect(world.createdClockifyEntries[1]).toMatchObject({
        start: iso(clockify.startMs + 900000),
        end: iso(clockify.endMs)
      })
      expect(world.jiraWorklogs[0]?.timeSpentSeconds).toBe((jira.endMs - jira.startMs) / 1000)
      expect(new Date(world.jiraWorklogs[0]?.started ?? "").getTime()).toBe(jira.startMs)
    }))
})

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
          // An explicit full read also subtracts the time already written.
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

  it.effect("does not write a selected block again after a fresh read", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.gen(function*() {
          const plan = yield* readPlan
          yield* confirm(plan, { blocks: [1] })
          const reread = yield* readPlan
          return yield* confirm(reread, { blocks: [1] })
        }),
        twoBlocks
      )
      expect(value._tag).toBe("NothingOwed")
      expect(world.jiraWorklogs).toHaveLength(1)
      expect(world.createdClockifyEntries).toHaveLength(1)
      expect(new Date(world.jiraWorklogs[0]!.started).getHours()).toBe(15)
    }))

  it.effect("keeps disjoint corrected blocks consumed under their source row", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.gen(function*() {
          const plan = yield* readPlan
          const blocks = rowFor(plan, TICKET, DAY)?.proposal?.blocks ?? []
          const corrected = yield* confirm(plan, { ticketKey: OTHER_TICKET })
          const repeated = yield* confirm(plan, { blocks: [1] })
          return { blocks, corrected, repeated }
        }),
        twoBlocks
      )
      expect(value.blocks).toHaveLength(2)
      expect(value.corrected._tag).toBe("Written")
      expect(value.repeated._tag).toBe("NothingOwed")
      expect(world.createdClockifyEntries).toHaveLength(2)
      expect(world.jiraWorklogs).toHaveLength(2)
    }))

  it.effect("adds ordinary and corrected consumption without reopening the retained row", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.gen(function*() {
          const plan = yield* readPlan
          const ordinary = yield* confirm(plan, { seconds: 1800 })
          const corrected = yield* confirm(plan, { seconds: 3900, ticketKey: OTHER_TICKET })
          const repeated = yield* confirm(plan)
          return { corrected, ordinary, repeated }
        }),
        {
          transcripts: {
            "repo/session-a.jsonl": transcript({
              branch: `feature/${TICKET}-otel`,
              minutes: 60,
              sessionId: "session-a",
              startMs: at(10, 0)
            })
          }
        }
      )
      expect(value.ordinary._tag).toBe("Written")
      expect(value.corrected._tag).toBe("Written")
      expect(value.repeated._tag).toBe("NothingOwed")
      expect(world.createdClockifyEntries).toHaveLength(2)
      expect(world.jiraWorklogs).toHaveLength(2)
      const clockifySeconds = world.createdClockifyEntries.reduce(
        (sum, entry) => sum + (new Date(entry.end ?? entry.start).getTime() - new Date(entry.start).getTime()) / 1000,
        0
      )
      expect(clockifySeconds).toBe(3900)
      expect(world.jiraWorklogs.reduce((sum, entry) => sum + entry.timeSpentSeconds, 0)).toBe(3900)
    }))

  it.effect("keeps provider consumption independent after an asymmetric corrected write", () => {
    const fake = makeFakeHeadless(baseOptions({
      transcripts: {
        "repo/session-a.jsonl": transcript({
          branch: `feature/${TICKET}-otel`,
          minutes: 60,
          sessionId: "session-a",
          startMs: at(10, 0)
        })
      }
    }))
    return Effect.gen(function*() {
      yield* TestClock.setTime(HISTORICAL_NOW)
      const plan = yield* readPlan
      yield* confirm(plan, { seconds: 1800 })
      fake.world.jiraLoggedIn = false
      yield* confirm(plan, { seconds: 3900, ticketKey: OTHER_TICKET })
      fake.world.jiraLoggedIn = true
      const completed = yield* confirm(plan)
      const repeated = yield* confirm(plan)

      expect(completed._tag).toBe("Written")
      expect(repeated._tag).toBe("NothingOwed")
      expect(fake.world.createdClockifyEntries).toHaveLength(2)
      expect(fake.world.jiraWorklogs).toHaveLength(2)
      const clockifySeconds = fake.world.createdClockifyEntries.reduce(
        (sum, entry) => sum + (new Date(entry.end ?? entry.start).getTime() - new Date(entry.start).getTime()) / 1000,
        0
      )
      expect(clockifySeconds).toBe(3900)
      expect(fake.world.jiraWorklogs.reduce((sum, entry) => sum + entry.timeSpentSeconds, 0)).toBe(3900)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("consumes the later block when the earlier block was already recorded", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.gen(function*() {
          const plan = yield* readPlan
          const blocks = rowFor(plan, TICKET, DAY)?.proposal?.blocks ?? []
          const first = yield* confirm(plan)
          const repeated = yield* confirm(plan, { blocks: [1], ticketKey: OTHER_TICKET })
          return { blocks, first, repeated }
        }),
        {
          ...twoBlocks,
          clockifyEntries: [{
            description: `[${TICKET}] morning`,
            start: iso(at(10, 0)),
            end: iso(at(11, 5))
          }],
          jiraWorklogs: { [TICKET]: [{ started: iso(at(10, 0)), timeSpentSeconds: 3900 }] }
        }
      )
      expect(value.blocks).toHaveLength(2)
      expect(value.first._tag).toBe("Written")
      expect(value.repeated._tag).toBe("NothingOwed")
      expect(world.createdClockifyEntries).toHaveLength(1)
      expect(world.jiraWorklogs).toHaveLength(1)
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

it.effect("consumes source evidence when it is confirmed under another ticket", () =>
  Effect.gen(function*() {
    const { value, world } = yield* run(
      Effect.gen(function*() {
        const plan = yield* readPlan
        const retargeted = yield* confirm(plan, { ticketKey: OTHER_TICKET })
        const original = yield* confirm(plan)
        return { original, retargeted }
      }),
      {}
    )
    expect(value.retargeted._tag).toBe("Written")
    expect(value.original._tag).toBe("NothingOwed")
    expect(world.createdClockifyEntries).toHaveLength(1)
    expect(world.jiraWorklogs).toHaveLength(1)
    expect(world.jiraWorklogs[0]?.issueKey).toBe(OTHER_TICKET)
  }))

it.effect("refreshes corrected consumption before confirming a separately retained plan", () =>
  Effect.gen(function*() {
    const { value, world } = yield* run(
      Effect.gen(function*() {
        const first = yield* readPlan
        const stale = yield* readPlan
        const retargeted = yield* confirm(first, { ticketKey: OTHER_TICKET })
        const repeated = yield* confirm(stale)
        return { repeated, retargeted }
      }),
      {}
    )
    expect(value.retargeted._tag).toBe("Written")
    expect(value.repeated._tag).toBe("NothingOwed")
    expect(world.createdClockifyEntries).toHaveLength(1)
    expect(world.jiraWorklogs).toHaveLength(1)
  }))

it.effect("keeps corrected Clockify seconds in a Jira-only week response", () =>
  Effect.gen(function*() {
    const fake = makeFakeHeadless(baseOptions())
    const { plan, written } = yield* Effect.gen(function*() {
      const plans = yield* WeekPlans
      const first = yield* plans.keep(yield* readPlan, yield* plans.readGeneration)
      const written = yield* confirm(first, {
        seconds: 1800,
        ticketKey: OTHER_TICKET,
        targets: { clockify: true, jira: false }
      })
      const retained = yield* plans.keep(yield* readJiraOnlyPlan, yield* plans.readGeneration)
      const encoded = yield* Schema.encodeEffect(WeekPlan)(retained.plan)
      return { plan: yield* Schema.decodeEffect(WeekPlan)(encoded), written }
    }).pipe(
      Effect.provide(weekPlansLayer.pipe(Layer.provideMerge(fake.layer), Layer.provideMerge(NodeCrypto.layer)))
    )

    expect(written._tag).toBe("Written")
    expect(plan.rows.find((row) => row.rowId === rowId(TICKET, DAY))?.proposal?.blocks[0]?.consumed).toEqual({
      clockify: 1800,
      jira: 0
    })
  }))

it.effect("keeps corrected Jira seconds in a Clockify-only week response", () =>
  Effect.gen(function*() {
    const fake = makeFakeHeadless(baseOptions())
    const { plan, written } = yield* Effect.gen(function*() {
      const plans = yield* WeekPlans
      const first = yield* plans.keep(yield* readPlan, yield* plans.readGeneration)
      const written = yield* confirm(first, {
        seconds: 1800,
        ticketKey: OTHER_TICKET,
        targets: { clockify: false, jira: true }
      })
      const retained = yield* plans.keep(yield* readClockifyOnlyPlan, yield* plans.readGeneration)
      const encoded = yield* Schema.encodeEffect(WeekPlan)(retained.plan)
      return { plan: yield* Schema.decodeEffect(WeekPlan)(encoded), written }
    }).pipe(
      Effect.provide(weekPlansLayer.pipe(Layer.provideMerge(fake.layer), Layer.provideMerge(NodeCrypto.layer)))
    )

    expect(written._tag).toBe("Written")
    expect(plan.rows.find((row) => row.rowId === rowId(TICKET, DAY))?.proposal?.blocks[0]?.consumed).toEqual({
      clockify: 0,
      jira: 1800
    })
  }))

it.effect("keeps an unconsumed block at zero after a provider-only reread", () =>
  Effect.gen(function*() {
    const fake = makeFakeHeadless(baseOptions())
    const plan = yield* Effect.gen(function*() {
      const plans = yield* WeekPlans
      yield* plans.keep(yield* readPlan, yield* plans.readGeneration)
      const retained = yield* plans.keep(yield* readJiraOnlyPlan, yield* plans.readGeneration)
      const encoded = yield* Schema.encodeEffect(WeekPlan)(retained.plan)
      return yield* Schema.decodeEffect(WeekPlan)(encoded)
    }).pipe(
      Effect.provide(weekPlansLayer.pipe(Layer.provideMerge(fake.layer), Layer.provideMerge(NodeCrypto.layer)))
    )

    expect(plan.rows.find((row) => row.rowId === rowId(TICKET, DAY))?.proposal?.blocks[0]?.consumed).toEqual({
      clockify: 0,
      jira: 0
    })
  }))

it.effect("updates the freshly read provider without losing retained consumption", () =>
  Effect.gen(function*() {
    const fake = makeFakeHeadless(baseOptions())
    const { freshWrite, plan, retainedWrite } = yield* Effect.gen(function*() {
      const plans = yield* WeekPlans
      const first = yield* plans.keep(yield* readPlan, yield* plans.readGeneration)
      const retainedWrite = yield* confirm(first, {
        seconds: 1800,
        ticketKey: OTHER_TICKET,
        targets: { clockify: true, jira: false }
      })
      // This second plan is not held, so its Jira write is provider state rather than cached consumption.
      const freshWrite = yield* confirm(yield* readPlan, {
        seconds: 900,
        ticketKey: OTHER_TICKET,
        targets: { clockify: false, jira: true }
      })
      const retained = yield* plans.keep(yield* readJiraOnlyPlan, yield* plans.readGeneration)
      const encoded = yield* Schema.encodeEffect(WeekPlan)(retained.plan)
      return {
        plan: yield* Schema.decodeEffect(WeekPlan)(encoded),
        retainedWrite,
        freshWrite
      }
    }).pipe(
      Effect.provide(weekPlansLayer.pipe(Layer.provideMerge(fake.layer), Layer.provideMerge(NodeCrypto.layer)))
    )

    expect(retainedWrite._tag).toBe("Written")
    expect(freshWrite._tag).toBe("Written")
    expect(plan.rows.find((row) => row.rowId === rowId(TICKET, DAY))?.proposal?.blocks[0]?.consumed).toEqual({
      clockify: 1800,
      jira: 900
    })
  }))

it.effect("rebuilds corrected-ticket consumption from provider entries after a restart", () =>
  Effect.gen(function*() {
    const { value, world } = yield* run(
      Effect.gen(function*() {
        const first = yield* readPlan
        const retargeted = yield* confirm(first, { ticketKey: OTHER_TICKET })
        // No shared HeldPlan or in-memory consumption map: this is what a restarted server rebuilds.
        const rebuilt = yield* readPlan
        return { rebuilt, repeated: yield* confirm(rebuilt), retargeted }
      }),
      {}
    )
    expect(value.retargeted._tag).toBe("Written")
    expect(rowFor(value.rebuilt, TICKET, DAY)?.proposal).toBeUndefined()
    expect(value.repeated._tag).toBe("UnknownRow")
    expect(world.createdClockifyEntries).toHaveLength(1)
    expect(world.jiraWorklogs).toHaveLength(1)
  }))

it.effect("keeps confirmed corrected time consumed after both provider descriptions lose their source suffix", () => {
  const fake = makeFakeHeadless(baseOptions())
  return Effect.gen(function*() {
    yield* TestClock.setTime(HISTORICAL_NOW)
    const first = yield* readPlan
    const written = yield* confirm(first, { ticketKey: OTHER_TICKET })
    expect(written._tag).toBe("Written")
    const clockifyWrite = fake.world.createdClockifyEntries[0]!
    const jiraWrite = fake.world.jiraWorklogs[0]!
    fake.world.setClockifyEntries([{
      id: "created-0",
      description: `[${OTHER_TICKET}] edited outside jcf`,
      start: clockifyWrite.start,
      end: clockifyWrite.end
    }])
    fake.world.setJiraWorklogs({
      [OTHER_TICKET]: [{
        id: "wl-created-0",
        started: jiraWrite.started,
        timeSpentSeconds: jiraWrite.timeSpentSeconds,
        comment: "edited outside jcf"
      }]
    })
    const rebuilt = yield* readPlan
    const repeated = yield* confirm(rebuilt)
    expect(rowFor(rebuilt, TICKET, DAY)?.proposal).toBeUndefined()
    expect(repeated._tag).toBe("UnknownRow")
    expect(fake.world.createdClockifyEntries).toHaveLength(1)
    expect(fake.world.jiraWorklogs).toHaveLength(1)
  }).pipe(Effect.provide(fake.layer))
})

it.effect("uses the same durable partial seconds in preview and confirmation after a server restart", () => {
  const first = makeFakeHeadless(baseOptions())
  return Effect.gen(function*() {
    yield* Effect.gen(function*() {
      yield* TestClock.setTime(HISTORICAL_NOW)
      const plan = yield* readPlan
      expect((yield* confirm(plan, { seconds: 1800, ticketKey: OTHER_TICKET }))._tag).toBe("Written")
    }).pipe(Effect.provide(first.layer))
    const clockifyWrite = first.world.createdClockifyEntries[0]!
    const jiraWrite = first.world.jiraWorklogs[0]!
    const restarted = makeFakeHeadless(baseOptions({
      writtenFiles: { ...first.world.writtenFiles },
      clockifyEntries: [{
        id: "created-0",
        description: `[${OTHER_TICKET}] rewritten`,
        start: clockifyWrite.start,
        end: clockifyWrite.end
      }],
      jiraWorklogs: {
        [OTHER_TICKET]: [{
          id: "wl-created-0",
          started: jiraWrite.started,
          timeSpentSeconds: jiraWrite.timeSpentSeconds,
          comment: "rewritten"
        }]
      }
    }))
    yield* Effect.gen(function*() {
      yield* TestClock.setTime(HISTORICAL_NOW)
      const plan = yield* readPlan
      const row = rowFor(plan, TICKET, DAY)
      expect(row?.proposal?.blocks[0]?.consumed).toEqual({ clockify: 1800, jira: 1800 })
      const preview = previewWrite({ plan: plan.plan, entries: [] }, {
        kind: "confirm",
        request: { planId: plan.planId, rowId: rowId(TICKET, DAY) }
      })
      const remaining = (row?.proposal?.maxSeconds ?? 0) - 1800
      expect(
        preview.filter((entry) => entry.source === "clockify")
          .reduce((sum, entry) => sum + (entry.endMs - entry.startMs) / 1000, 0)
      ).toBe(remaining)
      expect(
        preview.filter((entry) => entry.source === "jira")
          .reduce((sum, entry) => sum + (entry.endMs - entry.startMs) / 1000, 0)
      ).toBe(remaining)
      const result = yield* confirm(plan)
      expect(result._tag).toBe("Written")
      if (result._tag === "Written") {
        expect(result.result.clockify).toMatchObject({ _tag: "Written", seconds: remaining })
        expect(result.result.jira).toMatchObject({ _tag: "Written", seconds: remaining })
      }
      expect(restarted.world.createdClockifyEntries).toHaveLength(1)
      expect(restarted.world.jiraWorklogs).toHaveLength(1)
      const stored = yield* Schema.decodeUnknownEffect(StoredConsumption)(
        restarted.world.writtenFiles[`${FAKE_HOME}/.jcf/source-consumption.v1.json`]
      )
      expect(stored.pending).toEqual([])
      for (const provider of ["clockify", "jira"] satisfies ReadonlyArray<"clockify" | "jira">) {
        const bindings = stored.bindings.filter((binding) => binding.provider === provider)
        expect(bindings.map((binding) => binding.seconds).sort((left, right) => left - right)).toEqual(
          [1800, remaining].sort((left, right) => left - right)
        )
        expect(new Set(bindings.map((binding) => binding.entryId)).size).toBe(2)
      }
      expect((yield* confirm(plan))._tag).toBe("NothingOwed")
      expect(restarted.world.createdClockifyEntries).toHaveLength(1)
      expect(restarted.world.jiraWorklogs).toHaveLength(1)
    }).pipe(Effect.provide(restarted.layer))
  })
})

it.effect("does not reopen a corrected Jira worklog on page two after restart", () => {
  const first = makeFakeHeadless(baseOptions())
  return Effect.gen(function*() {
    const held = yield* Effect.gen(function*() {
      yield* TestClock.setTime(HISTORICAL_NOW)
      const plan = yield* readJiraOnlyPlan
      expect((yield* confirm(plan, { seconds: 3600, ticketKey: OTHER_TICKET }))._tag).toBe("Written")
      return plan
    }).pipe(Effect.provide(first.layer))
    const written = first.world.jiraWorklogs[0]!
    const restarted = makeFakeHeadless(baseOptions({
      jiraWorklogPageSize: 1,
      writtenFiles: { ...first.world.writtenFiles },
      jiraWorklogs: {
        [OTHER_TICKET]: [
          {
            id: "unrelated-worklog",
            author: { accountId: "acct-other" },
            started: written.started,
            timeSpentSeconds: 900
          },
          {
            id: "wl-created-0",
            started: written.started,
            timeSpentSeconds: written.timeSpentSeconds,
            comment: "edited after confirmation"
          }
        ]
      }
    }))
    yield* Effect.gen(function*() {
      yield* TestClock.setTime(HISTORICAL_NOW)
      const rebuilt = yield* readJiraOnlyPlan
      expect(
        rebuilt.report.recorded.flatMap((row) =>
          row.intervals.flatMap((interval) => interval.entry === undefined ? [] : [interval.entry.id])
        )
      ).toContain("wl-created-0")
      expect((yield* confirm(held, { seconds: 3600, ticketKey: OTHER_TICKET }))._tag).toBe("NothingOwed")
      expect((yield* confirm(held, { seconds: 3600, ticketKey: TICKET }))._tag).toBe("NothingOwed")
      expect(restarted.world.jiraWorklogs).toEqual([])
    }).pipe(Effect.provide(restarted.layer))
  })
})

it.effect("withholds confirmation when a later Jira worklog page cannot prove completeness", () => {
  const first = makeFakeHeadless(baseOptions())
  return Effect.gen(function*() {
    const held = yield* Effect.gen(function*() {
      yield* TestClock.setTime(HISTORICAL_NOW)
      const plan = yield* readJiraOnlyPlan
      expect((yield* confirm(plan, { seconds: 3600, ticketKey: OTHER_TICKET }))._tag).toBe("Written")
      return plan
    }).pipe(Effect.provide(first.layer))
    const written = first.world.jiraWorklogs[0]!
    const ledgerPath = `${FAKE_HOME}/.jcf/source-consumption.v1.json`
    const ledger = first.world.writtenFiles[ledgerPath]
    const heldPlan = JSON.stringify(held.plan)
    const heldConsumption = [...held.consumption.entries()].map(([key, value]) => [key, { ...value }])
    const faults: ReadonlyArray<NonNullable<FakeHeadlessOptions["jiraWorklogPageFault"]>> = [
      "failure",
      "missing",
      "inconsistent",
      "stalled",
      "missing-duration",
      "missing-started",
      "missing-author",
      "missing-id",
      "empty-id",
      "spaces-id",
      "tab-newline-id"
    ]
    for (const fault of faults) {
      const restarted = makeFakeHeadless(baseOptions({
        jiraWorklogPageSize: 1,
        jiraWorklogPageFault: fault,
        writtenFiles: { ...first.world.writtenFiles },
        jiraWorklogs: {
          [OTHER_TICKET]: [
            {
              id: "unrelated-worklog",
              author: { accountId: "acct-other" },
              started: written.started,
              timeSpentSeconds: 900
            },
            {
              id: "wl-created-0",
              started: written.started,
              timeSpentSeconds: written.timeSpentSeconds,
              comment: "edited after confirmation"
            }
          ]
        }
      }))
      yield* Effect.gen(function*() {
        yield* TestClock.setTime(HISTORICAL_NOW)
        expect((yield* Effect.result(confirm(held, { seconds: 3600, ticketKey: TICKET })))._tag).toBe("Failure")
        expect((yield* Effect.result(readJiraOnlyPlan))._tag).toBe("Failure")
        expect((yield* Effect.result(confirm(held, { seconds: 3600, ticketKey: OTHER_TICKET })))._tag).toBe(
          "Failure"
        )
        expect(JSON.stringify(held.plan)).toBe(heldPlan)
        expect([...held.consumption.entries()].map(([key, value]) => [key, { ...value }])).toEqual(
          heldConsumption
        )
        expect(restarted.world.jiraWorklogs).toEqual([])
        expect(restarted.world.createdClockifyEntries).toEqual([])
        expect(restarted.world.writtenFiles[ledgerPath]).toBe(ledger)
        const stored = yield* Schema.decodeUnknownEffect(StoredConsumption)(restarted.world.writtenFiles[ledgerPath])
        expect(stored.pending).toEqual([])
        expect(stored.bindings.filter((binding) => binding.provider === "jira")).toHaveLength(1)
        expect(stored.bindings.find((binding) => binding.provider === "jira")?.seconds).toBe(3600)
      }).pipe(Effect.provide(restarted.layer))
    }
  })
})

it.effect("reopens only genuinely shortened provider time after a suffix-free edit", () => {
  const fake = makeFakeHeadless(baseOptions())
  return Effect.gen(function*() {
    yield* TestClock.setTime(HISTORICAL_NOW)
    expect((yield* confirm(yield* readPlan, { ticketKey: OTHER_TICKET }))._tag).toBe("Written")
    const clockifyWrite = fake.world.createdClockifyEntries[0]!
    const jiraWrite = fake.world.jiraWorklogs[0]!
    fake.world.setClockifyEntries([{
      id: "created-0",
      description: `[${OTHER_TICKET}] revised`,
      start: clockifyWrite.start,
      end: iso(new Date(clockifyWrite.start).getTime() + 1_800_000)
    }])
    fake.world.setJiraWorklogs({
      [OTHER_TICKET]: [{
        id: "wl-created-0",
        started: jiraWrite.started,
        timeSpentSeconds: jiraWrite.timeSpentSeconds,
        comment: "revised"
      }]
    })
    const plan = yield* readPlan
    const row = rowFor(plan, TICKET, DAY)
    expect(row?.proposal?.blocks[0]?.consumed).toEqual({ clockify: 1800, jira: jiraWrite.timeSpentSeconds })
    const remaining = (row?.proposal?.maxSeconds ?? 0) - 1800
    const preview = previewWrite({ plan: plan.plan, entries: [] }, {
      kind: "confirm",
      request: { planId: plan.planId, rowId: rowId(TICKET, DAY) }
    })
    expect(
      preview.filter((entry) => entry.source === "clockify")
        .reduce((sum, entry) => sum + (entry.endMs - entry.startMs) / 1000, 0)
    ).toBe(remaining)
    expect(preview.some((entry) => entry.source === "jira")).toBe(false)
    expect((yield* confirm(plan))._tag).toBe("Written")
    expect(fake.world.createdClockifyEntries).toHaveLength(2)
    expect(fake.world.jiraWorklogs).toHaveLength(1)
    expect(
      (new Date(fake.world.createdClockifyEntries[1]!.end ?? 0).getTime() -
        new Date(fake.world.createdClockifyEntries[1]!.start).getTime()) / 1000
    ).toBe(remaining)
  }).pipe(Effect.provide(fake.layer))
})

it.effect("initializes an empty first-run provider window before any session write", () => {
  const fake = makeFakeHeadless(baseOptions({ writtenFiles: {} }))
  return Effect.gen(function*() {
    yield* TestClock.setTime(HISTORICAL_NOW)
    const plan = yield* readPlan
    expect((yield* confirm(plan, { ticketKey: OTHER_TICKET }))._tag).toBe("Written")
    expect(fake.world.createdClockifyEntries).toHaveLength(1)
    expect(fake.world.jiraWorklogs).toHaveLength(1)
  }).pipe(Effect.provide(fake.layer))
})

it.effect("fails closed on unlinked earlier provider history instead of guessing a source", () => {
  const fake = makeFakeHeadless(baseOptions({
    writtenFiles: {},
    clockifyEntries: [{ description: `[${OTHER_TICKET}] older entry`, start: iso(at(9, 0)), end: iso(at(9, 30)) }]
  }))
  return Effect.gen(function*() {
    yield* TestClock.setTime(HISTORICAL_NOW)
    const failure = yield* Effect.flip(readPlan)
    expect(failure.message).toContain("manual review")
    expect(fake.world.createdClockifyEntries).toEqual([])
    expect(fake.world.jiraWorklogs).toEqual([])
  }).pipe(Effect.provide(fake.layer))
})

it.effect("refuses an unbound editable source marker in an already reviewed window", () => {
  const source = SourceConsumption.marker(rowId(TICKET, DAY), at(10, 0))
  const fake = makeFakeHeadless(baseOptions({
    clockifyEntries: [{
      id: "unbound-entry",
      description: `[${OTHER_TICKET}] unrelated entry\n${source}`,
      start: iso(at(10, 0)),
      end: iso(at(11, 0))
    }]
  }))
  return Effect.gen(function*() {
    yield* TestClock.setTime(HISTORICAL_NOW)
    expect((yield* Effect.flip(readPlan)).message).toContain("manual review")
    expect(fake.world.createdClockifyEntries).toEqual([])
  }).pipe(Effect.provide(fake.layer))
})

it.effect("imports only provider-ID-backed legacy source suffixes on a first read", () => {
  const source = SourceConsumption.marker(rowId(TICKET, DAY), at(10, 0))
  const fake = makeFakeHeadless(baseOptions({
    writtenFiles: {},
    clockifyEntries: [{
      id: "legacy-clockify",
      description: `[${OTHER_TICKET}] prior confirmed work\n${source}`,
      start: iso(at(10, 0)),
      end: iso(at(11, 0))
    }],
    jiraWorklogs: {
      [OTHER_TICKET]: [{
        id: "legacy-jira",
        started: iso(at(10, 0)),
        timeSpentSeconds: 3600,
        comment: source
      }]
    }
  }))
  return Effect.gen(function*() {
    yield* TestClock.setTime(HISTORICAL_NOW)
    const plan = yield* readPlan
    expect(rowFor(plan, TICKET, DAY)?.proposal?.blocks[0]?.consumed).toEqual({ clockify: 3600, jira: 3600 })
    const stored = fake.world.writtenFiles[`${FAKE_HOME}/.jcf/source-consumption.v1.json`]
    expect(stored).toBeDefined()
    fake.world.setClockifyEntries([{
      id: "legacy-clockify",
      description: `[${OTHER_TICKET}] revised`,
      start: iso(at(10, 0)),
      end: iso(at(11, 0))
    }])
    fake.world.setJiraWorklogs({
      [OTHER_TICKET]: [{ id: "legacy-jira", started: iso(at(10, 0)), timeSpentSeconds: 3600, comment: "revised" }]
    })
    const revised = yield* readPlan
    expect(rowFor(revised, TICKET, DAY)?.proposal?.blocks[0]?.consumed).toEqual({ clockify: 3600, jira: 3600 })
    expect(fake.world.createdClockifyEntries).toEqual([])
    expect(fake.world.jiraWorklogs).toEqual([])
  }).pipe(Effect.provide(fake.layer))
})

it.effect("holds an uncertain provider create when its private receipt cannot be stored", () => {
  const ledgerPath = `${FAKE_HOME}/.jcf/source-consumption.v1.json`
  const unwritablePaths: Array<string> = []
  const fake = makeFakeHeadless(baseOptions({
    unwritablePaths,
    afterClockifyWrite: () => {
      unwritablePaths.push(ledgerPath)
    }
  }))
  return Effect.gen(function*() {
    yield* TestClock.setTime(HISTORICAL_NOW)
    const plan = yield* readPlan
    const first = yield* confirm(plan, { ticketKey: OTHER_TICKET })
    expect(first._tag).toBe("Written")
    if (first._tag === "Written") {
      expect(first.result.clockify).toMatchObject({ _tag: "Refused" })
      expect(first.result.lines.join(" ")).toContain("manual recovery required")
    }
    expect(fake.world.createdClockifyEntries).toHaveLength(1)
    expect(fake.world.jiraWorklogs).toHaveLength(0)
    expect((yield* Effect.flip(readPlan)).message).toContain("manual reconciliation")
    expect(fake.world.createdClockifyEntries).toHaveLength(1)
  }).pipe(Effect.provide(fake.layer))
})

it.effect("does not invent a missing Jira worklog ID or retry its uncertain success", () => {
  const fake = makeFakeHeadless(baseOptions({ jiraPostOmitsId: true }))
  return Effect.gen(function*() {
    yield* TestClock.setTime(HISTORICAL_NOW)
    const plan = yield* readJiraOnlyPlan
    const first = yield* confirm(plan, { ticketKey: OTHER_TICKET })
    expect(first._tag).toBe("Written")
    if (first._tag === "Written") {
      expect(first.result.jira).toMatchObject({ _tag: "Refused" })
      expect(first.result.lines.join(" ")).toContain("manual recovery required")
    }
    expect(fake.world.jiraWorklogs).toHaveLength(1)
    expect((yield* Effect.flip(readJiraOnlyPlan)).message).toContain("manual reconciliation")
    expect(fake.world.jiraWorklogs).toHaveLength(1)
  }).pipe(Effect.provide(fake.layer))
})

it.effect("never credits another account's durable Jira binding", () => {
  const first = makeFakeHeadless(baseOptions())
  return Effect.gen(function*() {
    yield* Effect.gen(function*() {
      yield* TestClock.setTime(HISTORICAL_NOW)
      expect(
        (yield* confirm(yield* readJiraOnlyPlan, {
          seconds: 1800,
          ticketKey: OTHER_TICKET
        }))._tag
      ).toBe("Written")
    }).pipe(Effect.provide(first.layer))
    const written = first.world.jiraWorklogs[0]!
    const otherAccount = makeFakeHeadless(baseOptions({
      jiraAccountId: "acct-other",
      writtenFiles: { ...first.world.writtenFiles },
      jiraWorklogs: {
        [OTHER_TICKET]: [{
          id: "wl-created-0",
          author: { accountId: FAKE_ACCOUNT_ID },
          started: written.started,
          timeSpentSeconds: written.timeSpentSeconds,
          comment: "edited"
        }]
      }
    }))
    yield* Effect.gen(function*() {
      yield* TestClock.setTime(HISTORICAL_NOW)
      const plan = yield* readJiraOnlyPlan
      expect(rowFor(plan, TICKET, DAY)?.proposal?.blocks[0]?.consumed.jira).toBe(0)
      expect(otherAccount.world.jiraWorklogs).toEqual([])
    }).pipe(Effect.provide(otherAccount.layer))
  })
})

it.effect("retains the durable receipt across a failed provider read", () => {
  const fake = makeFakeHeadless(baseOptions())
  return Effect.gen(function*() {
    yield* TestClock.setTime(HISTORICAL_NOW)
    expect((yield* confirm(yield* readPlan, { ticketKey: OTHER_TICKET }))._tag).toBe("Written")
    fake.world.jiraWorklogReadFailuresRemaining = 1
    expect((yield* Effect.result(readPlan))._tag).toBe("Failure")
    const recovered = yield* readPlan
    expect(rowFor(recovered, TICKET, DAY)?.proposal).toBeUndefined()
    expect(fake.world.createdClockifyEntries).toHaveLength(1)
    expect(fake.world.jiraWorklogs).toHaveLength(1)
  }).pipe(Effect.provide(fake.layer))
})

it.effect("withholds session writes when a Jira read lacks provider entry IDs", () => {
  const fake = makeFakeHeadless(baseOptions({
    jiraReadOmitsId: true,
    jiraWorklogs: { [OTHER_TICKET]: [{ started: iso(at(9, 0)), timeSpentSeconds: 600 }] }
  }))
  return Effect.gen(function*() {
    yield* TestClock.setTime(HISTORICAL_NOW)
    expect((yield* Effect.flip(readPlan)).message).toContain("without an ID")
    expect(fake.world.createdClockifyEntries).toEqual([])
    expect(fake.world.jiraWorklogs).toEqual([])
  }).pipe(Effect.provide(fake.layer))
})

it.effect("does not repeat a Jira write while JQL search has not indexed it", () => {
  const fake = makeFakeHeadless(baseOptions())
  return Effect.gen(function*() {
    yield* TestClock.setTime(HISTORICAL_NOW)
    const plan = yield* readJiraOnlyPlan
    const first = yield* confirm(plan)
    fake.world.jiraSearchHiddenIssues.add(TICKET)
    const repeated = yield* confirm(plan)

    expect(first._tag).toBe("Written")
    expect(repeated._tag).toBe("NothingOwed")
    expect(fake.world.jiraWorklogs).toHaveLength(1)
  }).pipe(Effect.provide(fake.layer))
})

it.effect("does not repeat a corrected Jira write while JQL search has not indexed its target", () => {
  const fake = makeFakeHeadless(baseOptions())
  return Effect.gen(function*() {
    yield* TestClock.setTime(HISTORICAL_NOW)
    const plan = yield* readJiraOnlyPlan
    const first = yield* confirm(plan, { ticketKey: OTHER_TICKET })
    fake.world.jiraSearchHiddenIssues.add(OTHER_TICKET)
    const repeated = yield* confirm(plan)

    expect(first._tag).toBe("Written")
    expect(repeated._tag).toBe("NothingOwed")
    expect(fake.world.jiraWorklogs).toHaveLength(1)
  }).pipe(Effect.provide(fake.layer))
})

it.effect("reopens Jira evidence after a direct issue read verifies deletion", () => {
  const fake = makeFakeHeadless(baseOptions({ jiraWorklogPageSize: 1 }))
  return Effect.gen(function*() {
    yield* TestClock.setTime(HISTORICAL_NOW)
    const plan = yield* readJiraOnlyPlan
    const first = yield* confirm(plan)
    const ledgerPath = `${FAKE_HOME}/.jcf/source-consumption.v1.json`
    const firstStored = yield* Schema.decodeUnknownEffect(StoredConsumption)(fake.world.writtenFiles[ledgerPath])
    const firstEntryId = firstStored.bindings.find((binding) => binding.provider === "jira")?.entryId
    fake.world.jiraSearchHiddenIssues.add(TICKET)
    const written = fake.world.jiraWorklogs[0]!
    fake.world.setJiraWorklogs({
      [TICKET]: [
        { id: "unrelated-1", author: { accountId: "acct-other" }, started: written.started, timeSpentSeconds: 900 },
        { id: "unrelated-2", author: { accountId: "acct-other" }, started: written.started, timeSpentSeconds: 900 }
      ]
    })
    const replacement = yield* confirm(plan)

    expect(first._tag).toBe("Written")
    if (first._tag === "Written") {
      expect(first.result.jira).toMatchObject({ _tag: "Written", seconds: 3900 })
      expect(first.result.clockify).toMatchObject({ _tag: "Skipped" })
    }
    expect(replacement._tag).toBe("Written")
    if (replacement._tag === "Written") {
      expect(replacement.result.jira).toMatchObject({ _tag: "Written", seconds: 3900 })
      expect(replacement.result.clockify).toMatchObject({ _tag: "Skipped" })
    }
    expect(fake.world.jiraWorklogs).toHaveLength(2)
    const stored = yield* Schema.decodeUnknownEffect(StoredConsumption)(fake.world.writtenFiles[ledgerPath])
    expect(stored.pending).toEqual([])
    const jiraBindings = stored.bindings.filter((binding) => binding.provider === "jira")
    expect(jiraBindings.map((binding) => binding.seconds)).toEqual([3900, 3900])
    expect(new Set(jiraBindings.map((binding) => binding.entryId)).size).toBe(2)
    expect(jiraBindings[0]?.entryId).toBe(firstEntryId)
    expect((yield* confirm(plan))._tag).toBe("NothingOwed")
    expect(fake.world.jiraWorklogs).toHaveLength(2)
  }).pipe(Effect.provide(fake.layer))
})

it.effect("does not reuse an injected Jira ID after replacing the fake world", () => {
  const fake = makeFakeHeadless(baseOptions())
  fake.world.setJiraWorklogs({
    [OTHER_TICKET]: [{ id: "wl-created-0", started: iso(at(9, 0)), timeSpentSeconds: 600 }]
  })
  fake.world.setJiraWorklogs({})
  return Effect.gen(function*() {
    yield* TestClock.setTime(HISTORICAL_NOW)
    const result = yield* confirm(yield* readJiraOnlyPlan)
    expect(result._tag).toBe("Written")
    if (result._tag === "Written") {
      expect(result.result.jira).toMatchObject({ _tag: "Written", seconds: 3900 })
    }
    const stored = yield* Schema.decodeUnknownEffect(StoredConsumption)(
      fake.world.writtenFiles[`${FAKE_HOME}/.jcf/source-consumption.v1.json`]
    )
    expect(stored.pending).toEqual([])
    expect(stored.bindings.find((binding) => binding.provider === "jira")?.entryId).toBe("wl-created-1")
  }).pipe(Effect.provide(fake.layer))
})

it.effect("keeps corrected consumption when overlapping work reschedules the rendered block", () => {
  const fake = makeFakeHeadless(baseOptions({
    transcripts: {
      "repo/session-b.jsonl": transcript({
        branch: `feature/${OTHER_TICKET}`,
        minutes: 60,
        sessionId: "session-b",
        startMs: at(10, 0)
      })
    }
  }))
  return Effect.gen(function*() {
    const first = yield* readPlan
    const originalBlock = rowFor(first, OTHER_TICKET, DAY)?.proposal?.blocks[0]
    expect(originalBlock).toBeDefined()
    yield* confirm(first, { rowId: rowId(OTHER_TICKET, DAY), ticketKey: "PROJ-9002" })

    fake.world.transcripts["repo/session-a.jsonl"] = transcript({
      branch: `feature/${TICKET}-otel`,
      minutes: 120,
      sessionId: "session-a",
      startMs: at(10, 0)
    })
    fake.world.transcripts["repo/session-b.jsonl"] = transcript({
      branch: `feature/${OTHER_TICKET}`,
      minutes: 120,
      sessionId: "session-b",
      startMs: at(10, 0)
    })
    const grown = yield* readPlan
    const proposal = rowFor(grown, OTHER_TICKET, DAY)?.proposal
    expect(proposal?.blocks[0]?.startMs).not.toBe(originalBlock?.startMs)
    yield* confirm(grown, { rowId: rowId(OTHER_TICKET, DAY) })

    const clockifySeconds = fake.world.createdClockifyEntries.reduce(
      (sum, entry) => sum + (new Date(entry.end ?? entry.start).getTime() - new Date(entry.start).getTime()) / 1000,
      0
    )
    const jiraSeconds = fake.world.jiraWorklogs.reduce((sum, entry) => sum + entry.timeSpentSeconds, 0)
    expect(clockifySeconds).toBe(proposal?.maxSeconds)
    expect(jiraSeconds).toBe(proposal?.maxSeconds)
  }).pipe(Effect.provide(fake.layer))
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

  it.effect("does not ask Jira for titles when only Clockify is selected", () =>
    Effect.gen(function*() {
      let summaryCalls = 0
      const summaryOf = () =>
        Effect.sync(() => {
          summaryCalls++
          return "Title from Jira"
        })
      const { world } = yield* run(
        Effect.gen(function*() {
          const reconcile = yield* ReconcileService.ReconcileService
          const plan = yield* readClockifyOnlyPlan
          yield* confirmProposal({
            plan,
            request: {
              blocks: undefined,
              note: undefined,
              rowId: rowId(TICKET, DAY),
              seconds: undefined,
              targets: undefined,
              ticketKey: undefined
            },
            service: reconcile,
            summaryOf
          })
          yield* logManualEntry({
            request: {
              day: DAY,
              note: undefined,
              seconds: 1800,
              startClock: "14:00",
              targets: { clockify: true, jira: false },
              ticketKey: OTHER_TICKET
            },
            service: reconcile,
            summaryOf
          })
        }),
        {}
      )

      expect(summaryCalls).toBe(0)
      expect(world.createdClockifyEntries).toHaveLength(2)
      expect(world.jiraWorklogs).toEqual([])
    }))

  it.effect("looks up a title for a manual write that includes Jira", () =>
    Effect.gen(function*() {
      let summaryCalls = 0
      yield* run(
        Effect.gen(function*() {
          const reconcile = yield* ReconcileService.ReconcileService
          yield* logManualEntry({
            request: {
              day: DAY,
              note: undefined,
              seconds: 1800,
              startClock: "14:00",
              targets: { clockify: true, jira: true },
              ticketKey: OTHER_TICKET
            },
            service: reconcile,
            summaryOf: () =>
              Effect.sync(() => {
                summaryCalls++
                return "Title from Jira"
              })
          })
        }),
        {}
      )
      expect(summaryCalls).toBe(1)
    }))
})

describe("refreshing recorded time from held evidence", () => {
  it.effect("keeps the unpaid side after a partial write without reopening any transcript", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.gen(function*() {
          const reconcile = yield* ReconcileService.ReconcileService
          const plan = yield* readPlan
          yield* confirm(plan)
          const refreshed = yield* reconcile.refreshRecordedTime(Time.isoWeekPeriod(new Date(at(12, 0))), plan.report)
          return { refreshed, credited: plan.report.attributed[0]?.seconds }
        }),
        { jiraLoggedIn: false }
      )
      expect(world.createdClockifyEntries).toHaveLength(1)
      expect(world.jiraWorklogs).toHaveLength(0)
      expect(world.transcriptReads).toHaveLength(1)
      expect(value.refreshed.proposals).toHaveLength(1)
      expect(value.refreshed.proposals[0]).toMatchObject({ clockifyDelta: 0, jiraDelta: value.credited })
    }))

  it.effect("retains evidence while a running Clockify timer still withholds the day", () =>
    Effect.gen(function*() {
      const { value, world } = yield* run(
        Effect.gen(function*() {
          const reconcile = yield* ReconcileService.ReconcileService
          const plan = yield* readPlan
          return yield* reconcile.refreshRecordedTime(Time.isoWeekPeriod(new Date(at(12, 0))), plan.report)
        }),
        { runningTimer: { description: `[${TICKET}] Running work`, start: iso(at(9, 0)) } }
      )
      expect(value.attributed.length).toBeGreaterThan(0)
      expect(value.proposals).toEqual([])
      expect(value.excludedDays.some((day) => day.day === DAY)).toBe(true)
      expect(world.transcriptReads).toHaveLength(1)
    }))
})

// This is the reported failure: an overlapping suggestion looked longer than the entry it wrote.
it.effect("accepting an allocated overlap writes the exact interval drawn by the calendar", () =>
  Effect.gen(function*() {
    const { value, world } = yield* run(
      Effect.gen(function*() {
        const plan = yield* readPlan
        const block = rowFor(plan, TICKET, DAY)?.proposal?.blocks[0]
        return { block, outcome: yield* confirm(plan, { blocks: [0] }) }
      }),
      {
        transcripts: {
          "repo/parallel.jsonl": transcript({
            branch: `feature/${OTHER_TICKET}`,
            minutes: 60,
            sessionId: "parallel",
            startMs: at(10, 0)
          })
        }
      }
    )
    expect(value.outcome._tag).toBe("Written")
    expect(value.block).toBeDefined()
    const block = value.block
    if (block === undefined) return
    expect(block.endMs - block.startMs).toBe(block.seconds * 1000)
    expect(world.createdClockifyEntries).toHaveLength(1)
    expect(world.createdClockifyEntries[0]?.start).toBe(iso(block.startMs))
    expect(world.createdClockifyEntries[0]?.end).toBe(iso(block.endMs))
    expect(world.jiraWorklogs[0]?.timeSpentSeconds).toBe(block.seconds)
    expect(new Date(world.jiraWorklogs[0]?.started ?? "").getTime()).toBe(block.startMs)
  }))
