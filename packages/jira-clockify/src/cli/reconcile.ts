/**
 * `jcf sync reconcile` — compare Clockify time against Jira worklogs over a period and
 * fill gaps one row at a time.
 *
 * With `--agent claude` the same command switches to a different *source of evidence*: local
 * Claude Code Agent Sessions become Proposed Worklogs for the time neither side recorded. Agent
 * Sessions are never a third side of the reconciliation — see ADR-0006.
 *
 * @module
 */
import { Console, Data, Effect, Option, Runtime } from "effect"
import * as Terminal from "effect/Terminal"
import { Argument as Args, Command, Flag as Options, Prompt } from "effect/unstable/cli"
import type { AttributionSignal, CreditedSpan, SessionProposal } from "../agent/sessions.js"
import { ConfigService } from "../services/ConfigService.js"
import { isOwnedByMe, type IssueFact, IssueFacts } from "../services/IssueFacts.js"
import {
  type AttributionOutcome,
  type ReconcileDirection,
  type ReconcilePeriod,
  type ReconcileRow,
  ReconcileService,
  type SessionProposalProgress,
  type SessionProposalReport
} from "../services/ReconcileService.js"
import { formatDuration, localDay, nextLocalMidnight } from "../utils/time.js"
import { applyProposal, clip, entryDescription, keepGoing, proposalTargets, writeOutcomeLines } from "./agentWrite.js"
import { type CalendarRow, earliestStart, formatSpanBounds, formatSpanRanges, renderDayCalendar } from "./calendar.js"
import { fetchTicketByKey, NOT_LOGGED_IN_HINT } from "./fetchTicket.js"
import * as WatchLease from "./watchLease.js"

// Differences under a minute are noise (Jira floors worklogs to 60s), so don't flag them.
const TOLERANCE_SECONDS = 60

/** Start of a local calendar day `YYYY-MM-DD` (00:00 local). */
const startOfDay = (day: string): Date => new Date(`${day}T00:00:00`)

const isYmd = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s)

/**
 * Resolve the reconcile window from flags (local-day aligned, half-open `[from, to)`):
 * `--since/--until` (custom) wins, else `--week` (last 7 days incl. today), else today.
 */
export const resolvePeriod = (opts: {
  readonly week: boolean
  readonly since: string | undefined
  readonly until: string | undefined
}): ReconcilePeriod | { readonly error: string } => {
  const today = new Date()
  // The next local midnight, not 24 elapsed hours after this one. A spring-forward day is 23 hours
  // long, so `+24h` reached into the following day; a fall-back day is 25, so it stopped an hour
  // short and dropped 23:00–24:00 from the day the user asked for.
  const endExclusive = (day: string) => new Date(nextLocalMidnight(startOfDay(day).getTime()))

  if (opts.since !== undefined || opts.until !== undefined) {
    const fromDay = opts.since ?? localDay(today)
    const toDay = opts.until ?? localDay(today)
    if (!isYmd(fromDay) || !isYmd(toDay)) return { error: "Use --since/--until as YYYY-MM-DD." }
    if (fromDay > toDay) return { error: "--since must be on or before --until." }
    return { from: startOfDay(fromDay), to: endExclusive(toDay) }
  }
  if (opts.week) {
    const todayStart = startOfDay(localDay(today))
    const from = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() - 6)
    return { from, to: endExclusive(localDay(today)) }
  }
  return { from: startOfDay(localDay(today)), to: endExclusive(localDay(today)) }
}

/** `+Xs` worth of work the *target* is missing for this row, or 0 if it's not short. */
export const deltaToApply = (row: ReconcileRow, direction: ReconcileDirection): number => {
  const delta = direction === "clockify-to-jira"
    ? row.clockifySeconds - row.jiraSeconds
    : row.jiraSeconds - row.clockifySeconds
  return delta >= TOLERANCE_SECONDS ? delta : 0
}

const sign = (n: number): string => (n > 0 ? `+${formatDuration(n)}` : n < 0 ? `-${formatDuration(-n)}` : "0")

// ---------------------------------------------------------------------------
// Agent mode
// ---------------------------------------------------------------------------

/** Coding Agents whose sessions jcf can read. Codex records no git branch — see the spec. */
const SUPPORTED_AGENTS: ReadonlyArray<string> = ["claude"]

/** Wrong arguments, not a failed operation. Fails the command so a script sees a non-zero exit. */
export class ReconcileUsageError extends Data.TaggedError("ReconcileUsageError")<{
  readonly message: string
}> {
  override readonly [Runtime.errorReported] = false
}

/**
 * Which mode a `reconcile` invocation is in.
 *
 * `--agent` is a *mode switch*, not a direction: it changes where the evidence comes from, so
 * pairing it with a `direction` is contradictory rather than merely redundant. Reporting that as
 * an error is the point — silently honouring one of the two would leave the user guessing which.
 */
export type AgentModeResolution =
  | { readonly _tag: "Directions" }
  | { readonly _tag: "Agent"; readonly agent: string }
  | { readonly _tag: "UsageError"; readonly message: string }

/** Flags that only mean something in agent mode, so passing one without `--agent` is an error. */
const AGENT_ONLY_FLAGS: ReadonlyArray<{ readonly flag: string; readonly read: (o: AgentModeInput) => boolean }> = [
  { flag: "--json", read: (o) => o.json },
  { flag: "--calendar", read: (o) => o.calendar }
]

export interface AgentModeInput {
  readonly agent: string | undefined
  readonly direction: string | undefined
  readonly json: boolean
  readonly calendar: boolean
}

export const resolveAgentMode = (options: AgentModeInput): AgentModeResolution => {
  if (options.agent === undefined) {
    const stray = AGENT_ONLY_FLAGS.filter((candidate) => candidate.read(options)).map((candidate) => candidate.flag)
    if (stray.length > 0) {
      return {
        _tag: "UsageError",
        message: `${stray.join(" and ")} ${
          stray.length === 1 ? "applies" : "apply"
        } to \`--agent\` runs only. Use: jcf sync reconcile --agent claude ${stray.join(" ")}`
      }
    }
    return { _tag: "Directions" }
  }
  if (options.direction !== undefined) {
    return {
      _tag: "UsageError",
      message: `--agent cannot be combined with a direction ("${options.direction}"). --agent reads Agent Sessions ` +
        "as evidence for both sides at once. Use: jcf sync reconcile --agent claude"
    }
  }
  if (!SUPPORTED_AGENTS.includes(options.agent)) {
    return {
      _tag: "UsageError",
      message: `Unsupported agent "${options.agent}". Supported: ${SUPPORTED_AGENTS.join(", ")}.`
    }
  }
  return { _tag: "Agent", agent: options.agent }
}

/** How a row's evidence reads on screen, with the Coding Agent's confidence when there is one. */
const signalLabel = (signal: AttributionSignal, confidence: number | null): string =>
  confidence === null ? signal : `${signal} ${confidence.toFixed(2)}`

// `formatDuration` is 3-7 characters wide (`59s` through `34m 27s`), so pad to its maximum or the
// columns stop lining up and the report stops being scannable — which is the whole point of it.
const DURATION_WIDTH = 7

const duration = (seconds: number): string => formatDuration(seconds).padStart(DURATION_WIDTH)

/** What a row shows about its ticket beyond the key itself. */
interface TicketFacts {
  readonly summary: string
  /** Display name, or null when Jira omits it; this does not establish assignment. */
  readonly assignee: string | null
}

/**
 * Jira issue facts by key, for the rows about to be shown.
 *
 * An Issue Key alone is not enough to judge a proposal — `PROJ-5663` says nothing about whether that
 * afternoon's work belongs to it, and an issue assigned to someone else is a strong hint that the
 * attribution is wrong. One request per *distinct* key, so a week of rows on the same ticket costs
 * one lookup.
 *
 * Every failure mode degrades to "no facts": a missing Jira login, a deleted issue, or a network
 * error must not stop a run whose Clockify half is still perfectly writable.
 */
const resolveTickets = (keys: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const distinct = [...new Set(keys)]
    const results = yield* Effect.all(
      distinct.map((key) => fetchTicketByKey(key).pipe(Effect.map((result) => ({ key, result })))),
      { concurrency: 4 }
    )
    return new Map<string, TicketFacts>(
      results.flatMap(({ key, result }) =>
        result._tag === "Found"
          ? [[key, { summary: result.ticket.summary, assignee: result.ticket.assignee }]]
          : []
      )
    )
  })

/** Use the ownership answer for absence of assignment, never the optional display name. */
const assigneeLabel = (facts: TicketFacts, assignment: IssueFact["assignment"] | undefined): string | null =>
  assignment === "unassigned" ? "unassigned" : facts.assignee

/** The summary with the known assignee, which makes a misattributed row stand out. */
const ticketLine = (facts: TicketFacts, width: number, assignment: IssueFact["assignment"] | undefined): string => {
  const label = assigneeLabel(facts, assignment)
  return `${clip(facts.summary, width)}${label === null ? "" : `  · ${label}`}`
}

/** Keep a summary from wrapping the line it annotates. */
const SUMMARY_WIDTH = 64

/**
 * Indent for a reported row's summary, which goes on a line of its own.
 *
 * Underneath rather than inline: the numeric columns have to stay aligned for the list to be
 * scannable, and an issue title is far too variable in width to sit between them.
 */
const CONTINUATION = " ".repeat(14)

/** Inline in a yes/no confirmation, which has to stay on one line. */
const CONFIRM_SUMMARY_WIDTH = 44

/**
 * What the picker draws before a choice's title: `" " + checkbox + " "`. Every line of a title has
 * to fit inside the width that leaves, and the prompt appends a space and the description after it.
 */
const CHOICE_PREFIX_WIDTH = 4

/**
 * Aligns a choice's second line under the first. The picker renders a choice as
 * `" " + checkbox + " " + title`, so the title itself starts at column 4.
 */
const CHOICE_CONTINUATION = " ".repeat(6)

/** Enough of a title to recognise the issue; below this, clipping tells you nothing. */
const MIN_CHOICE_SUMMARY = 18

/** One `HH:MM-HH:MM`: the least that can be said about *when* the blocks were. */
const MIN_RANGE_TAIL = 11

/**
 * Everything known about one proposal, as the two lines of a picker choice.
 *
 * All of it belongs *here* rather than in a report printed above: the picker owns the screen from the
 * moment it opens, so anything printed before it has already scrolled past by the time there is a
 * decision to make — and a choice's `description` renders only while its row is highlighted, which
 * makes it the wrong home for anything that matters on every row.
 *
 * Two lines rather than one because the numeric columns have to stay aligned to be scannable and an
 * issue title is far too variable in width to sit between them. A newline inside a title is safe: the
 * prompt counts the rows it has to erase from the same choice text it renders, so the second line is
 * accounted for on redraw.
 *
 * The second line is packed to the terminal's width, with the summary — the only elastic part — given
 * whatever the fixed facts leave over. Neither line may reach the last column: the prompt appends a
 * space and the (empty) description after the title, and a line that fills the row wraps onto the
 * next one, costing a screen row and ragging the list.
 */
const choiceLines = (options: {
  readonly proposal: SessionProposal
  readonly tickets: ReadonlyMap<string, TicketFacts>
  readonly assignment: IssueFact["assignment"] | undefined
  readonly width: number
}): ReadonlyArray<string> => {
  const { assignment, proposal, tickets, width } = options
  const bounds = formatSpanBounds(proposal.blocks)
  const when = bounds === "" ? proposal.day : `${proposal.day} ${bounds}`
  // Clipped like the detail line is. The fields are padded to line the columns up, not bounded — a
  // long Issue Key with unequal gaps ("+10h Clockify, +9h Jira") already passes 80 columns, and the
  // prompt only counts the title lines it was given. The terminal soft-wraps the surplus, the erase
  // count is then one short, and every later row and redraw sits a line out of place while the user
  // is choosing what to write.
  const head = clip(
    `${when}  ${proposal.ticketKey.padEnd(12)} ${proposalTargets(proposal).padEnd(17)}` +
      ` [${signalLabel(proposal.signal, proposal.confidence)}]`,
    width - 1 - CHOICE_PREFIX_WIDTH
  )

  const facts = tickets.get(proposal.ticketKey)
  // A credited total below the wall-clock total means this key was worked on alongside others and
  // the overlap was split. Saying so keeps the smaller number from looking like a bug.
  const shared = proposal.activeSeconds - proposal.sessionSeconds
  // What each side already holds, shown only when it is not zero: that is the whole explanation for
  // an amount smaller than the credited total, and noise otherwise.
  const held = proposal.clockifySeconds === 0 && proposal.jiraSeconds === 0
    ? []
    : [`has Clockify ${formatDuration(proposal.clockifySeconds)}, Jira ${formatDuration(proposal.jiraSeconds)}`]
  // Who owns the issue and what the sides already hold: short, and each one can change the answer,
  // so the summary yields room to them rather than the other way round.
  const owner = facts === undefined ? null : assigneeLabel(facts, assignment)
  const qualifiers = [
    ...(owner === null ? [] : [owner]),
    ...held,
    ...(shared >= 60 ? [`${formatDuration(shared)} shared`] : [])
  ]
  // That the credited total covers several blocks rather than one stretch is worth a place of its
  // own; *which* blocks is the detail, and the only part worth losing to a narrow terminal.
  const blocks = proposal.blocks.length > 1 ? [`${proposal.blocks.length} blocks`] : []

  const separator = " · "
  const usable = width - 1 - CHOICE_CONTINUATION.length
  // Measured on the joined text rather than summed part by part, so what the summary is given is
  // exactly what is left: an estimate one character out puts the ellipsis mid-word on the tail.
  const reserved = [...qualifiers, ...blocks].join(separator)
  const room = usable - (reserved === "" ? 0 : reserved.length + separator.length)
  const kept = [
    ...(facts === undefined ? [] : [clip(facts.summary, Math.max(MIN_CHOICE_SUMMARY, room))]),
    ...(reserved === "" ? [] : [reserved])
  ].join(separator)

  // The block ranges go on only if a whole `HH:MM-HH:MM` fits after them. Appending them to a line
  // with no room left would spend the last few columns on an ellipsis and take a word with it.
  const ranges = usable - kept.length - separator.length
  const detail = proposal.blocks.length > 1 && ranges >= MIN_RANGE_TAIL
    ? `${kept}${separator}${clip(formatSpanRanges(proposal.blocks), ranges)}`
    : kept

  return detail === "" ? [head] : [head, `${CHOICE_CONTINUATION}${clip(detail, usable)}`]
}

/**
 * Rows shown at once. Each is two lines, so this is half of what the terminal can hold — enough to
 * compare a morning's worth of proposals without the list scrolling its own header away.
 */
const CHOICES_PER_PAGE = 8

/**
 * The width to lay rows out for.
 *
 * Capped because a full-screen-width row on a very wide terminal is harder to read than a clipped
 * one, and floored at the conventional 80 for anything narrower than a row can usefully be — a pipe
 * reports no width at all, and below 60 columns nothing fits either way.
 */
const layoutWidth = (columns: number): number => (columns >= 60 ? Math.min(columns, 160) : 80)

/**
 * The `--json` payload: exactly one value, carrying everything the human report shows so an
 * agent reading it is never worse informed than a person.
 *
 * Reporting only: it creates no Clockify entry and no Jira worklog. It does still refresh the local
 * timer-state cache from Clockify, because knowing a Timer is running is what lets the report
 * exclude that day.
 */
export const agentReportJson = (options: {
  readonly agent: string
  readonly period: ReconcilePeriod
  readonly report: SessionProposalReport
  readonly tickets: ReadonlyMap<string, TicketFacts>
  readonly ownershipWithheld: ReadonlyArray<
    SessionProposal & {
      readonly reason: "other-assignee" | "unassigned"
    }
  >
}) => {
  // `summary` and `assignee` are null when Jira could not be reached or the issue is gone — never
  // omitted, so a consumer can tell "unknown" from "not looked up".
  const withSummary = <T extends { readonly ticketKey: string; readonly blocks: ReadonlyArray<CreditedSpan> }>(
    row: T
  ) => {
    const first = earliestStart(row.blocks)
    const last = row.blocks.length === 0
      ? null
      : row.blocks.reduce((latest, block) => Math.max(latest, block.endMs), -Infinity)
    return {
      ...row,
      summary: options.tickets.get(row.ticketKey)?.summary ?? null,
      assignee: options.tickets.get(row.ticketKey)?.assignee ?? null,
      // The outer bounds of the work item, so a consumer never has to fold `blocks` itself.
      startedAt: first?.toISOString() ?? null,
      endedAt: last === null ? null : new Date(last).toISOString()
    }
  }
  return {
    mode: "agent",
    agent: options.agent,
    from: localDay(options.period.from),
    to: localDay(new Date(options.period.to.getTime() - 1)),
    sessionCount: options.report.sessionCount,
    sessionRootCount: options.report.sessionRootCount,
    attributorAvailable: options.report.attributorAvailable,
    attributorCalls: options.report.attributorCalls,
    proposals: options.report.proposals.map(withSummary),
    withheld: options.report.withheld.map(withSummary),
    ownershipWithheld: options.ownershipWithheld.map(withSummary),
    unattributed: options.report.unattributed,
    excludedDays: options.report.excludedDays
  }
}

/** The tail of a path, for naming a session by somewhere recognisable rather than by a UUID. */
const lastSegments = (path: string, count = 2): string => path.split("/").filter(Boolean).slice(-count).join("/")

/** How one finished Coding Agent call reads. */
const outcomeLabel = (outcome: AttributionOutcome): string => {
  switch (outcome._tag) {
    case "Placed":
      return `${outcome.ticketKey} (${outcome.confidence.toFixed(2)})`
    case "Declined":
      return "none of the candidates"
    case "Unavailable":
      return `unavailable — ${outcome.message}`
  }
}

/**
 * Progress, always on stderr: it is not part of the report and never part of the JSON value.
 *
 * One line per completed Coding Agent call. Written as whole lines rather than an in-place counter
 * because there is no way to tell a terminal from a pipe without reaching for host APIs, and a
 * carriage-return spinner in a log file is worse than a few extra lines in a terminal.
 */
const reportProgress = (agent: string, progress: SessionProposalProgress): Effect.Effect<void> => {
  switch (progress._tag) {
    case "AgentActivity":
      return progress.kind === "status"
        ? Console.error(`    Batch ${progress.batch}/${progress.batches}: ${progress.text}`)
        : Effect.void
    case "ReadingRecordedTime":
      return Console.error("  Reading recorded time and checking running timers.")
    case "SessionsRead":
      return Console.error(`  Read ${progress.count} in-scope session(s).`)
    case "AttributingSessions":
      return Console.error(
        `  Asking ${agent} about ${progress.count} session(s) no branch or path could place` +
          `, batched into ${progress.calls} call(s) — this is the slow part:`
      )
    case "SessionAttributed":
      return Console.error(
        `    ${String(progress.done).padStart(String(progress.total).length)}/${progress.total}` +
          `  ${progress.gitBranch ?? "(no branch)"} @ ${lastSegments(progress.cwd)}` +
          `  ->  ${outcomeLabel(progress.outcome)}`
      )
    case "SessionsAttributed":
      return Console.error(
        `  ...${progress.placed} placed, ${progress.declined} declined` +
          (progress.unavailable > 0 ? `, ${progress.unavailable} unavailable` : "") + "."
      )
  }
}

/** Group the day's rows so each day gets one grid, in day order. */
const calendarByDay = (proposals: ReadonlyArray<SessionProposal>): ReadonlyArray<[string, Array<CalendarRow>]> => {
  const days = new Map<string, Array<CalendarRow>>()
  for (const proposal of proposals) {
    const rows = days.get(proposal.day) ?? []
    rows.push({ ticketKey: proposal.ticketKey, spans: proposal.blocks })
    days.set(proposal.day, rows)
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b))
}

const runAgentMode = (options: {
  readonly agent: string
  readonly period: ReconcilePeriod
  readonly json: boolean
  readonly calendar: boolean
}) =>
  Effect.gen(function*() {
    const svc = yield* ReconcileService
    const config = yield* ConfigService
    const issues = yield* IssueFacts
    // In --json mode every human-facing line goes to stderr so stdout holds one JSON value.
    const say = options.json ? Console.error : Console.log

    // Progress goes to stderr in both modes: it is not part of the JSON value, and reading
    // transcripts then waking a Coding Agent takes long enough that silence reads as a hang.
    const report = yield* svc.proposeFromSessions(options.period, {
      onProgress: (progress) => reportProgress(options.agent, progress)
    }).pipe(
      Effect.catch((error) => Console.error(`Agent reconcile failed: ${error.message}`).pipe(Effect.as(null)))
    )
    // A failed run must not look like an empty one. Under `--json` that distinction is the whole
    // contract: silence on stdout with a zero exit reads as "no unlogged work", and the skill tells
    // an agent to act on exactly that. So the message goes to stderr and the command fails.
    if (report === null) {
      return yield* new ReconcileUsageError({ message: "Could not read Agent Sessions." })
    }

    const ownershipSettings = yield* config.get
    const ownershipFacts = ownershipSettings.sessionOwnership === "assigned"
      ? (yield* issues.lookup(report.proposals.map((proposal) => proposal.ticketKey))).facts
      : new Map()
    const ownership = {
      facts: ownershipFacts,
      mode: ownershipSettings.sessionOwnership,
      overrides: ownershipSettings.sessionOwnershipOverrides
    }
    const proposals = report.proposals.filter((proposal) => isOwnedByMe(proposal.ticketKey, ownership))
    const notOwned = report.proposals.filter((proposal) => !isOwnedByMe(proposal.ticketKey, ownership))
    const offeredReport = { ...report, proposals }

    // Looked up for every row that names an Issue Key, including the withheld ones — a row you
    // cannot identify is a row you cannot judge, whether or not it is offered.
    const tickets = yield* resolveTickets([
      ...report.proposals.map((proposal) => proposal.ticketKey),
      ...report.withheld.map((entry) => entry.ticketKey)
    ])

    if (options.json) {
      yield* Console.log(JSON.stringify(
        agentReportJson({
          ...options,
          report: offeredReport,
          tickets,
          ownershipWithheld: notOwned.map((proposal) => ({
            ...proposal,
            reason: ownership.facts.get(proposal.ticketKey)?.assignment === "unassigned"
              ? "unassigned"
              : "other-assignee"
          }))
        }),
        null,
        2
      ))
      return
    }

    const fromDay = localDay(options.period.from)
    const toDay = localDay(new Date(options.period.to.getTime() - 1))
    yield* say(
      `Reconcile from ${options.agent} Agent Sessions  (${fromDay === toDay ? fromDay : `${fromDay}..${toDay}`})`
    )

    if (report.sessionCount === 0) {
      yield* say("  No in-scope Agent Sessions in this period.")
      if (report.sessionRootCount === 0) {
        yield* say("  Nothing is opted in yet. Add a Session Root: jcf config set session-root <dir>")
      }
      return
    }

    // Proposals are *not* listed here. They are the picker's rows, and printing them twice pushes the
    // rows that are only ever reported — withheld, unattributed, skipped — off the top of the screen.
    for (const entry of report.withheld) {
      const facts = tickets.get(entry.ticketKey)
      yield* say(
        `  ${entry.day}  ${entry.ticketKey.padEnd(12)} ${duration(entry.seconds)}` +
          `  not offered — confidence ${entry.confidence?.toFixed(2) ?? "unknown"} is below the floor`
      )
      if (facts !== undefined) {
        yield* say(`${CONTINUATION}${
          ticketLine(
            facts,
            SUMMARY_WIDTH,
            ownership.facts.get(entry.ticketKey)?.assignment
          )
        }`)
      }
    }
    for (const entry of notOwned) {
      const fact = ownership.facts.get(entry.ticketKey)
      const owner = fact?.assignment === "unassigned"
        ? "unassigned"
        : `assigned to ${fact?.assignee ?? "somebody else"}`
      yield* say(
        `  ${entry.day}  ${entry.ticketKey.padEnd(12)} ${duration(entry.sessionSeconds)}` +
          `  not offered — ${owner}`
      )
      const facts = tickets.get(entry.ticketKey)
      if (facts !== undefined) yield* say(`${CONTINUATION}${ticketLine(facts, SUMMARY_WIDTH, fact?.assignment)}`)
    }
    for (const entry of report.unattributed) {
      yield* say(
        `  ${entry.day}  ${"(unattributed)".padEnd(12)} ${duration(entry.seconds)}` +
          `  ${entry.sessionCount} session(s) no signal could place`
      )
    }
    if (options.calendar) {
      for (const [day, rows] of calendarByDay(proposals)) {
        yield* say("")
        for (const line of renderDayCalendar({ day, rows })) yield* say(line)
      }
      if (proposals.length > 0) yield* say("")
    }

    for (const excluded of report.excludedDays) {
      yield* say(`  ${excluded.day}  skipped — ${excluded.reason}`)
    }
    if (!report.attributorAvailable) {
      yield* say("  A Coding Agent was needed but unavailable; those sessions are listed as unattributed.")
    }

    if (proposals.length === 0) {
      if (notOwned.length === 0) {
        yield* say("  Nothing to propose — both sides already hold everything these sessions account for.")
      }
      return
    }

    const clockifyTotal = proposals.reduce((sum, p) => sum + p.clockifyDelta, 0)
    const jiraTotal = proposals.reduce((sum, p) => sum + p.jiraDelta, 0)
    yield* say(
      `\n  Would add Clockify ${formatDuration(clockifyTotal)}, Jira ${formatDuration(jiraTotal)}` +
        ` across ${proposals.length} row(s).`
    )

    const terminal = yield* Terminal.Terminal
    const width = layoutWidth(yield* terminal.columns)
    // Rows carried alongside their proposal rather than in a parallel array indexed back into: the
    // picker and the no-TTY fallback both need the pair, and an index is one refactor away from
    // silently pointing at the wrong row.
    const choiceRows = proposals.map((proposal) => ({
      proposal,
      lines: choiceLines({
        proposal,
        tickets,
        assignment: ownership.facts.get(proposal.ticketKey)?.assignment,
        width
      })
    }))

    // One picker rather than a row-by-row interrogation: these rows are one reconstruction of one
    // period, and seeing them together is what lets a wrong attribution stand out against the
    // others. Everything starts checked, so the common "all of it" case is a single Enter.
    const chosen = yield* Prompt.multiSelect({
      message: "  Space toggles a row, Enter writes the checked ones:",
      maxPerPage: CHOICES_PER_PAGE,
      choices: choiceRows.map((row) => ({
        title: row.lines.join("\n"),
        value: row.proposal,
        selected: true
      }))
    }).pipe(
      // A terminal that cannot be read (no TTY, or Ctrl-C) ends the run having written nothing.
      // The rows go out as a plain report instead: piping this command must still say what it found.
      Effect.catch((error) =>
        Effect.forEach(choiceRows.flatMap((row) => row.lines), (line) => say(`  ${line}`)).pipe(
          Effect.andThen(say(`  Nothing written: ${error.message}`)),
          Effect.as(null)
        )
      )
    )
    if (chosen === null) return

    if (chosen.length === 0) {
      yield* say("  Nothing selected — nothing written.")
      return
    }

    // Asked only about the rows that are actually being written, and only once for all of them —
    // describing a row the user just unchecked would be paid for and thrown away.
    // On stderr with the rest of the progress: it says what the wait is for, and a wait is not part
    // of the report a pipe should receive.
    yield* Console.error(`  Describing ${chosen.length} row(s) with ${options.agent}…`)
    const notes = yield* svc.describeProposals({
      proposals: chosen,
      digests: report.digests,
      summaries: new Map([...tickets].map(([key, facts]) => [key, facts.summary]))
    })

    yield* Effect.acquireUseRelease(
      WatchLease.acquire({ intervalSeconds: 300 }),
      (lease) => {
        if (lease._tag !== "Held") {
          return say(
            lease._tag === "Taken"
              ? "  Nothing written: another JCF writer holds the machine guard."
              : `  Nothing written: ${lease.reason}.`
          )
        }
        return Effect.gen(function*() {
          // Review and description generation are unbounded. Take the writer guard, then re-tally
          // inside it so no watch, browser tab or second reconcile can authorize the same gap.
          const refreshed = yield* svc.refreshRecordedTime(options.period, report)
          const currentSettings = yield* config.get
          const currentFacts = currentSettings.sessionOwnership === "assigned"
            ? (yield* issues.lookup(chosen.map((proposal) => proposal.ticketKey))).facts
            : new Map()
          const currentOwnership = {
            facts: currentFacts,
            mode: currentSettings.sessionOwnership,
            overrides: currentSettings.sessionOwnershipOverrides
          }

          for (const [index, selected] of chosen.entries()) {
            if (!isOwnedByMe(selected.ticketKey, currentOwnership)) {
              const fact = currentOwnership.facts.get(selected.ticketKey)
              const owner = fact?.assignment === "unassigned"
                ? "unassigned"
                : `assigned to ${fact?.assignee ?? "somebody else"}`
              yield* say(`  ${selected.day}  ${selected.ticketKey}  skipped — ${owner}`)
              continue
            }
            const excluded = refreshed.excludedDays.find(({ day }) => day === selected.day)
            const proposal = refreshed.proposals.find((candidate) =>
              candidate.ticketKey === selected.ticketKey && candidate.day === selected.day
            )
            if (excluded !== undefined) {
              yield* say(`  ${selected.day}  ${selected.ticketKey}  skipped — ${excluded.reason}`)
              continue
            }
            if (proposal === undefined) {
              yield* say(`  ${selected.day}  ${selected.ticketKey}  already logged — nothing written`)
              continue
            }
            const approved = {
              ...proposal,
              clockifyDelta: Math.min(selected.clockifyDelta, proposal.clockifyDelta),
              jiraDelta: Math.min(selected.jiraDelta, proposal.jiraDelta)
            }
            const description = entryDescription({
              summary: tickets.get(approved.ticketKey)?.summary ?? null,
              note: notes[index] ?? null
            })
            yield* say(`  ${approved.day}  ${approved.ticketKey}  ${proposalTargets(approved)}`)
            // Printed before the write, and in full: this text lands in two systems other people read,
            // so it should never be a surprise found later in Clockify.
            yield* say(`    ${description}`)
            const written = yield* applyProposal(
              svc,
              approved,
              description,
              refreshed.sourceScopes ?? {
                clockify: null,
                jira: null
              },
              undefined,
              refreshed.jiraAvailability
            )
            yield* Effect.forEach(writeOutcomeLines(written), (line) => say(`    ${line}`))
            if (!keepGoing(written)) return
          }
        })
      },
      (lease) => lease._tag === "Held" ? WatchLease.releaseGuard(lease) : Effect.void
    )
  })

export const reconcile = Command.make(
  "reconcile",
  {
    direction: Args.string("direction").pipe(Args.optional),
    week: Options.boolean("week").pipe(
      Options.withDescription("Reconcile the last 7 days (default: today)"),
      Options.withDefault(false)
    ),
    day: Options.boolean("day").pipe(
      Options.withDescription("Reconcile today (the default)"),
      Options.withDefault(false)
    ),
    since: Options.string("since").pipe(
      Options.withDescription("Start of a custom window, YYYY-MM-DD"),
      Options.optional
    ),
    until: Options.string("until").pipe(
      Options.withDescription("End of a custom window (inclusive), YYYY-MM-DD"),
      Options.optional
    ),
    agent: Options.string("agent").pipe(
      Options.withDescription(
        "Propose worklogs from a Coding Agent's sessions instead of comparing sides (claude)"
      ),
      Options.optional
    ),
    json: Options.boolean("json").pipe(
      Options.withDescription("With --agent: one JSON value on stdout; creates no Clockify entry or Jira worklog"),
      Options.withDefault(false)
    ),
    calendar: Options.boolean("calendar").pipe(
      Options.withDescription("With --agent: draw an hour-by-hour grid of when the time was credited"),
      Options.withDefault(false)
    )
  },
  ({ agent, calendar, direction, json, since, until, week }) =>
    Effect.gen(function*() {
      const mode = resolveAgentMode({
        agent: Option.isSome(agent) ? agent.value : undefined,
        direction: Option.isSome(direction) ? direction.value : undefined,
        json,
        calendar
      })
      if (mode._tag === "UsageError") {
        // Printed here rather than left to the runtime: a usage mistake should read as advice, not
        // as a stack trace. The failure still propagates so the process exits non-zero, and the
        // binary disables runtime error reporting so this is not also printed a second time.
        yield* Console.error(mode.message)
        return yield* new ReconcileUsageError({ message: mode.message })
      }

      // The window is resolved the same way in both modes, so `--day/--week/--since/--until`
      // mean exactly one thing regardless of where the evidence comes from.
      const period = resolvePeriod({
        week,
        since: Option.isSome(since) ? since.value : undefined,
        until: Option.isSome(until) ? until.value : undefined
      })
      if ("error" in period) {
        yield* Console.log(period.error)
        return
      }

      if (mode._tag === "Agent") {
        return yield* runAgentMode({ agent: mode.agent, period, json, calendar })
      }

      const dir = Option.isSome(direction) ? direction.value : "clockify-to-jira"
      if (dir !== "clockify-to-jira" && dir !== "jira-to-clockify") {
        yield* Console.log(
          "Usage: jcf sync reconcile [clockify-to-jira|jira-to-clockify] [--day|--week|--since|--until]"
        )
        return
      }
      const directionTag: ReconcileDirection = dir

      const svc = yield* ReconcileService
      const rows = yield* svc.compare(period).pipe(
        Effect.catch((e) => Console.log(`Reconcile failed: ${e.message}`).pipe(Effect.as(null)))
      )
      if (rows === null) return

      const fromDay = localDay(period.from)
      const toDay = localDay(new Date(period.to.getTime() - 1))
      yield* Console.log(
        `Reconcile ${directionTag}  (${fromDay === toDay ? fromDay : `${fromDay}..${toDay}`})`
      )

      if (rows.length === 0) {
        yield* Console.log("  No time logged on either side for this period.")
        return
      }

      // Same reason as agent mode: an Issue Key alone does not say whether a discrepancy is worth
      // fixing. One lookup per distinct key, and a missing one costs the name, never the run.
      const tickets = yield* resolveTickets(rows.map((row) => row.ticketKey))

      // Report every bucket, marking the gap relative to the chosen target.
      for (const row of rows) {
        const delta = row.clockifySeconds - row.jiraSeconds
        const mark = Math.abs(delta) < TOLERANCE_SECONDS ? "=" : "Δ"
        yield* Console.log(
          `  ${row.day}  ${row.ticketKey.padEnd(12)} Clockify ${formatDuration(row.clockifySeconds).padStart(6)}` +
            `  Jira ${formatDuration(row.jiraSeconds).padStart(6)}  ${mark} ${sign(delta)}`
        )
        const facts = tickets.get(row.ticketKey)
        if (facts !== undefined) yield* Console.log(`${CONTINUATION}${ticketLine(facts, SUMMARY_WIDTH, undefined)}`)
      }

      const fixable = rows.filter((r) => deltaToApply(r, directionTag) > 0)
      if (fixable.length === 0) {
        const target = directionTag === "clockify-to-jira" ? "Jira" : "Clockify"
        const other = directionTag === "clockify-to-jira" ? "Clockify" : "Jira"
        const reverse: ReconcileDirection = directionTag === "clockify-to-jira"
          ? "jira-to-clockify"
          : "clockify-to-jira"
        // A direction only ever asks "is the target short?". Saying "in sync" when the *other*
        // side is short reads as "everything matches", which is exactly wrong — and the reverse
        // run is the thing the user actually wants next.
        const reverseShortfall = rows.reduce((total, row) => total + deltaToApply(row, reverse), 0)
        yield* Console.log(`  ${target} is not short of ${other} — nothing to add in this direction.`)
        if (reverseShortfall > 0) {
          yield* Console.log(
            `  ${other} is short by ${formatDuration(reverseShortfall)}. This is not "in sync";` +
              ` run: jcf sync reconcile ${reverse}`
          )
        }
        return
      }

      const target = directionTag === "clockify-to-jira" ? "Jira" : "Clockify"
      yield* Console.log(`\n  ${fixable.length} row(s) where ${target} is short — confirm each fix:`)

      const approved: Array<{ readonly row: ReconcileRow; readonly delta: number }> = []
      for (const row of fixable) {
        const delta = deltaToApply(row, directionTag)
        const facts = tickets.get(row.ticketKey)
        const ticket = facts === undefined
          ? row.ticketKey
          : `${row.ticketKey} (${clip(facts.summary, CONFIRM_SUMMARY_WIDTH)})`
        const apply = yield* Prompt.confirm({
          message: `  Add ${formatDuration(delta)} to ${target} for ${ticket} on ${row.day}?`,
          initial: true
        })
        if (!apply) continue
        approved.push({ row, delta })
      }
      if (approved.length === 0) return

      yield* Effect.acquireUseRelease(
        WatchLease.acquire({ intervalSeconds: 300 }),
        (lease) => {
          if (lease._tag !== "Held") {
            return Console.log(
              lease._tag === "Taken"
                ? "  Nothing written: another JCF writer holds the machine guard."
                : `  Nothing written: ${lease.reason}.`
            )
          }
          return Effect.gen(function*() {
            // Confirmation can take arbitrarily long. Admit the whole approved batch first, then
            // re-read under the guard so another writer cannot fill a gap between tally and write.
            const refreshed = yield* svc.compare(period).pipe(
              Effect.catch((e) => Console.log(`Reconcile failed: ${e.message}`).pipe(Effect.as(null)))
            )
            if (refreshed === null) return

            for (const selection of approved) {
              const row = refreshed.find((candidate) =>
                candidate.ticketKey === selection.row.ticketKey && candidate.day === selection.row.day
              )
              const remaining = row === undefined
                ? 0
                : Math.min(selection.delta, deltaToApply(row, directionTag))
              if (remaining === 0) {
                yield* Console.log(
                  `    ${selection.row.ticketKey} ${selection.row.day}: already logged — nothing written`
                )
                continue
              }

              if (directionTag === "clockify-to-jira") {
                const outcome = yield* svc.applyToJira(
                  selection.row.ticketKey,
                  selection.row.day,
                  remaining,
                  row?.clockifyDescription ?? selection.row.clockifyDescription ?? undefined
                )
                if (outcome._tag === "Posted") {
                  yield* Console.log(`    ✓ posted to Jira`)
                } else if (outcome._tag === "NotLoggedIn") {
                  yield* Console.log(`    ✗ ${NOT_LOGGED_IN_HINT}`)
                  return // no point continuing — every Jira write will fail
                } else if (outcome._tag === "VerificationUnavailable") {
                  yield* Console.log(`    ✗ the Jira account could not be verified; refresh before writing`)
                  return
                } else {
                  yield* Console.log(`    ✗ ${outcome.message}`)
                }
              } else {
                const ok = yield* svc.applyToClockify(selection.row.ticketKey, selection.row.day, remaining).pipe(
                  Effect.catch((e) => Console.log(`    ✗ ${e.message}`).pipe(Effect.as(false)))
                )
                if (ok) yield* Console.log(`    ✓ created Clockify entry`)
              }
            }
          })
        },
        (lease) => lease._tag === "Held" ? WatchLease.releaseGuard(lease) : Effect.void
      )
    })
)

export const sync = Command.make("sync", {}, () => Console.log("Usage: jcf sync reconcile")).pipe(
  Command.withDescription("Sync workflow commands"),
  Command.withSubcommands([reconcile])
)
