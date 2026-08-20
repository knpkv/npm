/**
 * `jcf sync reconcile --agent claude`, exercised end to end through {@link makeFakeHeadless}.
 *
 * These assert externally observable behaviour only: what the command printed, what it proposed,
 * what it wrote, and what it refused. Nothing here inspects how attribution was implemented or in
 * what order services were consulted.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Command } from "effect/unstable/cli"
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

/**
 * The Idle Cap the fake config uses. Sessions credit one of these past their final prompt — the
 * most time creditable after someone stops typing — so most expectations carry it.
 */
const IDLE_CAP = 300

/** Local components, so a day boundary is a local midnight wherever this suite runs. */
const at = (year: number, month: number, day: number, hour: number, minute: number): number =>
  new Date(year, month - 1, day, hour, minute, 0, 0).getTime()

const iso = (atMs: number): string => new Date(atMs).toISOString()

/**
 * `kind` decides whether the event evidences *presence*:
 * - `human` — a message the person typed. The only thing that counts as Session Activity.
 * - `assistant` — the agent's own output.
 * - `tool` — a tool result, which the transcript records as a `user` message even though nobody
 *   typed it. These outnumber real prompts by roughly ten to one in practice.
 */
interface TranscriptEvent {
  readonly atMs: number
  readonly text?: string | undefined
  readonly kind?: "human" | "assistant" | "tool" | undefined
  /** A turn the agent addressed to its own subagent. Shaped exactly like a typed prompt. */
  readonly sidechain?: boolean | undefined
  /** Overrides the transcript's session id for this line only — a resumed or forked session. */
  readonly sessionId?: string | undefined
  /** The branch for *this line only*; an event without one falls back to the transcript default. */
  readonly branch?: string | undefined
}

/**
 * A minimal but realistic transcript: two header lines that carry no time, one malformed line,
 * then the activity. Real transcripts carry many more fields; the point of the noise is that a
 * changed or broken line is skipped rather than failing the run.
 */
const transcript = (options: {
  readonly sessionId: string
  readonly cwd: string
  readonly gitBranch?: string | null | undefined
  readonly events: ReadonlyArray<TranscriptEvent>
}): string =>
  [
    JSON.stringify({ type: "mode", mode: "default", sessionId: options.sessionId }),
    JSON.stringify({ type: "ai-title", aiTitle: "Some title", sessionId: options.sessionId }),
    "{ this line is not valid json",
    JSON.stringify({ type: "future-line-type-we-do-not-know", sessionId: options.sessionId, timestamp: "nonsense" }),
    ...options.events.map((event) => {
      const kind = event.kind ?? "human"
      const content = kind === "assistant"
        ? [{ type: "thinking", thinking: "..." }, { type: "text", text: event.text ?? "working" }]
        : kind === "tool"
        ? [{ tool_use_id: `toolu_${event.atMs}`, type: "tool_result", content: event.text ?? "ok" }]
        : event.text ?? "working"
      return JSON.stringify({
        type: kind === "assistant" ? "assistant" : "user",
        sessionId: event.sessionId ?? options.sessionId,
        timestamp: iso(event.atMs),
        cwd: options.cwd,
        gitBranch: event.branch ?? options.gitBranch ?? null,
        isSidechain: event.sidechain ?? false,
        uuid: `${options.sessionId}-${event.atMs}`,
        version: "9.9.9",
        message: { role: kind === "assistant" ? "assistant" : "user", content }
      })
    })
  ].join("\n")

/** A human prompt every minute for `minutes`, so no gap ever reaches the Idle Cap. */
const steady = (startMs: number, minutes: number, text?: string): ReadonlyArray<TranscriptEvent> =>
  Array.from({ length: minutes + 1 }, (_, index) => ({
    atMs: startMs + index * 60_000,
    ...((index === 0 && text !== undefined) && { text })
  }))

/** Agent output and tool results every 30s — a busy agent with nobody necessarily watching. */
const agentChatter = (startMs: number, minutes: number): ReadonlyArray<TranscriptEvent> =>
  Array.from({ length: minutes * 2 }, (_, index): TranscriptEvent => ({
    atMs: startMs + index * 30_000,
    kind: index % 2 === 0 ? "assistant" : "tool"
  }))

const DAY = { year: 2026, month: 7, day: 1 }
const SINCE = ["--since", "2026-07-01", "--until", "2026-07-01"]

const baseOptions = (overrides: FakeHeadlessOptions = {}): FakeHeadlessOptions => ({
  ...overrides,
  config: { sessionRoots: [WORK_ROOT], ...overrides.config }
})

const run = (args: ReadonlyArray<string>, options: FakeHeadlessOptions = {}) => {
  const fake = makeFakeHeadless(options)
  return Command.runWith(root, { version: "0.0.0-test" })(args).pipe(
    Effect.exit,
    Effect.provide(fake.layer),
    Effect.map((exit) => ({ exit, world: fake.world }))
  )
}

const agent = (extra: ReadonlyArray<string> = []) => ["sync", "reconcile", "--agent", "claude", ...SINCE, ...extra]

const output = (lines: ReadonlyArray<string>): string => lines.join("\n")

/**
 * The `--json` payload, decoded rather than picked apart.
 *
 * Decoding is the point of asserting on the JSON Output Contract at all: a test that reaches into
 * an `unknown` with `typeof` checks goes on passing when the shape changes underneath it, which is
 * the one failure this contract exists to catch.
 */
const ReportProposal = Schema.Struct({
  ticketKey: Schema.String,
  day: Schema.String,
  signal: Schema.optional(Schema.String),
  sessionSeconds: Schema.Number,
  activeSeconds: Schema.optional(Schema.Number),
  clockifyDelta: Schema.optional(Schema.Number),
  jiraDelta: Schema.optional(Schema.Number),
  summary: Schema.NullOr(Schema.String),
  assignee: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  endedAt: Schema.NullOr(Schema.String),
  spans: Schema.optional(Schema.Array(Schema.Struct({ startMs: Schema.Number, endMs: Schema.Number })))
})

const AgentReport = Schema.Struct({
  mode: Schema.optional(Schema.String),
  proposals: Schema.Array(ReportProposal)
})

const decodeAgentReport = Schema.decodeUnknownOption(Schema.fromJsonString(AgentReport))

/** The proposals from a `--json` run, or an empty list when stdout was not a report. */
const jsonProposals = (stdout: ReadonlyArray<string>): ReadonlyArray<typeof ReportProposal.Type> =>
  Option.match(decodeAgentReport(stdout.join("\n")), {
    onNone: () => [],
    onSome: (report) => report.proposals
  })

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

describe("jcf sync reconcile --agent: usage", () => {
  // --agent changes where the evidence comes from, so pairing it with a direction is
  // contradictory. Honouring one silently would leave the user guessing which.
  it.effect("rejects --agent combined with a direction", () =>
    Effect.gen(function*() {
      const { exit, world } = yield* run(["sync", "reconcile", "clockify-to-jira", "--agent", "claude"], baseOptions())
      expect(exit._tag).toBe("Failure")
      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toEqual([])
    }))

  it.effect("rejects an unsupported agent and names what is supported", () =>
    Effect.gen(function*() {
      const { exit } = yield* run(["sync", "reconcile", "--agent", "codex"], baseOptions())
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause)).toContain("claude")
      }
    }))

  it.effect("rejects --json without --agent rather than ignoring it", () =>
    Effect.gen(function*() {
      const { exit } = yield* run(["sync", "reconcile", "--json"], baseOptions())
      expect(exit._tag).toBe("Failure")
    }))
})

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe("jcf sync reconcile --agent: scope", () => {
  it.effect("says nothing is opted in when no Session Root is configured", () =>
    Effect.gen(function*() {
      const { exit, world } = yield* run(agent(), {
        config: { sessionRoots: [] },
        transcripts: {
          "work-repo/s1.jsonl": transcript({
            sessionId: "s1",
            cwd: `${WORK_ROOT}/repo`,
            gitBranch: "feat/PROJ-1-thing",
            events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 30)
          })
        }
      })
      expect(exit._tag).toBe("Success")
      expect(output(world.stdout)).toContain("session-root")
      expect(world.createdClockifyEntries).toEqual([])
    }))

  // "Never read" is a promise about the file, not about the proposal. A transcript outside every
  // Session Root is someone's private work; opening it and then discarding what it said is not the
  // same as leaving it closed, and the Claude CLI names its project directories after the working
  // directory precisely so this can be decided before anything is opened.
  it.effect("never opens a transcript outside every Session Root", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            "in/s-in.jsonl": transcript({
              sessionId: "s-in",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 30)
            }),
            "out/s-out.jsonl": transcript({
              sessionId: "s-out",
              cwd: `${FAKE_HOME}/personal/taxes`,
              gitBranch: "feat/PROJ-9999-private",
              events: steady(at(DAY.year, DAY.month, DAY.day, 14, 0), 30)
            })
          },
          keep: [true]
        })
      )
      const opened = world.transcriptReads.join("\n")
      expect(opened).toContain("s-in.jsonl")
      expect(opened).not.toContain("s-out.jsonl")
      expect(world.jiraWorklogs).toHaveLength(1)
      expect(world.jiraWorklogs[0]?.issueKey).toBe("PROJ-5662")
    }))

  // Out-of-scope work must reach neither a proposal nor a Coding Agent — nothing about it leaves
  // the machine and nothing about it is guessed at.
  it.effect("never reads sessions outside every Session Root", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            "scratch/s-out.jsonl": transcript({
              sessionId: "s-out",
              cwd: "/private/tmp/scratch",
              gitBranch: "develop",
              events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 30, "poking at PROJ-9 for fun")
            })
          },
          attributor: () => ({ _tag: "Chosen", ticketKey: "PROJ-9", confidence: 1 })
        })
      )
      expect(world.attributorRequests).toEqual([])
      expect(world.createdClockifyEntries).toEqual([])
    }))
})

// ---------------------------------------------------------------------------
// Proposing and writing
// ---------------------------------------------------------------------------

describe("jcf sync reconcile --agent: proposals", () => {
  const branchSession = (overrides: { readonly minutes?: number } = {}) => ({
    "work-repo/s1.jsonl": transcript({
      sessionId: "s1",
      cwd: `${WORK_ROOT}/repo`,
      gitBranch: "feat/PROJ-5662-otel",
      events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), overrides.minutes ?? 30)
    })
  })

  it.effect("proposes the session's time and writes both sides when confirmed", () =>
    Effect.gen(function*() {
      const { exit, world } = yield* run(
        agent(),
        baseOptions({
          transcripts: branchSession(),
          keep: [true]
        })
      )
      expect(exit._tag).toBe("Success")
      // The picker's rows are the report: what is credited, and on what evidence.
      expect(output(world.prompts)).toContain("PROJ-5662")
      expect(output(world.prompts)).toContain("[branch]")

      expect(world.createdClockifyEntries).toHaveLength(1)
      expect(world.createdClockifyEntries[0]!.description).toContain("PROJ-5662")
      expect(world.jiraWorklogs).toHaveLength(1)
      expect(world.jiraWorklogs[0]!.issueKey).toBe("PROJ-5662")
      // 30 one-minute gaps, none of which reaches the 5-minute Idle Cap.
      expect(world.jiraWorklogs[0]!.timeSpentSeconds).toBe(1800 + IDLE_CAP)
    }))

  // The heart of the granularity question: a transcript is mostly the agent's own output, so
  // counting every event measures how long the agent was busy, not how long anyone was working.
  it.effect("credits nothing for a session where the agent worked but nobody typed", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: agentChatter(at(DAY.year, DAY.month, DAY.day, 10, 0), 90)
            })
          }
        })
      )
      // No presence at all, so the session carries no time and drops out entirely.
      expect(output(world.stdout)).toContain("No in-scope Agent Sessions")
      expect(world.createdClockifyEntries).toEqual([])
    }))

  // An hour and a half of dense agent output between two prompts is credited as the Idle Cap after
  // the first prompt, not as ninety minutes of attention.
  it.effect("credits the gap between prompts, not the agent's output between them", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(["--json"]),
        baseOptions({
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: [
                { atMs: at(DAY.year, DAY.month, DAY.day, 10, 0) },
                ...agentChatter(at(DAY.year, DAY.month, DAY.day, 10, 1), 88),
                { atMs: at(DAY.year, DAY.month, DAY.day, 11, 30) }
              ]
            })
          }
        })
      )
      const proposals = jsonProposals(world.stdout)
      // One 90-minute gap between two prompts, capped at the 5-minute Idle Cap.
      expect(proposals[0]).toMatchObject({ sessionSeconds: 300 + IDLE_CAP })
    }))

  // A worklog someone asks about months later has to explain itself. The provenance is not
  // load-bearing though: the tally keys on the `[KEY]` prefix and the day, so editing this text in
  // Clockify's web UI cannot re-enable double-logging.
  it.effect("records that the write came from an Agent Session, on both sides", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: branchSession(),
          keep: [true]
        })
      )
      expect(world.createdClockifyEntries[0]!.description).toBe("[PROJ-5662] Reconciled from Claude Agent Session")
      // And the entry still parses back to its ticket, which is what makes a second run idempotent.
      expect(world.createdClockifyEntries[0]!.description).toMatch(/^\[PROJ-5662\]/)
    }))

  // ---------------------------------------------------------------------------
  // What a written entry says
  // ---------------------------------------------------------------------------

  // A timesheet line is read months later, by which point the Issue Key is a lookup and the
  // transcript is gone. What the time went on has to be in the entry itself.
  describe("entry text", () => {
    const described = (overrides: Partial<FakeHeadlessOptions> = {}): FakeHeadlessOptions =>
      baseOptions({
        transcripts: branchSession(),
        issueSummaries: { "PROJ-5662": "Add OTEL spans to the ingest worker" },
        describer: () => "Traced the retry path and fixed the flaky span assertion",
        keep: [true],
        ...overrides
      })

    it.effect("writes the ticket name and what was worked on to both sides", () =>
      Effect.gen(function*() {
        const { world } = yield* run(agent(), described())

        const description = world.createdClockifyEntries[0]!.description
        // The key still leads, because that is what a second run tallies on.
        expect(description).toMatch(/^\[PROJ-5662\]/)
        expect(description).toContain("Add OTEL spans to the ingest worker")
        expect(description).toContain("Traced the retry path and fixed the flaky span assertion")
        expect(description).toContain("Reconciled from Claude Agent Session")

        // Jira gets the same sentence, so the two systems do not disagree about the same hour.
        expect(world.jiraWorklogs[0]!.comment).toContain("Add OTEL spans to the ingest worker")
        expect(world.jiraWorklogs[0]!.comment).toContain("Traced the retry path")
      }))

    // Text written into two systems other people read should never be a surprise found later.
    it.effect("prints what it is about to write", () =>
      Effect.gen(function*() {
        const { world } = yield* run(agent(), described())
        expect(output(world.stdout)).toContain("Traced the retry path and fixed the flaky span assertion")
      }))

    // The note is read off the session's own prompts, and the issue title goes along as context.
    it.effect("asks about the confirmed row, from that row's sessions", () =>
      Effect.gen(function*() {
        const { world } = yield* run(agent(), described())
        expect(world.describeRequests).toHaveLength(1)
        expect(world.describeRequests[0]!.ticketKey).toBe("PROJ-5662")
        expect(world.describeRequests[0]!.summary).toBe("Add OTEL spans to the ingest worker")
        expect(world.describeRequests[0]!.digest).toContain("working")
      }))

    // Nothing is spent describing a row the user just unchecked.
    it.effect("describes only the rows that are written", () =>
      Effect.gen(function*() {
        const twoDays = {
          "work-a/s-a.jsonl": transcript({
            sessionId: "s-a",
            cwd: `${WORK_ROOT}/a`,
            gitBranch: "feat/PROJ-1-a",
            events: steady(at(DAY.year, DAY.month, DAY.day, 9, 0), 20)
          }),
          "work-b/s-b.jsonl": transcript({
            sessionId: "s-b",
            cwd: `${WORK_ROOT}/b`,
            gitBranch: "feat/PROJ-2-b",
            events: steady(at(DAY.year, DAY.month, DAY.day, 12, 0), 20)
          })
        }
        const { world } = yield* run(agent(), described({ transcripts: twoDays, keep: [true, false] }))
        expect(world.describeRequests.map((request) => request.ticketKey)).toEqual(["PROJ-1"])
      }))

    it.effect("asks nothing when every row is unchecked", () =>
      Effect.gen(function*() {
        const { world } = yield* run(agent(), described({ keep: [false] }))
        expect(world.describeRequests).toEqual([])
        expect(world.createdClockifyEntries).toEqual([])
      }))

    it.effect("spends one call on a batch of rows rather than one each", () =>
      Effect.gen(function*() {
        const threeDays = Object.fromEntries(
          [1, 2, 3].map((index) => [
            `work-${index}/s-${index}.jsonl`,
            transcript({
              sessionId: `s-${index}`,
              cwd: `${WORK_ROOT}/${index}`,
              gitBranch: `feat/PROJ-${index}-a`,
              events: steady(at(DAY.year, DAY.month, DAY.day, 8 + index, 0), 20)
            })
          ])
        )
        const { world } = yield* run(agent(), described({ transcripts: threeDays, keep: [true, true, true] }))
        expect(world.describeRequests).toHaveLength(3)
        expect(world.describeBatches).toHaveLength(1)
      }))

    // A worklog with no sentence is still a correct worklog. Losing the Coding Agent must not cost
    // the write, only the description.
    it.effect("still writes when the note cannot be produced", () =>
      Effect.gen(function*() {
        const { world } = yield* run(agent(), described({ describer: () => "fail" }))
        expect(world.createdClockifyEntries).toHaveLength(1)
        expect(world.createdClockifyEntries[0]!.description).toBe(
          "[PROJ-5662] Add OTEL spans to the ingest worker (Reconciled from Claude Agent Session)"
        )
        expect(world.jiraWorklogs).toHaveLength(1)
      }))

    // The honest answer when the prompts say nothing about the work: the title and the provenance,
    // and no invented sentence.
    it.effect("writes no sentence when the sessions do not say what was done", () =>
      Effect.gen(function*() {
        const { world } = yield* run(agent(), described({ describer: () => null }))
        expect(world.createdClockifyEntries[0]!.description).toBe(
          "[PROJ-5662] Add OTEL spans to the ingest worker (Reconciled from Claude Agent Session)"
        )
      }))

    it.effect("falls back to provenance alone when Jira knows neither title nor note", () =>
      Effect.gen(function*() {
        const { world } = yield* run(agent(), described({ issueSummaries: {}, describer: () => null }))
        expect(world.createdClockifyEntries[0]!.description).toBe("[PROJ-5662] Reconciled from Claude Agent Session")
      }))
  })

  // An Issue Key alone does not say whether the afternoon belongs to it. The summary is what makes
  // the confirm prompt answerable.
  it.effect("shows the Jira issue summary on the picker row", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: branchSession(),
          issueSummaries: { "PROJ-5662": "Add OTEL spans to the ingest worker" },
          keep: [true]
        })
      )
      const picker = output(world.prompts)
      expect(picker).toContain("PROJ-5662")
      // Unclipped: at this width the fixed facts leave room for the whole title.
      expect(picker).toContain("Add OTEL spans to the ingest worker")
      expect(picker).toContain(`+${String(30 + IDLE_CAP / 60)}m 0s to both`)
      // The picker is what is on screen when the decision is made, so the times belong here too.
      expect(picker).toContain("2026-07-01 10:00-10:35")
      // ...and nothing above it, where it would have scrolled away unread. (Below it is another
      // matter: what each write says about itself is printed as it happens.)
      const beforePicker = world.stdout.slice(0, world.stdout.findIndex((line) => line.includes("Would add")))
      expect(output(beforePicker)).not.toContain("Add OTEL spans")
    }))

  // Who owns the issue is the cheapest check on a wrong attribution: time credited to someone
  // else's ticket is worth a second look before it is written.
  it.effect("shows the assignee next to the summary", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: branchSession(),
          issueSummaries: { "PROJ-5662": "Add OTEL spans" },
          issueAssignees: { "PROJ-5662": "Dana Reviewer" },
          keep: [true]
        })
      )
      // On the row itself, not in the choice's `description`: a description renders only while its
      // row is highlighted, and the owner of an issue is worth seeing on every row at once.
      expect(output(world.prompts)).toContain("Add OTEL spans · Dana Reviewer")
    }))

  it.effect("says so when an issue is unassigned", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: branchSession(),
          issueSummaries: { "PROJ-5662": "Add OTEL spans" },
          keep: [true]
        })
      )
      expect(output(world.prompts)).toContain("· unassigned")
    }))

  // A missing login or a deleted issue must cost the summary, not the run.
  it.effect("still proposes and writes when the summary cannot be fetched", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: branchSession(),
          issueSummaries: {},
          keep: [true]
        })
      )
      expect(output(world.stdout)).toContain("PROJ-5662")
      expect(world.createdClockifyEntries).toHaveLength(1)
    }))

  // "2h 35m" is an assertion; the clock ranges are the evidence for it, and the grid is the same
  // evidence in a shape you can compare against a memory of the day.
  it.effect("shows when the time was credited, and draws it with --calendar", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(["--calendar"]),
        baseOptions({
          transcripts: branchSession(),
          keep: [true]
        })
      )
      // Steady activity from 10:00 for 30 minutes, so one contiguous block.
      expect(output(world.prompts)).toContain("10:00-10:35")
      const printed = output(world.stdout)
      expect(printed).toContain("# PROJ-5662")
      expect(printed).toMatch(/ {2}10h\s+\.*#+\.*/)
    }))

  // The pair a timesheet actually asks for, and the pair the written entry is anchored to.
  it.effect("shows when the work item started and ended, and anchors the entry there", () =>
    Effect.gen(function*() {
      const { world } = yield* run(agent(), baseOptions({ transcripts: branchSession(), keep: [true] }))
      // Steady prompts from 10:00 for 30 minutes.
      expect(output(world.prompts)).toContain("10:00-10:35")

      // Written at 10:00, not the local noon the service falls back to when it knows only a day.
      const start = new Date(world.createdClockifyEntries[0]!.start)
      expect(start.getHours()).toBe(10)
      expect(start.getMinutes()).toBe(0)
      const jiraStart = new Date(world.jiraWorklogs[0]!.started.replace("+0000", "Z"))
      expect(jiraStart.getHours()).toBe(10)
    }))

  it.effect("names the bounds and the blocks inside them when work was interrupted", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(["--json"]),
        baseOptions({
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: [
                ...steady(at(DAY.year, DAY.month, DAY.day, 9, 0), 10),
                ...steady(at(DAY.year, DAY.month, DAY.day, 11, 0), 10)
              ]
            })
          }
        })
      )
      const proposals = jsonProposals(world.stdout)
      const row = proposals[0]
      // Bounds span the interruption; the credited total does not.
      expect(row).toMatchObject({ sessionSeconds: 10 * 60 + 10 * 60 + 300 + IDLE_CAP })
      // Returns null rather than throwing, so a missing bound fails as a readable assertion instead
      // of an exception from inside a helper.
      const instant = (field: "startedAt" | "endedAt"): Date | null => {
        const value = row?.[field]
        return value === undefined || value === null ? null : new Date(value)
      }
      expect(instant("startedAt")?.getHours()).toBe(9)
      expect(instant("endedAt")?.getHours()).toBe(11)
    }))

  it.effect("draws no grid without --calendar", () =>
    Effect.gen(function*() {
      const { world } = yield* run(agent(), baseOptions({ transcripts: branchSession(), keep: [true] }))
      expect(output(world.stdout)).not.toContain("# PROJ-5662")
      // The clock ranges are always on the picker row; only the grid is opt-in.
      expect(output(world.prompts)).toContain("10:00-10:35")
    }))

  it.effect("rejects --calendar without --agent", () =>
    Effect.gen(function*() {
      const { exit } = yield* run(["sync", "reconcile", "--calendar"], baseOptions())
      expect(exit._tag).toBe("Failure")
    }))

  // The whole point of a picker over a row-by-row interrogation: pick a subset in one pass.
  it.effect("writes only the checked rows", () =>
    Effect.gen(function*() {
      const threeDays = {
        "work-a/s-a.jsonl": transcript({
          sessionId: "s-a",
          cwd: `${WORK_ROOT}/a`,
          gitBranch: "feat/PROJ-1-a",
          events: steady(at(DAY.year, DAY.month, DAY.day, 9, 0), 20)
        }),
        "work-b/s-b.jsonl": transcript({
          sessionId: "s-b",
          cwd: `${WORK_ROOT}/b`,
          gitBranch: "feat/PROJ-2-b",
          events: steady(at(DAY.year, DAY.month, DAY.day, 12, 0), 20)
        }),
        "work-c/s-c.jsonl": transcript({
          sessionId: "s-c",
          cwd: `${WORK_ROOT}/c`,
          gitBranch: "feat/PROJ-3-c",
          events: steady(at(DAY.year, DAY.month, DAY.day, 15, 0), 20)
        })
      }
      // Rows are ordered by day then Issue Key, so this drops PROJ-2 and keeps PROJ-1 and PROJ-3.
      const { world } = yield* run(agent(), baseOptions({ transcripts: threeDays, keep: [true, false, true] }))

      const written = world.createdClockifyEntries.map((entry) => entry.description)
      expect(written).toHaveLength(2)
      expect(written.join(" ")).toContain("PROJ-1")
      expect(written.join(" ")).toContain("PROJ-3")
      expect(written.join(" ")).not.toContain("PROJ-2")
      expect(world.jiraWorklogs.map((worklog) => worklog.issueKey)).toEqual(["PROJ-1", "PROJ-3"])
    }))

  it.effect("writes nothing when every row is unchecked", () =>
    Effect.gen(function*() {
      const { world } = yield* run(agent(), baseOptions({ transcripts: branchSession(), keep: [false] }))
      expect(output(world.stdout)).toContain("Nothing selected")
      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toEqual([])
    }))

  // Everything starts checked, so accepting a whole week is one keystroke.
  it.effect("keeps every row checked by default", () =>
    Effect.gen(function*() {
      const { world } = yield* run(agent(), baseOptions({ transcripts: branchSession(), keep: [] }))
      expect(world.createdClockifyEntries).toHaveLength(1)
    }))

  // A row carries everything needed to judge it, which makes it long — and the picker redraws by
  // erasing a counted number of rows, so a line that wraps or a line the count misses corrupts the
  // list on the very first keypress.
  describe("layout", () => {
    /** Sessions on issues whose titles and owners fill the second line of every row. */
    const wordySessions = {
      "work-a/s-a.jsonl": transcript({
        sessionId: "s-a",
        cwd: `${WORK_ROOT}/a`,
        gitBranch: "feat/PROJ-5662-otel",
        events: steady(at(DAY.year, DAY.month, DAY.day, 9, 0), 20)
      }),
      "work-b/s-b.jsonl": transcript({
        sessionId: "s-b",
        cwd: `${WORK_ROOT}/b`,
        gitBranch: "feat/PROJ-5663-ssp",
        events: [
          ...steady(at(DAY.year, DAY.month, DAY.day, 12, 0), 20),
          ...steady(at(DAY.year, DAY.month, DAY.day, 16, 0), 20)
        ]
      })
    }

    const wordy = (columns?: number): FakeHeadlessOptions =>
      baseOptions({
        transcripts: wordySessions,
        issueSummaries: {
          "PROJ-5662": "Add OpenTelemetry spans to the ingest worker and its retry path",
          "PROJ-5663": "Expose a per-user application list from the service provider API"
        },
        issueAssignees: { "PROJ-5662": "Someone With A Long Name", "PROJ-5663": "Dana Reviewer" },
        keep: [true, false],
        ...((columns !== undefined) && { columns })
      })

    const wordyOptions = wordy()

    // Built rather than written as a literal: an ESC in a regex literal is a control character, which
    // `no-control-regex` rejects.
    const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g")
    const plain = (frame: string): string => frame.replace(ANSI, "")

    /**
     * The frames showing the live list, as plain text. The prompt's final frame — its echo of what
     * was chosen — is not one of these: it reprints the selected titles on a single line, so it is
     * neither erased nor bound by the width.
     */
    const listFrames = (world: { readonly prompts: ReadonlyArray<string> }): ReadonlyArray<string> =>
      world.prompts.map(plain).filter((frame) => frame.includes("Inverse Selection"))

    it.effect("keeps every line inside the terminal's width", () =>
      Effect.gen(function*() {
        const { world } = yield* run(agent(), wordyOptions)
        const drawn = listFrames(world)
        expect(drawn.length).toBeGreaterThan(1)
        for (const line of drawn.flatMap((frame) => frame.split("\n"))) {
          expect(line.length).toBeLessThanOrEqual(80)
        }
      }))

    // `Ansi.eraseLines(n)` emits one `2K` per row it clears, and the prompt adds one more for the
    // line the cursor sits on. Erasing fewer rows than were drawn leaves the tail of the old list
    // on screen — which is what a two-line row would cause if the prompt counted rows, not lines.
    it.effect("erases every line it drew before redrawing", () =>
      Effect.gen(function*() {
        const { world } = yield* run(agent(), wordyOptions)
        const erasures = world.prompts
          .map((frame, index) => ({ frame, previous: world.prompts[index - 1] }))
          .filter((step) => step.frame.includes("2K") && step.previous !== undefined)
        expect(erasures.length).toBeGreaterThan(0)
        for (const step of erasures) {
          expect((step.frame.match(/2K/g) ?? []).length).toBe(plain(step.previous!).split("\n").length + 1)
        }
      }))

    it.effect("shows two lines for every row", () =>
      Effect.gen(function*() {
        const { world } = yield* run(agent(), wordyOptions)
        // One prompt line, two meta options, then two lines for each of the two rows.
        expect(listFrames(world).at(-1)!.split("\n")).toHaveLength(1 + 2 + 2 * 2)
      }))

    // The summary and the block times are what a wider terminal buys: at 80 columns the title is
    // clipped and the times are dropped, and neither loss should be permanent.
    // Both lines, not just the detail one. A long key with unequal gaps overflowed 80 columns, and
    // the prompt counts only the title lines it was handed — so the terminal wrapped the surplus and
    // every later row sat a line out of place, mid-decision.
    it.effect("keeps the header inside the terminal width too", () =>
      Effect.gen(function*() {
        const { world } = yield* run(
          agent(),
          baseOptions({
            transcripts: {
              "work-repo/s1.jsonl": transcript({
                sessionId: "s1",
                cwd: `${WORK_ROOT}/repo`,
                gitBranch: "feat/PROJECTKEY-999999-a-very-long-branch-name",
                events: steady(at(DAY.year, DAY.month, DAY.day, 9, 0), 30)
              })
            },
            jiraWorklogs: {
              "PROJECTKEY-999999": [{
                started: iso(at(DAY.year, DAY.month, DAY.day, 9, 0)),
                timeSpentSeconds: 60
              }]
            },
            issueSummaries: { "PROJECTKEY-999999": "A title long enough to fill the second line twice over" },
            keep: [true]
          })
        )
        const drawn = listFrames(world)
        expect(drawn.length).toBeGreaterThan(0)
        for (const line of drawn.flatMap((frame) => frame.split("\n"))) {
          expect(line.length).toBeLessThanOrEqual(80)
        }
      }))

    it.effect("spends a wider terminal on the summary and the block times", () =>
      Effect.gen(function*() {
        const narrow = yield* run(agent(), wordy(80))
        const wide = yield* run(agent(), wordy(140))

        const narrowList = listFrames(narrow.world).at(-1)!
        // Clipped, and the block times dropped rather than half-printed.
        expect(narrowList).toContain("Expose a per-user application")
        expect(narrowList).not.toContain("the service provider API")
        expect(narrowList).toContain("2 blocks")
        expect(narrowList).not.toContain("12:00-12:25")

        const wideList = listFrames(wide.world).at(-1)!
        // Unclipped, and the blocks named rather than just counted.
        expect(wideList).toContain("Expose a per-user application list from the service provider API")
        expect(wideList).toContain("2 blocks · 12:00-12:25, 16:00-16:25")
        for (const line of wideList.split("\n")) expect(line.length).toBeLessThanOrEqual(140)
      }))

    // Below what a row needs there is nothing useful to do, so the layout stops shrinking rather
    // than clipping every row down to an ellipsis.
    it.effect("lays out for 80 columns when the terminal reports less", () =>
      Effect.gen(function*() {
        const { world } = yield* run(agent(), wordy(40))
        const drawn = listFrames(world).at(-1)!
        // The same rows an 80-column terminal gets, wrapped by the terminal rather than pre-clipped
        // into uselessness.
        expect(drawn).toContain("Expose a per-user application")
        for (const line of drawn.split("\n")) expect(line.length).toBeLessThanOrEqual(80)
      }))
  })

  // Losing the terminal (no TTY, or Ctrl-C) ends the run having written nothing further, rather
  // than crashing halfway through a list of rows.
  it.effect("stops without writing when terminal input ends", () =>
    Effect.gen(function*() {
      // No `keep` at all: the picker never receives a keypress, which is what a missing TTY looks
      // like. An empty `keep` would instead mean "accept the default selection".
      const { exit, world } = yield* run(agent(), baseOptions({ transcripts: branchSession() }))
      expect(exit._tag).toBe("Success")
      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toEqual([])
    }))

  it.effect("sizes each side to its own gap", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: branchSession(),
          // Jira already holds 10 of the 30 minutes; Clockify holds none.
          jiraWorklogs: {
            "PROJ-5662": [{ started: iso(at(DAY.year, DAY.month, DAY.day, 12, 0)), timeSpentSeconds: 600 }]
          },
          keep: [true]
        })
      )
      expect(world.createdClockifyEntries).toHaveLength(1)
      expect(world.jiraWorklogs).toHaveLength(1)
      expect(world.jiraWorklogs[0]!.timeSpentSeconds).toBe(1200 + IDLE_CAP)
    }))

  it.effect("proposes nothing on an immediate second run", () =>
    Effect.gen(function*() {
      const fake = makeFakeHeadless(baseOptions({
        transcripts: branchSession(),
        keep: [true, true]
      }))
      const cli = Command.runWith(root, { version: "0.0.0-test" })

      yield* cli(agent()).pipe(Effect.exit, Effect.provide(fake.layer))
      expect(fake.world.createdClockifyEntries).toHaveLength(1)

      fake.world.stdout.length = 0
      yield* cli(agent()).pipe(Effect.exit, Effect.provide(fake.layer))

      // Still one write: the second run subtracted what the first one recorded.
      expect(fake.world.createdClockifyEntries).toHaveLength(1)
      expect(fake.world.jiraWorklogs).toHaveLength(1)
      expect(output(fake.world.stdout)).toContain("Nothing to propose")
    }))

  it.effect("reports nothing to propose when both sides already hold the time", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: branchSession(),
          clockifyEntries: [{
            description: "[PROJ-5662] earlier",
            start: iso(at(DAY.year, DAY.month, DAY.day, 9, 0)),
            end: iso(at(DAY.year, DAY.month, DAY.day, 9, 40))
          }],
          jiraWorklogs: {
            "PROJ-5662": [{ started: iso(at(DAY.year, DAY.month, DAY.day, 9, 0)), timeSpentSeconds: 2400 }]
          },
          keep: [true]
        })
      )
      expect(output(world.stdout)).toContain("Nothing to propose")
      expect(world.createdClockifyEntries).toEqual([])
    }))

  // Clockify's own default page size is 50, and the tally asked for no page at all — so on any busy
  // week the recorded side arrived truncated, and an entry past the first page read as time Clockify
  // never had. Everything downstream subtracts this before writing the difference.
  it.effect("reads every page of the recorded Clockify side", () =>
    Effect.gen(function*() {
      const filler = Array.from({ length: 3 }, (_, index) => ({
        description: `[OTHER-${index}] unrelated`,
        start: iso(at(DAY.year, DAY.month, DAY.day, 1, index)),
        end: iso(at(DAY.year, DAY.month, DAY.day, 1, index + 1))
      }))
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: branchSession(),
          // The entry that matters is last, so a single-page read cannot see it.
          clockifyEntries: [
            ...filler,
            {
              description: "[PROJ-5662] earlier",
              start: iso(at(DAY.year, DAY.month, DAY.day, 10, 0)),
              end: iso(at(DAY.year, DAY.month, DAY.day, 10, 35))
            }
          ],
          clockifyPageSize: 2,
          keep: [true]
        })
      )
      // Clockify already holds the whole block, so its side is not short and nothing is written to it.
      expect(world.createdClockifyEntries).toEqual([])
    }))

  // Session credits are split at each local midnight, so a recorded entry has to be too. Crediting
  // an overnight entry entirely to the day it started left the following day looking untouched.
  it.effect("splits a recorded entry that crosses midnight across both days", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        ["sync", "reconcile", "--agent", "claude", "--since", "2026-06-30", "--until", "2026-07-01"],
        baseOptions({
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: steady(at(2026, 6, 30, 23, 30), 60)
            })
          },
          clockifyEntries: [{
            description: "[PROJ-5662] overnight",
            start: iso(at(2026, 6, 30, 23, 30)),
            end: iso(at(DAY.year, DAY.month, DAY.day, 0, 35))
          }],
          keep: [true, true]
        })
      )
      // Both days are fully accounted for by the one existing entry, so neither is written again.
      // Crediting all 65 minutes to 30 June left 1 July looking untouched and wrote it a second time.
      expect(world.createdClockifyEntries).toEqual([])
    }))

  // `jcf timer start` sends the configured flag; this path did not, so Clockify applied its own
  // default and a reconciled entry could be billed differently from a timed one on the same ticket.
  it.effect("sends the configured billable default on entries it creates", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: branchSession(),
          config: { sessionRoots: [WORK_ROOT], defaultBillable: false },
          keep: [true]
        })
      )
      expect(world.createdClockifyEntries).toHaveLength(1)
      expect(world.createdClockifyEntries[0]?.billable).toBe(false)
    }))

  // An in-scope transcript that cannot be read is not an absent one: it may overlap a readable
  // session on another ticket, and skipping it takes that ticket out of the overlap sharing — so the
  // interval it should have halved is credited whole to whichever file happened to open.
  it.effect("fails rather than deriving proposals from a partly unreadable session set", () =>
    Effect.gen(function*() {
      const { exit, world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            ...branchSession(),
            "work-other/s2.jsonl": transcript({
              sessionId: "s2",
              cwd: `${WORK_ROOT}/other`,
              gitBranch: "feat/PROJ-9-x",
              events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 30)
            })
          },
          unreadableTranscripts: ["s2.jsonl"]
        })
      )
      expect(exit._tag).toBe("Failure")
      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toEqual([])
    }))

  it.effect("stops the run at the first Jira sign-in failure", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            ...branchSession(),
            "work-other/s2.jsonl": transcript({
              sessionId: "s2",
              cwd: `${WORK_ROOT}/other`,
              gitBranch: "feat/PROJ-9-x",
              events: steady(at(DAY.year, DAY.month, DAY.day, 14, 0), 20)
            })
          },
          jiraLoggedIn: false,
          keep: [true, true]
        })
      )
      // The first row's Clockify half still landed; the run then stopped rather than asking again.
      expect(world.createdClockifyEntries).toHaveLength(1)
      expect(world.jiraWorklogs).toEqual([])
      expect(output(world.stdout)).toContain("jcf auth jira login")
    }))
})

// ---------------------------------------------------------------------------
// Duration properties
// ---------------------------------------------------------------------------

describe("jcf sync reconcile --agent: duration", () => {
  it.effect("keeps a day of concurrent sessions within its wall clock", () =>
    Effect.gen(function*() {
      const start = at(DAY.year, DAY.month, DAY.day, 9, 0)
      const { world } = yield* run(
        agent(["--json"]),
        baseOptions({
          transcripts: {
            "work-a/s-a.jsonl": transcript({
              sessionId: "s-a",
              cwd: `${WORK_ROOT}/a`,
              gitBranch: "feat/PROJ-1-a",
              events: steady(start, 120)
            }),
            "work-b/s-b.jsonl": transcript({
              sessionId: "s-b",
              cwd: `${WORK_ROOT}/b`,
              gitBranch: "feat/PROJ-2-b",
              events: steady(start + 30_000, 120)
            }),
            "work-c/s-c.jsonl": transcript({
              sessionId: "s-c",
              cwd: `${WORK_ROOT}/c`,
              gitBranch: "feat/PROJ-3-c",
              events: steady(start + 45_000, 120)
            })
          }
        })
      )
      const proposals = jsonProposals(world.stdout)
      expect(proposals.length).toBe(3)

      const total = proposals.reduce((sum, proposal) => sum + proposal.sessionSeconds, 0)
      // Three sessions overlapping for two hours account for two hours, not six. The union of
      // presence runs from the first prompt to one Idle Cap past the last, and no arrangement of
      // overlapping sessions may sum past it — that is the property that makes a day's proposals
      // safe to accept without auditing them against each other.
      const presenceUnion = 120 * 60 + 45 + IDLE_CAP
      expect(total).toBeLessThanOrEqual(presenceUnion)
    }))

  it.effect("bills neither the overnight gap nor the wrong day for a resumed session", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        ["sync", "reconcile", "--agent", "claude", "--since", "2026-07-01", "--until", "2026-07-02", "--json"],
        baseOptions({
          transcripts: {
            "work-night/s-night.jsonl": transcript({
              sessionId: "s-night",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-77-x",
              events: [
                ...steady(at(2026, 7, 1, 22, 0), 30),
                ...steady(at(2026, 7, 2, 9, 0), 30)
              ]
            })
          }
        })
      )
      const proposals = jsonProposals(world.stdout)
      const byDay = new Map<string, number>(
        proposals.map((proposal): readonly [string, number] => [proposal.day, proposal.sessionSeconds])
      )
      // 30 credited minutes on each day, plus one capped 5-minute gap on the evening side.
      expect(byDay.get("2026-07-01")).toBe(30 * 60 + 300)
      expect(byDay.get("2026-07-02")).toBe(30 * 60 + IDLE_CAP)
    }))
})

// ---------------------------------------------------------------------------
// The running Timer hazard
// ---------------------------------------------------------------------------

describe("jcf sync reconcile --agent: running timer", () => {
  // A running Clockify entry has no end, so the Clockify tally cannot see its time. Proposing
  // that day would log those hours a second time the moment the Timer is stopped.
  it.effect("reports the day, states why, and proposes nothing for it", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 30)
            })
          },
          runningTimer: {
            description: "[PROJ-5662] still going",
            start: iso(at(DAY.year, DAY.month, DAY.day, 10, 0))
          },
          keep: [true]
        })
      )
      const printed = output(world.stdout)
      expect(printed).toContain("2026-07-01")
      expect(printed).toContain("timer is still running")
      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toEqual([])
    }))

  // A Timer left running overnight hides time on every day it crosses, not only the one it started
  // on. The start day is simply the one a shorter rule happened to notice.
  it.effect("excludes every day a Timer left running spans, not only the one it started on", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        ["sync", "reconcile", "--agent", "claude", "--since", "2026-06-29", "--until", "2026-07-01"],
        baseOptions({
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: [
                ...steady(at(2026, 6, 30, 10, 0), 30),
                ...steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 30)
              ]
            })
          },
          runningTimer: {
            description: "[PROJ-5662] still going",
            start: iso(at(2026, 6, 30, 9, 0))
          },
          keep: [true]
        })
      )
      const skipped = world.stdout.filter((line) => line.includes("timer is still running"))
      expect(skipped.map((line) => line.trim().slice(0, 10))).toEqual(["2026-06-30", "2026-07-01"])
      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toEqual([])
    }))
})

// ---------------------------------------------------------------------------
// Evidence the reader must not miscount
// ---------------------------------------------------------------------------

describe("jcf sync reconcile --agent: what counts as presence", () => {
  // A subagent turn is `type: "user"` with plain string content — the exact shape of a typed
  // prompt, so nothing else excludes it. A run that fans out to subagents would otherwise
  // manufacture prompts dense enough to bridge every Idle Cap gap, which is the one thing the
  // Idle Cap exists to stop.
  it.effect("credits nothing for a session whose only prompts went to a subagent", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 40).map((event) => ({
                ...event,
                sidechain: true
              }))
            })
          },
          keep: [true]
        })
      )
      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toEqual([])
    }))

  // The person typed twice, forty minutes apart, while the agent talked to subagents throughout.
  // Only the two typed prompts evidence presence, and they are further apart than the Idle Cap.
  it.effect("counts the typed prompts in a session that also drove subagents", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: [
                ...steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 10),
                ...steady(at(DAY.year, DAY.month, DAY.day, 10, 10), 40).map((event) => ({
                  ...event,
                  sidechain: true
                }))
              ]
            })
          },
          keep: [true]
        })
      )
      expect(world.jiraWorklogs).toHaveLength(1)
      expect(world.jiraWorklogs[0]?.timeSpentSeconds).toBe(600 + IDLE_CAP)
    }))

  // Windows are grouped by the activity's session id and attributions are looked up by the
  // record's. Labelling them from two different places is how a transcript carrying more than one
  // id produces windows no attribution matches — hours that vanish into "unattributed".
  it.effect("attributes a transcript whose lines carry more than one session id", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1-resumed",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: [
                ...steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 20).map((event) => ({
                  ...event,
                  sessionId: "s1-original"
                })),
                ...steady(at(DAY.year, DAY.month, DAY.day, 10, 20), 20)
              ]
            })
          },
          keep: [true]
        })
      )
      expect(output(world.stdout)).not.toContain("unattributed")
      expect(world.jiraWorklogs[0]?.timeSpentSeconds).toBe(2400 + IDLE_CAP)
    }))

  // Sessions are tracked per bucket *and day*. A week's run emits one row per day, and each row's
  // evidence has to be that day's — otherwise a Coding Agent is asked to describe Monday's work from
  // Friday's prompts, and that sentence goes verbatim into a Clockify description and a worklog.
  it.effect("describes each day from that day's sessions, not the whole week's", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        ["sync", "reconcile", "--agent", "claude", "--since", "2026-07-01", "--until", "2026-07-02"],
        baseOptions({
          transcripts: {
            "work-repo/mon.jsonl": transcript({
              sessionId: "s-mon",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: steady(at(2026, 7, 1, 10, 0), 30, "Wednesday: add the ingest spans")
            }),
            "work-repo/thu.jsonl": transcript({
              sessionId: "s-thu",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: steady(at(2026, 7, 2, 10, 0), 30, "Thursday: chase the flaky flush test")
            })
          },
          describer: (request) => request.digest.slice(0, 40),
          keep: [true, true]
        })
      )
      expect(world.describeRequests).toHaveLength(2)
      const [firstDay, secondDay] = world.describeRequests
      expect(firstDay?.digest).toContain("Wednesday")
      expect(firstDay?.digest).not.toContain("Thursday")
      expect(secondDay?.digest).toContain("Thursday")
      expect(secondDay?.digest).not.toContain("Wednesday")
    }))
})

// ---------------------------------------------------------------------------
// The JSON Output Contract
// ---------------------------------------------------------------------------

describe("jcf sync reconcile --agent --json", () => {
  // Silence on stdout with a zero exit reads as "no unlogged work", and the skill tells an agent to
  // act on exactly that. A run that could not read its evidence has to be distinguishable from one
  // that found nothing.
  it.effect("fails rather than exiting 0 with no JSON when the run cannot read", () =>
    Effect.gen(function*() {
      const { exit, world } = yield* run(
        agent(["--json"]),
        baseOptions({
          jiraWorklogReadFails: true,
          jiraWorklogs: {
            "PROJ-5662": [{ started: iso(at(DAY.year, DAY.month, DAY.day, 10, 0)), timeSpentSeconds: 60 }]
          },
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 30)
            })
          }
        })
      )
      expect(exit._tag).toBe("Failure")
      expect(world.stdout).toEqual([])
      expect(output(world.stderr)).toContain("Jira worklog fetch failed")
    }))
})

describe("jcf sync reconcile --agent: a session that changes branch", () => {
  // Taking the last line's branch for the whole transcript credits the morning's prompts to the
  // afternoon's ticket. Under `jcf watch` that is worse than a misattribution: the morning can
  // already have been written under the first ticket, and is then derived again under the second —
  // the same wall clock on two tickets.
  it.effect("credits each stretch to the branch it actually ran under", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-1000-first",
              events: [
                ...steady(at(DAY.year, DAY.month, DAY.day, 9, 0), 20),
                ...steady(at(DAY.year, DAY.month, DAY.day, 14, 0), 20).map((event) => ({
                  ...event,
                  branch: "feat/PROJ-2000-second"
                }))
              ]
            })
          },
          keep: [true, true]
        })
      )
      const byKey = new Map(world.jiraWorklogs.map((worklog) => [worklog.issueKey, worklog.timeSpentSeconds]))
      expect(byKey.get("PROJ-1000")).toBe(20 * 60 + IDLE_CAP)
      expect(byKey.get("PROJ-2000")).toBe(20 * 60 + IDLE_CAP)
    }))

  // The tail after a stretch's final prompt ends where the next stretch begins. Left unbounded it
  // ran a full Idle Cap into the new branch's work and was shared back onto the old ticket, so a
  // switch a minute in put those minutes on both tickets at once.
  it.effect("ends a stretch's tail where the next branch starts, not one Idle Cap later", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-1000-first",
              events: [
                { atMs: at(DAY.year, DAY.month, DAY.day, 9, 0) },
                // One minute later the same person is on another branch.
                { atMs: at(DAY.year, DAY.month, DAY.day, 9, 1), branch: "feat/PROJ-2000-second" },
                { atMs: at(DAY.year, DAY.month, DAY.day, 9, 3), branch: "feat/PROJ-2000-second" }
              ]
            })
          },
          keep: [true, true]
        })
      )
      const byKey = new Map(world.jiraWorklogs.map((worklog) => [worklog.issueKey, worklog.timeSpentSeconds]))
      // The first stretch is one minute and stops at the switch; the second is two minutes of gap
      // plus its own capped tail. Nothing is credited twice.
      expect(byKey.get("PROJ-1000")).toBe(60)
      expect(byKey.get("PROJ-2000")).toBe(120 + IDLE_CAP)
    }))
})

// ---------------------------------------------------------------------------
// Standing Attributions
// ---------------------------------------------------------------------------

describe("jcf sync reconcile --agent: evidence stays inside the window", () => {
  // A session resumed the next day, on something else. Yesterday's hours must not be described — or
  // attributed — from today's prompts, and today's text must not reach a Coding Agent as evidence
  // for a window it falls outside.
  it.effect("mines and describes only from prompts inside the requested window", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: [
                ...steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 30, "Wire up the ingest spans"),
                ...steady(at(2026, 7, 2, 10, 0), 30, "Different task on PROJ-7777 tomorrow")
              ]
            })
          },
          describer: (request) => request.digest.slice(0, 60),
          keep: [true]
        })
      )
      expect(world.describeRequests).toHaveLength(1)
      expect(world.describeRequests[0]?.digest).toContain("ingest spans")
      expect(world.describeRequests[0]?.digest).not.toContain("PROJ-7777")
    }))
})

describe("jcf sync reconcile --agent: standing attributions", () => {
  // `jcf config set session-ticket ~/dev/docs PROJ-42` stores the `~` verbatim, and both the
  // command's own hint and the docs show that form. Attribution compares against an absolute
  // working directory, so without expansion the advertised way of configuring one is a no-op —
  // and under `jcf watch`, which never asks a model, the time is simply never logged.
  it.effect("matches a `~`-relative prefix, the form the config command stores", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          config: { sessionTicketMap: { "~/dev/work/docs": "PROJ-42" } },
          transcripts: {
            "work-docs/s-docs.jsonl": transcript({
              sessionId: "s-docs",
              cwd: `${WORK_ROOT}/docs`,
              gitBranch: "main",
              events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 30)
            })
          },
          keep: [true]
        })
      )
      expect(world.attributorBatches).toEqual([])
      expect(world.jiraWorklogs[0]?.issueKey).toBe("PROJ-42")
    }))
})

// ---------------------------------------------------------------------------
// Reading the recorded side
// ---------------------------------------------------------------------------

describe("jcf sync reconcile --agent: unreadable recorded state", () => {
  // Every proposal is `session − (already recorded)`. An unread Jira worklog is indistinguishable
  // from an absent one, so swallowing the error into an empty list would re-log hours that are
  // already there. Failing costs a run; guessing costs someone else's timesheet.
  it.effect("fails rather than proposing time Jira could not be read for", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          jiraWorklogReadFails: true,
          jiraWorklogs: {
            "PROJ-5662": [{ started: iso(at(DAY.year, DAY.month, DAY.day, 10, 0)), timeSpentSeconds: 1800 }]
          },
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 30)
            })
          },
          keep: [true]
        })
      )
      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toEqual([])
      expect(output(world.stderr)).toContain("Jira worklog fetch failed")
    }))
})

// ---------------------------------------------------------------------------
// Attribution and the cost of a Coding Agent
// ---------------------------------------------------------------------------

describe("jcf sync reconcile --agent: attribution", () => {
  const integrationSession = transcript({
    sessionId: "s-int",
    cwd: `${WORK_ROOT}/integration`,
    gitBranch: "release-candidate",
    events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 30, "finishing the PROJ-4242 rollout, also saw PROJ-9")
  })

  // The cost guarantee: a normal day where every session sits on a ticket branch spends nothing.
  it.effect("never calls the Coding Agent when every session is attributed by branch", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            "work-a/s-a.jsonl": transcript({
              sessionId: "s-a",
              cwd: `${WORK_ROOT}/a`,
              gitBranch: "feat/PROJ-1-a",
              events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 20, "mentions PROJ-2 in passing")
            }),
            "work-b/s-b.jsonl": transcript({
              sessionId: "s-b",
              cwd: `${WORK_ROOT}/b`,
              gitBranch: "feat/PROJ-3-b",
              events: steady(at(DAY.year, DAY.month, DAY.day, 14, 0), 20)
            })
          },
          keep: [true, true]
        })
      )
      expect(world.attributorRequests).toEqual([])
      expect(world.createdClockifyEntries).toHaveLength(2)
    }))

  it.effect("consults the Coding Agent for an integration-branch session and offers its choice", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: { "work-int/s-int.jsonl": integrationSession },
          attributor: () => ({ _tag: "Chosen", ticketKey: "PROJ-4242", confidence: 0.9 }),
          keep: [true]
        })
      )
      expect(world.attributorRequests).toHaveLength(1)
      expect(world.attributorRequests[0]!.candidateKeys).toEqual(["PROJ-4242", "PROJ-9"])
      expect(output(world.prompts)).toContain("[agent 0.90]")
      expect(world.jiraWorklogs[0]!.issueKey).toBe("PROJ-4242")
    }))

  /** `count` integration-branch sessions, each mentioning a distinct Issue Key. */
  const integrationSessions = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `work-int-${index}/s-${index}.jsonl`,
        transcript({
          sessionId: `s-int-${index}`,
          cwd: `${WORK_ROOT}/int-${index}`,
          gitBranch: "develop",
          // 6000+ deliberately: `PROJ-111` would be stripped as a placeholder (repeated digits),
          // leaving that session with no candidates and nothing to ask about.
          events: steady(at(DAY.year, DAY.month, DAY.day, 6 + index, 0), 20, `rolling out PROJ-${6000 + index}`)
        })
      ])
    )

  // A call's cost is almost entirely fixed overhead — measured against the real CLI, one session
  // cost $0.080 and seven together cost $0.049 — so sessions go in one call, not one call each.
  it.effect("asks about several sessions in a single call", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: integrationSessions(3),
          attributor: (request) => ({ _tag: "Chosen", ticketKey: request.candidateKeys[0]!, confidence: 0.9 }),
          keep: [true, true, true]
        })
      )
      expect(world.attributorRequests).toHaveLength(3)
      expect(world.attributorBatches).toHaveLength(1)
      expect(world.attributorBatches[0]).toHaveLength(3)
      expect(world.createdClockifyEntries).toHaveLength(3)
    }))

  // Batches are bounded, so a big backlog still becomes several calls — and those overlap rather
  // than running one after another, which is what made a week's run look hung.
  it.effect("splits a large backlog into bounded, overlapping calls", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: integrationSessions(12),
          attributor: (request) => ({ _tag: "Chosen", ticketKey: request.candidateKeys[0]!, confidence: 0.9 })
        })
      )
      expect(world.attributorRequests).toHaveLength(12)
      expect(world.attributorBatches.length).toBeGreaterThan(1)
      for (const batch of world.attributorBatches) expect(batch.length).toBeLessThanOrEqual(8)
      expect(world.maxAttributorInFlight).toBeGreaterThan(1)
    }))

  // Reading transcripts then waking a Coding Agent is slow enough that silence reads as a hang.
  it.effect("says what it is waiting for, on stderr", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: { "work-int/s-int.jsonl": integrationSession },
          attributor: () => ({ _tag: "Chosen", ticketKey: "PROJ-4242", confidence: 0.9 }),
          keep: [true]
        })
      )
      const progress = output(world.stderr)
      expect(progress).toContain("Read 1 in-scope session(s).")
      expect(progress).toContain("Asking claude about 1 session(s)")
      // A line per completed call, naming where it ran and what it decided — a start-and-finish
      // pair would leave the slow middle silent, which is what got reported as a hang.
      expect(progress).toContain("1/1")
      expect(progress).toContain("release-candidate @ work/integration")
      expect(progress).toContain("PROJ-4242 (0.90)")
      expect(progress).toContain("1 placed, 0 declined")
      // Progress is never part of the report body, so piping stays clean.
      expect(output(world.stdout)).not.toContain("Asking claude")
    }))

  // Attribution is the expensive, guessy half; a branch-attributed day must not pay for it. Writing
  // still costs one call for the notes, which is the whole of what a day of ticket-branch work spends.
  it.effect("attributes a branch-attributed day for free, and says nothing about attributing", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            "work-repo/s1.jsonl": transcript({
              sessionId: "s1",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-5662-otel",
              events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 30)
            })
          },
          keep: [true]
        })
      )
      expect(world.attributorRequests).toEqual([])
      expect(output(world.stderr)).not.toContain("Asking claude")
      // One call, and only because a row was written.
      expect(world.describeBatches).toHaveLength(1)
    }))

  it.effect("reports every session in a batch individually, with what was decided", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: integrationSessions(3),
          // Placed and declined within one call — both outcomes the progress line has to render.
          attributor: (request) => {
            const key = request.candidateKeys[0]
            return key === "PROJ-6002" ? { _tag: "None" } : { _tag: "Chosen", ticketKey: key!, confidence: 0.8 }
          },
          keep: [true, true]
        })
      )
      const progress = output(world.stderr)
      expect(progress).toContain("batched into 1 call(s)")
      expect(progress).toContain("1/3")
      expect(progress).toContain("3/3")
      expect(progress).toContain("PROJ-6000 (0.80)")
      expect(progress).toContain("none of the candidates")
      expect(progress).toContain("2 placed, 1 declined")
    }))

  // The cost of batching, stated plainly: one timeout loses every session in that call, not one.
  // It is why batches are bounded rather than sending the whole backlog in one go.
  it.effect("loses every session in a failed call, and says so for each", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({ transcripts: integrationSessions(3), attributor: () => "fail" })
      )
      const progress = output(world.stderr)
      expect(progress).toContain("0 placed, 0 declined, 3 unavailable.")
      expect(progress).toContain("unavailable — ")
      expect(output(world.stdout)).toContain("(unattributed)")
    }))

  it.effect("reports a below-floor choice without offering it", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: { "work-int/s-int.jsonl": integrationSession },
          attributor: () => ({ _tag: "Chosen", ticketKey: "PROJ-4242", confidence: 0.3 }),
          keep: [true]
        })
      )
      const printed = output(world.stdout)
      expect(printed).toContain("below the floor")
      expect(printed).toContain("Nothing to propose")
      expect(world.createdClockifyEntries).toEqual([])
    }))

  // A release-notes session references many tickets and works on none; "none of these" must be a
  // usable answer, not a forced choice.
  it.effect("reports a 'none of these' answer as unattributed hours", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          transcripts: { "work-int/s-int.jsonl": integrationSession },
          attributor: () => ({ _tag: "None" }),
          keep: []
        })
      )
      expect(output(world.stdout)).toContain("(unattributed)")
      expect(world.createdClockifyEntries).toEqual([])
    }))

  it.effect("degrades to deterministic proposals when the Coding Agent is unavailable", () =>
    Effect.gen(function*() {
      const { exit, world } = yield* run(
        agent(),
        baseOptions({
          transcripts: {
            "work-int/s-int.jsonl": integrationSession,
            "work-branchy/s-branch.jsonl": transcript({
              sessionId: "s-branch",
              cwd: `${WORK_ROOT}/repo`,
              gitBranch: "feat/PROJ-1-a",
              events: steady(at(DAY.year, DAY.month, DAY.day, 14, 0), 20)
            })
          },
          attributor: () => "fail",
          keep: [true]
        })
      )
      expect(exit._tag).toBe("Success")
      const printed = output(world.stdout)
      expect(printed).toContain("(unattributed)")
      expect(printed).toContain("unavailable")
      // The branch-attributed row still went through.
      expect(world.createdClockifyEntries).toHaveLength(1)
      expect(world.createdClockifyEntries[0]!.description).toContain("PROJ-1")
    }))

  it.effect("uses a Standing Attribution for recurring work with no ticket branch", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(),
        baseOptions({
          config: { sessionRoots: [WORK_ROOT], sessionTicketMap: { [`${WORK_ROOT}/docs`]: "DOCS-1" } },
          transcripts: {
            "work-docs/s-docs.jsonl": transcript({
              sessionId: "s-docs",
              cwd: `${WORK_ROOT}/docs/releases`,
              gitBranch: "master",
              events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 20)
            })
          },
          keep: [true]
        })
      )
      expect(output(world.prompts)).toContain("[standing]")
      expect(world.jiraWorklogs[0]!.issueKey).toBe("DOCS-1")
      // A Standing Attribution is deterministic, so it costs no Coding Agent call either.
      expect(world.attributorRequests).toEqual([])
    }))
})

// ---------------------------------------------------------------------------
// Direction mode: "in sync" must not mean "the other side is short"
// ---------------------------------------------------------------------------

describe("jcf sync reconcile <direction>", () => {
  // A direction only asks "is the target short?". Reporting "in sync" when the other side holds
  // hours the target does not reads as "everything matches", which is the opposite of the truth.
  it.effect("says which side is short instead of claiming everything matches", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        ["sync", "reconcile", "clockify-to-jira", ...SINCE],
        baseOptions({
          // Jira holds an hour Clockify never recorded — nothing to add *to Jira*.
          jiraWorklogs: {
            "PROJ-9": [{ started: iso(at(DAY.year, DAY.month, DAY.day, 12, 0)), timeSpentSeconds: 3600 }]
          }
        })
      )
      const printed = output(world.stdout)
      expect(printed).not.toContain("in sync with")
      expect(printed).toContain("Jira is not short of Clockify")
      expect(printed).toContain("Clockify is short by")
      expect(printed).toContain("jcf sync reconcile jira-to-clockify")
    }))

  it.effect("shows the issue summary on every row, not just the key", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        ["sync", "reconcile", "jira-to-clockify", ...SINCE],
        baseOptions({
          jiraWorklogs: {
            "PROJ-9": [{ started: iso(at(DAY.year, DAY.month, DAY.day, 12, 0)), timeSpentSeconds: 3600 }]
          },
          issueSummaries: { "PROJ-9": "Rotate the signing keys" },
          keep: [true]
        })
      )
      const printed = output(world.stdout)
      expect(printed).toContain("PROJ-9")
      expect(printed).toContain("Rotate the signing keys")
      expect(printed).toContain("· unassigned")
      // And inline in the confirmation, where the decision is made.
      expect(output(world.prompts)).toContain("PROJ-9 (Rotate the signing keys)")
    }))

  it.effect("still reports rows when a summary cannot be fetched", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        ["sync", "reconcile", "clockify-to-jira", ...SINCE],
        baseOptions({
          jiraWorklogs: {
            "PROJ-9": [{ started: iso(at(DAY.year, DAY.month, DAY.day, 12, 0)), timeSpentSeconds: 3600 }]
          },
          issueSummaries: {}
        })
      )
      expect(output(world.stdout)).toContain("PROJ-9")
    }))

  it.effect("still reports nothing to add when the two sides genuinely match", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        ["sync", "reconcile", "clockify-to-jira", ...SINCE],
        baseOptions({
          clockifyEntries: [{
            description: "[PROJ-9] work",
            start: iso(at(DAY.year, DAY.month, DAY.day, 12, 0)),
            end: iso(at(DAY.year, DAY.month, DAY.day, 13, 0))
          }],
          jiraWorklogs: {
            "PROJ-9": [{ started: iso(at(DAY.year, DAY.month, DAY.day, 12, 0)), timeSpentSeconds: 3600 }]
          }
        })
      )
      const printed = output(world.stdout)
      expect(printed).toContain("Jira is not short of Clockify")
      expect(printed).not.toContain("is short by")
    }))
})

// ---------------------------------------------------------------------------
// JSON Output Contract
// ---------------------------------------------------------------------------

describe("jcf sync reconcile --agent --json", () => {
  const options = () =>
    baseOptions({
      transcripts: {
        "work-repo/s1.jsonl": transcript({
          sessionId: "s1",
          cwd: `${WORK_ROOT}/repo`,
          gitBranch: "feat/PROJ-5662-otel",
          events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 30)
        })
      },
      // Deliberately available: --json must not write even when it could.
      keep: [true, true]
    })

  it.effect("writes exactly one JSON value to stdout and performs no writes", () =>
    Effect.gen(function*() {
      const { exit, world } = yield* run(agent(["--json"]), options())
      expect(exit._tag).toBe("Success")
      expect(world.stdout).toHaveLength(1)

      expect(JSON.parse(world.stdout[0]!)).toMatchObject({
        mode: "agent",
        agent: "claude",
        from: "2026-07-01",
        to: "2026-07-01"
      })
      // `summary` is present but null rather than omitted, so a consumer can tell "unknown" from
      // "never looked up".
      expect(jsonProposals(world.stdout)[0]).toHaveProperty("summary", null)

      expect(world.createdClockifyEntries).toEqual([])
      expect(world.jiraWorklogs).toEqual([])
    }))

  // Regression: an Effect log line went to stdout and turned "exactly one JSON value" into
  // unparseable output. Diagnostics are welcome, on stderr.
  it.effect("stays parseable when a session fails to attribute", () =>
    Effect.gen(function*() {
      const { world } = yield* run(
        agent(["--json"]),
        baseOptions({
          transcripts: {
            "work-int/s-int.jsonl": transcript({
              sessionId: "s-int",
              cwd: `${WORK_ROOT}/integration`,
              gitBranch: "develop",
              events: steady(at(DAY.year, DAY.month, DAY.day, 10, 0), 30, "rolling out PROJ-4242")
            })
          },
          attributor: () => "fail"
        })
      )
      expect(world.stdout).toHaveLength(1)
      const parsed: unknown = JSON.parse(world.stdout[0]!)
      expect(parsed).toMatchObject({ attributorAvailable: false, attributorCalls: 1 })
    }))

  it.effect("reports how many Coding Agent calls it made", () =>
    Effect.gen(function*() {
      const { world } = yield* run(agent(["--json"]), options())
      const parsed: unknown = JSON.parse(world.stdout[0]!)
      // Branch-attributed, so the run cost nothing.
      expect(parsed).toMatchObject({ attributorCalls: 0 })
    }))

  it.effect("keeps human-facing lines off stdout", () =>
    Effect.gen(function*() {
      const { world } = yield* run(agent(["--json"]), options())
      expect(world.stdout.join("\n")).not.toContain("Reconcile from")
    }))
})
