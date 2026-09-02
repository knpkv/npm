/**
 * `jcf watch claude`, both halves: the pure settle rule and the command end to end.
 *
 * The command tests run on the TestClock, which is the only way to assert a watch at all — the
 * behaviour under test is "what does it do over the next forty minutes", and a suite that waited
 * for forty minutes would never be run.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { TestClock } from "effect/testing"
import { Command } from "effect/unstable/cli"
import type { SessionProposal } from "../src/agent/sessions.js"
import { decideWatchWrites, SETTLE_GRACE_SECONDS, settlesAt } from "../src/agent/watch.js"
import { writeAnchor } from "../src/cli/agentWrite.js"
import { root } from "../src/cli/root.js"
import { FAKE_HOME, type FakeHeadlessOptions, makeFakeHeadless } from "./fakeHeadless.js"

// A test case is its own entry point: it composes exactly the layers that case needs and
// provides them there. Both provide diagnostics are about production wiring, where a Layer
// provided mid-graph can cut a scope short.
// @effect-diagnostics strictEffectProvide:off
// @effect-diagnostics multipleEffectProvide:off

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORK_ROOT = `${FAKE_HOME}/dev/work`
const IDLE_CAP = 300
/**
 * How long after a block's own end it becomes writable. Only the transcript grace: the block already
 * runs one Idle Cap past its last prompt.
 */
const SETTLE = SETTLE_GRACE_SECONDS

/** Local components, so a day boundary is a local midnight wherever this suite runs. */
const at = (hour: number, minute: number): number => new Date(2026, 6, 1, hour, minute, 0, 0).getTime()

const iso = (atMs: number): string => new Date(atMs).toISOString()

/** A transcript of human prompts one minute apart, so no gap ever reaches the Idle Cap. */
const transcript = (options: {
  readonly sessionId: string
  readonly cwd: string
  readonly gitBranch?: string | null | undefined
  readonly from: number
  readonly minutes: number
  readonly text?: string | undefined
}): string =>
  Array.from({ length: options.minutes + 1 }, (_, index) =>
    JSON.stringify({
      type: "user",
      sessionId: options.sessionId,
      timestamp: iso(options.from + index * 60_000),
      cwd: options.cwd,
      gitBranch: options.gitBranch ?? null,
      uuid: `${options.sessionId}-${index}`,
      message: { role: "user", content: index === 0 ? options.text ?? "working" : "working" }
    })).join("\n")

const baseOptions = (overrides: FakeHeadlessOptions = {}): FakeHeadlessOptions => ({
  ...overrides,
  config: { sessionRoots: [WORK_ROOT], sessionIdleCapSeconds: IDLE_CAP, ...overrides.config }
})

/**
 * Hand control to the watch fiber until it is waiting on the clock again.
 *
 * The fake boundaries yield cooperatively rather than sleeping, so a tick completes in some number
 * of microtasks, not in any amount of simulated time. Advancing the clock before the fiber has
 * reached its next `Effect.sleep` would skip a tick outright.
 */
const breathe = Effect.gen(function*() {
  for (let index = 0; index < 200; index++) yield* Effect.yieldNow
})

const advance = (duration: Duration.Input) =>
  breathe.pipe(Effect.andThen(TestClock.adjust(duration)), Effect.andThen(breathe))

/**
 * Start a watch at `startMs` and hand back the fiber and the world it is writing into.
 *
 * Forked rather than run: the command under test never returns on its own, which is the whole point
 * of it. Every assertion is made against the world while it is still running.
 */
const startWatch = (options: {
  readonly startMs: number
  readonly args?: ReadonlyArray<string> | undefined
  readonly fake: FakeHeadlessOptions
}) =>
  Effect.gen(function*() {
    const fake = makeFakeHeadless(options.fake)
    yield* TestClock.setTime(options.startMs)
    const fiber = yield* Command.runWith(root, { version: "0.0.0-test" })([
      "watch",
      "claude",
      ...(options.args ?? [])
    ]).pipe(
      Effect.provide(fake.layer),
      Effect.exit,
      Effect.forkChild
    )
    yield* breathe
    return { fiber, world: fake.world }
  })

const output = (lines: ReadonlyArray<string>): string => lines.join("\n")

// ---------------------------------------------------------------------------
// The settle rule
// ---------------------------------------------------------------------------

const proposal = (overrides: Partial<SessionProposal> = {}): SessionProposal => ({
  ticketKey: "PROJ-1",
  day: "2026-07-01",
  signal: "branch",
  confidence: null,
  spans: [{ startMs: at(10, 0), endMs: at(10, 30) }],
  sessionSeconds: 1_800,
  activeSeconds: 1_800,
  clockifySeconds: 0,
  jiraSeconds: 0,
  clockifyDelta: 1_800,
  jiraDelta: 1_800,
  sessionIds: ["s1"],
  ...overrides
})

describe("decideWatchWrites", () => {
  // Measured from the block's own end, which already carries the Idle Cap. The grace on top is for
  // transcript-write latency, not for the arithmetic.
  it("settles a block one grace after its end", () => {
    expect(settlesAt([{ startMs: at(10, 0), endMs: at(10, 30) }])).toBe(at(10, 30) + SETTLE_GRACE_SECONDS * 1000)
  })

  // The deadline the command advertises at startup. It was counting the Idle Cap twice — once in the
  // block's own end, once again here — so a block promised after six quiet minutes was withheld for
  // eleven.
  it("makes a block writable exactly one Idle Cap and one grace after its final prompt", () => {
    const finalPrompt = at(10, 30)
    // The block already runs to `finalPrompt + Idle Cap`, which is what a materialised tail means.
    const spans = [{ startMs: at(10, 0), endMs: finalPrompt + IDLE_CAP * 1000 }]
    expect(settlesAt(spans)).toBe(finalPrompt + (IDLE_CAP + SETTLE_GRACE_SECONDS) * 1000)
  })

  it("holds a block that is still warm, and writes it once it is not", () => {
    const row = proposal()
    const oneEarly = decideWatchWrites([row], { nowMs: at(10, 30) + SETTLE * 1000 - 1 })
    expect(oneEarly.write).toEqual([])
    expect(oneEarly.held[0]?.reason).toEqual({ _tag: "Unsettled", settlesAtMs: at(10, 30) + SETTLE * 1000 })

    const onTime = decideWatchWrites([row], { nowMs: at(10, 30) + SETTLE * 1000 })
    expect(onTime.write).toEqual([row])
    expect(onTime.held).toEqual([])
  })

  // Judged on the *latest* block, not the earliest: a ticket returned to after lunch is not final
  // just because the morning was. The morning is already written by then, and what follows is the
  // remainder, because proposals subtract what the two sides already hold.
  it("holds a whole bucket while any of its blocks is still warm", () => {
    const row = proposal({
      spans: [{ startMs: at(9, 0), endMs: at(9, 30) }, { startMs: at(13, 0), endMs: at(13, 30) }]
    })
    const decision = decideWatchWrites([row], { nowMs: at(13, 10) })
    expect(decision.write).toEqual([])
    expect(decision.held[0]?.reason._tag).toBe("Unsettled")
  })

  // A backstop rather than an expected path: the command asks for deterministic attribution, so a
  // Coding Agent's guess never reaches this function. If one ever did, it must be reported for
  // review rather than written by a command nobody is watching.
  it("never writes an attribution a Coding Agent had to guess at", () => {
    const decision = decideWatchWrites([proposal({ signal: "agent", confidence: 0.9 })], { nowMs: at(20, 0) })
    expect(decision.write).toEqual([])
    expect(decision.held[0]?.reason).toEqual({ _tag: "NeedsReview" })
  })

  it("writes path- and standing-attributed work, which a person also created deliberately", () => {
    const rows = [proposal({ signal: "path" }), proposal({ signal: "standing" })]
    const decision = decideWatchWrites(rows, { nowMs: at(20, 0) })
    expect(decision.write).toEqual(rows)
  })
})

describe("writeAnchor", () => {
  const morning = { startMs: at(9, 0), endMs: at(9, 30) }
  const afternoon = { startMs: at(14, 0), endMs: at(14, 30) }

  it("anchors the first write to the first block", () => {
    expect(writeAnchor([morning, afternoon], 0)).toEqual(new Date(at(9, 0)))
  })

  // The bug this exists for: a watch writes the morning when it settles, then the afternoon as its
  // own write against the same bucket. Anchored at the bucket's first instant, the afternoon's hours
  // land at 09:00 — a second Clockify entry laid over the first, and a Jira worklog dated to work
  // that had not started yet.
  it("anchors the next write past the blocks that side already holds", () => {
    expect(writeAnchor([morning, afternoon], 1_800)).toEqual(new Date(at(14, 0)))
  })

  it("anchors inside a block that is only partly recorded", () => {
    expect(writeAnchor([morning, afternoon], 600)).toEqual(new Date(at(9, 10)))
  })
})

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

describe("jcf watch: usage", () => {
  it.effect("rejects an agent it cannot read", () =>
    Effect.gen(function*() {
      const fake = makeFakeHeadless(baseOptions())
      const exit = yield* Command.runWith(root, { version: "0.0.0-test" })(["watch", "codex"]).pipe(
        Effect.exit,
        Effect.provide(fake.layer)
      )
      expect(exit._tag).toBe("Failure")
      expect(output(fake.world.stderr)).toContain(`Unsupported agent "codex"`)
    }))

  it.effect("says what to configure when nothing is opted in", () =>
    Effect.gen(function*() {
      const fake = makeFakeHeadless({ config: { sessionRoots: [] } })
      yield* Command.runWith(root, { version: "0.0.0-test" })(["watch", "claude"]).pipe(
        Effect.exit,
        Effect.provide(fake.layer)
      )
      expect(output(fake.world.stdout)).toContain("jcf config set session-root")
      expect(fake.world.createdClockifyEntries).toEqual([])
    }))
})

describe("jcf watch claude", () => {
  const branchWork = (overrides: FakeHeadlessOptions = {}) =>
    baseOptions({
      transcripts: {
        "work/session-a.jsonl": transcript({
          sessionId: "session-a",
          cwd: `${WORK_ROOT}/repo`,
          gitBranch: "feature/PROJ-1",
          from: at(10, 1),
          minutes: 10,
          text: "Add spans to the ingest worker"
        })
      },
      issueSummaries: { "PROJ-1": "Add OpenTelemetry spans to the ingest worker" },
      describer: () => "Traced the ingest worker end to end",
      ...overrides
    })

  // The core promise: a block is not written while it might still grow, and once written it is not
  // written again. The second half is what the subtraction buys — no ledger, no persisted decision.
  it.effect("writes a block once it has settled, and never a second time", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({ startMs: at(10, 0), fake: branchWork() })

      // 10:05 and 10:10: the session is still being worked in, so there is nothing final to write.
      yield* advance(Duration.minutes(5))
      yield* advance(Duration.minutes(5))
      expect(world.createdClockifyEntries).toEqual([])

      // Last prompt at 10:11. Its own capped window runs to 10:16, so the block settles at 10:22
      // and is written on the 10:25 tick.
      yield* advance(Duration.minutes(5))
      expect(world.createdClockifyEntries).toEqual([])
      yield* advance(Duration.minutes(10))

      expect(world.createdClockifyEntries).toHaveLength(1)
      expect(world.jiraWorklogs).toHaveLength(1)
      expect(world.jiraWorklogs[0]?.timeSpentSeconds).toBe(600 + IDLE_CAP)

      // Two more ticks over the same evidence: the sides now hold it, so the gap is zero.
      yield* advance(Duration.minutes(5))
      yield* advance(Duration.minutes(5))
      expect(world.createdClockifyEntries).toHaveLength(1)
      expect(world.jiraWorklogs).toHaveLength(1)

      yield* Fiber.interrupt(fiber)
      expect(output(world.stdout)).toContain("Wrote 1 block(s)")
    }))

  // The entry has to say what the time went on, in both systems, because that is the question asked
  // of a timesheet line months later — by which point the Issue Key is a lookup and the session is
  // gone.
  it.effect("writes the issue title and a sentence about the work to both sides", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({ startMs: at(10, 0), fake: branchWork() })
      yield* advance(Duration.minutes(30))
      yield* Fiber.interrupt(fiber)

      const description = world.createdClockifyEntries[0]?.description ?? ""
      expect(description).toContain("[PROJ-1]")
      expect(description).toContain("Add OpenTelemetry spans to the ingest worker")
      expect(description).toContain("Traced the ingest worker end to end")
      expect(world.jiraWorklogs[0]?.comment).toContain("Traced the ingest worker end to end")
      // Printed before it was written: this text lands where other people read it.
      expect(output(world.stdout)).toContain("Traced the ingest worker end to end")
    }))

  // Attribution is the expensive question and its answer never changes, so a watch must not keep
  // asking it. Descriptions are the only thing a Coding Agent is woken for, and only per write.
  it.effect("never wakes a Coding Agent to attribute, only to describe", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({ startMs: at(10, 0), fake: branchWork() })
      yield* advance(Duration.minutes(40))
      yield* Fiber.interrupt(fiber)

      expect(world.attributorBatches).toEqual([])
      expect(world.describeBatches).toHaveLength(1)
    }))

  it.effect("reports what it writes without writing it under --dry-run", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({
        startMs: at(10, 0),
        args: ["--dry-run"],
        fake: branchWork()
      })
      yield* advance(Duration.minutes(30))
      yield* Fiber.interrupt(fiber)

      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toEqual([])
      const printed = output(world.stdout)
      expect(printed).toContain("dry run")
      expect(printed).toContain("Traced the ingest worker end to end")
    }))

  // A dry run writes nothing, so a settled row stays settled and would be described again on every
  // tick — hundreds of paid calls for one unchanging preview if left running overnight.
  it.effect("describes an unchanged dry-run row once, however long it runs", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({
        startMs: at(10, 0),
        args: ["--dry-run"],
        fake: branchWork()
      })
      yield* advance(Duration.minutes(30))
      expect(world.describeBatches).toHaveLength(1)

      // Four more looks over evidence that has not changed.
      yield* advance(Duration.minutes(20))
      yield* Fiber.interrupt(fiber)

      expect(world.describeBatches).toHaveLength(1)
      const previews = world.stdout.filter((line) => line.includes("dry run — not written"))
      expect(previews).toHaveLength(1)
    }))

  // Time no deliberate signal places is left for `reconcile`, where it is shown before it is
  // written — but it is said out loud, because hours that silently fail to be logged are the exact
  // failure this feature exists to prevent. Once, not once per tick.
  it.effect("names time it will not place, once, and writes none of it", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({
        startMs: at(10, 0),
        fake: baseOptions({
          transcripts: {
            "work/session-b.jsonl": transcript({
              sessionId: "session-b",
              cwd: `${WORK_ROOT}/scratch`,
              gitBranch: "main",
              from: at(10, 1),
              minutes: 10,
              text: "Look at PROJ-9 and PROJ-8 and decide"
            })
          }
        })
      })
      yield* advance(Duration.minutes(30))
      yield* Fiber.interrupt(fiber)

      expect(world.createdClockifyEntries).toEqual([])
      expect(world.attributorBatches).toEqual([])
      const said = world.stdout.filter((line) => line.includes("no branch, path, or standing rule places"))
      expect(said).toHaveLength(1)
      expect(said[0]).toContain("jcf sync reconcile --agent claude")
    }))

  // A running Timer has no end time, so its hours are invisible to the tally. Writing over that day
  // would log them a second time the moment the Timer stops.
  it.effect("writes nothing on a day a Clockify timer is still running", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({
        startMs: at(10, 0),
        fake: branchWork({ runningTimer: { description: "[PROJ-1] in progress", start: iso(at(9, 0)) } })
      })
      yield* advance(Duration.minutes(30))
      yield* Fiber.interrupt(fiber)

      expect(world.createdClockifyEntries).toEqual([])
      const skipped = world.stdout.filter((line) => line.includes("timer is still running"))
      expect(skipped).toHaveLength(1)
    }))

  // Every later Jira write would fail the same way, and a watch that logs to Clockify alone all
  // afternoon quietly recreates the discrepancy this tool exists to close.
  it.effect("stops when Jira will not take a worklog", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({
        startMs: at(10, 0),
        fake: branchWork({ jiraLoggedIn: false })
      })
      yield* advance(Duration.minutes(30))
      const exit = yield* Fiber.join(fiber)

      expect(exit._tag).toBe("Success")
      expect(world.jiraWorklogs).toEqual([])
      const printed = output(world.stdout)
      expect(printed).toContain("Stopped:")
      // The real command is nested under `auth jira`; the watch used to print one that does not exist.
      expect(printed).toContain("jcf auth jira login")
      // The Clockify half landed and the Jira half did not, and the summary has to say exactly
      // that. For a command whose whole purpose is making sure hours are not lost, overstating what
      // was written is the wrong direction to be wrong in.
      expect(world.createdClockifyEntries).toHaveLength(1)
      expect(printed).toContain("Wrote 1 block(s): Clockify 15m 0s, Jira 0s")
    }))

  // The Jira half landed and the Clockify half did not. Both numbers have to say so independently:
  // a single "wrote it" boolean would have credited the Clockify side too.
  it.effect("counts only the side that took the write when Clockify refuses", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({
        startMs: at(10, 0),
        fake: branchWork({ clockifyWritesFail: true })
      })
      yield* advance(Duration.minutes(30))
      yield* Fiber.interrupt(fiber)

      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toHaveLength(1)
      expect(output(world.stdout)).toContain("Wrote 1 block(s): Clockify 0s, Jira 15m 0s")
    }))

  // A day is written block by block, so the second write has to say when its *own* block was —
  // otherwise it lands on top of the first as an overlapping Clockify entry and a Jira worklog dated
  // to work that had not started yet. Overlapping entries are what a timesheet audit flags first.
  it.effect("anchors a second block on the same ticket to that block, not the first", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({ startMs: at(10, 0), fake: branchWork() })
      yield* advance(Duration.minutes(30))
      expect(world.createdClockifyEntries).toHaveLength(1)

      // Same session, same ticket, resuming after a break longer than the Idle Cap.
      world.transcripts["work/session-a.jsonl"] += "\n" + transcript({
        sessionId: "session-a",
        cwd: `${WORK_ROOT}/repo`,
        gitBranch: "feature/PROJ-1",
        from: at(11, 0),
        minutes: 10
      })

      // Last prompt at 11:10, so this block settles at 11:16 and is written on the 11:20 tick.
      yield* advance(Duration.minutes(60))
      yield* Fiber.interrupt(fiber)

      expect(world.createdClockifyEntries).toHaveLength(2)
      const [first, second] = world.createdClockifyEntries
      expect(first?.start).toBe(new Date(at(10, 1)).toISOString())
      // The invariant, rather than an exact clock time: the second entry begins no earlier than the
      // first one ends. Anchoring both at the bucket's first instant put them on top of each other.
      expect(new Date(second?.start ?? 0).getTime()).toBeGreaterThanOrEqual(new Date(first?.end ?? 0).getTime())
      expect(new Date(world.jiraWorklogs[1]?.started ?? 0).getTime())
        .toBeGreaterThanOrEqual(new Date(first?.end ?? 0).getTime())
    }))

  // The settle rule's whole claim is that a written block can never be revised. Before the trailing
  // window was materialised, a session's final prompt produced nothing until a *later* prompt
  // arrived — and that late prompt then created a window retroactively, overlapping a block already
  // written and halving its share while the new share was written too. Two tickets, more time
  // between them than the clock has.
  it.effect("never lets a late prompt push the day's writes past the clock", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({
        startMs: at(10, 0),
        fake: baseOptions({
          transcripts: {
            "work/a.jsonl": transcript({
              sessionId: "session-a",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feature/PROJ-1",
              from: at(10, 1),
              minutes: 10
            }),
            // One prompt inside A's block, its follow-up hours later. That follow-up used to
            // conjure B's window after A had already been written.
            "work/b.jsonl": transcript({
              sessionId: "session-b",
              cwd: `${WORK_ROOT}/other`,
              gitBranch: "feature/PROJ-2",
              from: at(10, 8),
              minutes: 0
            })
          },
          issueSummaries: { "PROJ-1": "First", "PROJ-2": "Second" }
        })
      })
      yield* advance(Duration.minutes(30))

      world.transcripts["work/b.jsonl"] += "\n" + transcript({
        sessionId: "session-b",
        cwd: `${WORK_ROOT}/other`,
        gitBranch: "feature/PROJ-2",
        from: at(13, 0),
        minutes: 5
      })
      yield* advance(Duration.minutes(240))
      yield* Fiber.interrupt(fiber)

      // Presence runs 10:01 to one Idle Cap past 13:05. Nothing may sum past that.
      const union = (at(13, 5) + IDLE_CAP * 1000 - at(10, 1)) / 1000
      const written = world.jiraWorklogs.reduce((sum, worklog) => sum + worklog.timeSpentSeconds, 0)
      expect(written).toBeLessThanOrEqual(union)
      expect(written).toBeGreaterThan(0)
    }))

  // A session started after the watch is exactly the case the whole command is for.
  it.effect("picks up a session that only starts after it is already running", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({ startMs: at(10, 0), fake: branchWork() })
      yield* advance(Duration.minutes(30))
      expect(world.createdClockifyEntries).toHaveLength(1)

      world.transcripts["work/session-c.jsonl"] = transcript({
        sessionId: "session-c",
        cwd: `${WORK_ROOT}/repo`,
        gitBranch: "bugfix/PROJ-2",
        from: at(10, 30),
        minutes: 8,
        text: "Fix the 400 on the accounts fetch"
      })

      // Last prompt at 10:38, so this block settles at 10:44 and is written on the 10:45 tick.
      yield* advance(Duration.minutes(30))
      yield* Fiber.interrupt(fiber)

      expect(world.createdClockifyEntries).toHaveLength(2)
      expect(world.createdClockifyEntries[1]?.description).toContain("[PROJ-2]")
      expect(world.jiraWorklogs[1]?.timeSpentSeconds).toBe(480 + IDLE_CAP)
    }))

  // Subtracting what the sides hold makes a *later* tick safe and says nothing about a simultaneous
  // one: two watches can read the same gap before either writes it, and an accidental second
  // terminal is enough to double a day.
  it.effect("refuses to run beside another watch, so the same hours are not written twice", () =>
    Effect.gen(function*() {
      const fake = makeFakeHeadless(branchWork())
      yield* TestClock.setTime(at(10, 0))
      const run = () =>
        Command.runWith(root, { version: "0.0.0-test" })(["watch", "claude"]).pipe(
          Effect.provide(fake.layer),
          Effect.exit,
          Effect.forkChild
        )

      const first = yield* run()
      yield* breathe
      const second = yield* run()
      yield* breathe

      expect(output(fake.world.stdout)).toContain("Two would write the same hours twice")
      yield* advance(Duration.minutes(30))
      yield* Fiber.interrupt(first)
      yield* Fiber.interrupt(second)

      // One writer, one entry — not two.
      expect(fake.world.createdClockifyEntries).toHaveLength(1)
      expect(fake.world.jiraWorklogs).toHaveLength(1)
    }))

  // The lease is stood down rather than deleted — the cursor in it is what makes a resume legitimate.
  // What matters is that the next watch can take it at once instead of waiting out the stale window.
  it.effect("stands the lease down when it stops, so the next watch starts at once", () =>
    Effect.gen(function*() {
      const fake = makeFakeHeadless(branchWork())
      yield* TestClock.setTime(at(10, 0))
      const start = () =>
        Command.runWith(root, { version: "0.0.0-test" })(["watch", "claude"]).pipe(
          Effect.provide(fake.layer),
          Effect.exit,
          Effect.forkChild
        )

      const first = yield* start()
      yield* breathe
      yield* Fiber.interrupt(first)
      yield* breathe

      const second = yield* start()
      yield* breathe
      expect(output(fake.world.stdout)).not.toContain("Two would write the same hours twice")
      yield* Fiber.interrupt(second)
    }))

  // The resume is only ever as far as a previous run got. A first-ever watch has no cursor and so no
  // reach at all — otherwise every start would quietly back-date a settle window of unreviewed work,
  // which is not what the README, the skills, CONTEXT.md or ADR-0007 say this command does.
  it.effect("writes nothing from before a first-ever start", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({ startMs: at(10, 30), fake: branchWork() })
      // The whole fixture block (10:01-10:11) settled well before this run began.
      yield* advance(Duration.minutes(30))
      yield* Fiber.interrupt(fiber)

      expect(world.createdClockifyEntries).toEqual([])
      expect(output(world.stdout)).toContain("Wrote nothing this run.")
    }))

  // A restart used to drop an in-flight block entirely. The window now opens one settle period
  // before the run starts — the stretch no watch can have written yet — so the tail is recovered.
  // What is older than that window is not lost either, just no longer the watch's: `reconcile`
  // proposes whatever the sides are still short of.
  it.effect("recovers the unsettled tail of a block interrupted by a restart", () =>
    Effect.gen(function*() {
      // One world across both runs: the lease the first leaves behind is what the second resumes from.
      const fake = makeFakeHeadless(branchWork())
      const start = () =>
        Command.runWith(root, { version: "0.0.0-test" })(["watch", "claude"]).pipe(
          Effect.provide(fake.layer),
          Effect.exit,
          Effect.forkChild
        )

      yield* TestClock.setTime(at(10, 0))
      const first = yield* start()
      // Stopped before the 10:01-10:11 block could settle.
      yield* advance(Duration.minutes(8))
      yield* Fiber.interrupt(first)
      expect(fake.world.createdClockifyEntries).toEqual([])

      const second = yield* start()
      yield* advance(Duration.minutes(20))
      yield* Fiber.interrupt(second)

      // The whole block. The cursor records the earliest instant the first run had *not resolved* —
      // the held block's own start — rather than the moment it stopped, so resuming from it keeps
      // the prompts that made the block unsettled in the first place.
      expect(fake.world.createdClockifyEntries).toHaveLength(1)
      expect(fake.world.jiraWorklogs[0]?.timeSpentSeconds).toBe(600 + IDLE_CAP)
    }))

  // The cursor used to move past a settled block *before* the block was written. Jira refusing then
  // persisted a cursor past a row whose Jira half was missing, and the restart the message asks for
  // filtered out the very row it was telling the user to come back for.
  it.effect("keeps a half-written block behind the cursor, and finishes it on restart", () =>
    Effect.gen(function*() {
      // One world across both runs, so the second really does read the first one's lease.
      const fake = makeFakeHeadless(branchWork({ jiraLoggedIn: false }))
      const start = () =>
        Command.runWith(root, { version: "0.0.0-test" })(["watch", "claude"]).pipe(
          Effect.provide(fake.layer),
          Effect.exit,
          Effect.forkChild
        )

      yield* TestClock.setTime(at(10, 0))
      const first = yield* start()
      // Long enough for the 10:01-10:11 block to settle and be attempted.
      yield* advance(Duration.minutes(25))
      yield* Fiber.join(first)

      // Clockify took it; Jira refused, so the watch stopped and said to log in and come back.
      expect(fake.world.createdClockifyEntries).toHaveLength(1)
      expect(fake.world.jiraWorklogs).toEqual([])

      // The user does exactly that. The block is still inside the resumed window, so Jira's missing
      // half is offered again — and Clockify's is not, because the entry it holds is subtracted.
      fake.world.jiraLoggedIn = true
      const second = yield* start()
      yield* advance(Duration.minutes(10))
      yield* Fiber.interrupt(second)

      expect(fake.world.jiraWorklogs).toHaveLength(1)
      expect(fake.world.jiraWorklogs[0]?.timeSpentSeconds).toBe(600 + IDLE_CAP)
      // And the side that already had it did not take it twice.
      expect(fake.world.createdClockifyEntries).toHaveLength(1)
    }))

  // Nothing was written, so nothing was resolved. A dry run that moved the cursor let a real watch
  // started inside the resume window begin *after* blocks that only ever existed as a preview.
  it.effect("resolves nothing under --dry-run, so a real watch can still write the block", () =>
    Effect.gen(function*() {
      const fake = makeFakeHeadless(branchWork())
      const start = (args: ReadonlyArray<string>) =>
        Command.runWith(root, { version: "0.0.0-test" })(["watch", "claude", ...args]).pipe(
          Effect.provide(fake.layer),
          Effect.exit,
          Effect.forkChild
        )

      yield* TestClock.setTime(at(10, 0))
      const preview = yield* start(["--dry-run"])
      yield* advance(Duration.minutes(25))
      expect(fake.world.createdClockifyEntries).toEqual([])
      expect(output(fake.world.stdout)).toContain("dry run — not written")
      yield* Fiber.interrupt(preview)

      const real = yield* start([])
      yield* advance(Duration.minutes(10))
      yield* Fiber.interrupt(real)

      // The same block, written in full by the run that was allowed to write.
      expect(fake.world.createdClockifyEntries).toHaveLength(1)
      expect(fake.world.jiraWorklogs[0]?.timeSpentSeconds).toBe(600 + IDLE_CAP)
    }))

  // Failing to write the lease is not the same as losing the race for it. Treating the two alike let
  // the watch run with no lease on disk at all — the one state the lease exists to rule out.
  it.effect("refuses to start when it cannot write the lease", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({
        startMs: at(10, 0),
        fake: branchWork({ unwritablePaths: [`${FAKE_HOME}/.jcf/watch.lease`] })
      })
      yield* advance(Duration.minutes(30))
      const exit = yield* Fiber.join(fiber)

      expect(exit._tag).toBe("Failure")
      expect(output(world.stderr)).toContain("Cannot take the watch lease")
      // And crucially wrote nothing while unprotected.
      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toEqual([])
    }))

  // Forward only. Work that finished before the watch started is `reconcile`'s job, where a person
  // sees the rows before they are written.
  it.effect("ignores work that was already over when it started", () =>
    Effect.gen(function*() {
      const { fiber, world } = yield* startWatch({
        startMs: at(10, 0),
        fake: branchWork({
          transcripts: {
            "work/session-early.jsonl": transcript({
              sessionId: "session-early",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feature/PROJ-1",
              from: at(8, 0),
              minutes: 40
            })
          }
        })
      })
      yield* advance(Duration.minutes(30))
      yield* Fiber.interrupt(fiber)

      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toEqual([])
      expect(output(world.stdout)).toContain("Wrote nothing this run.")
    }))
})
