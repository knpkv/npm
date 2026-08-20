/**
 * `jcf watch claude` — log Agent Session time as it happens, without being asked each time.
 *
 * **Mental model**
 *
 * - **`reconcile --agent` on a loop, with the picker removed.** Nothing new is derived here. A
 *   proposal is still `session − (already recorded)`, which is what makes a repeating writer safe:
 *   a failed write, a half-written row, or a laptop that slept all afternoon simply shows up as the
 *   same gap on the next tick.
 * - **Writes what it can defend.** Unattended, it writes only blocks that have settled and only
 *   attributions a person deliberately created — a branch name, a worktree path, a Standing
 *   Attribution. Everything else is named on screen and left for `jcf sync reconcile --agent`.
 * - **Forward only, bar one settle window.** The window opens a settle period before the watch
 *   does — the stretch nothing could have written yet, so a restart recovers the tail it was
 *   holding rather than dropping it. Nothing older: a command that writes hours you have not seen is
 *   the one thing worse than a command that writes nothing. Work older than that window is
 *   `reconcile`'s, which shows you the rows first.
 *
 * **Gotchas**
 *
 * - The interval is how often it *looks*, not how quickly a block is written. A block is written on
 *   the first tick after it settles, so the lag is up to one interval past the settle deadline.
 * - Jira refusing the login stops the watch rather than retrying. Every later write would fail the
 *   same way, and a watch that logs to Clockify alone for six hours quietly recreates the
 *   discrepancy the tool exists to close.
 *
 * @module
 */
import { Console, Data, Effect, Option } from "effect"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import { Argument as Args, Command, Flag as Options } from "effect/unstable/cli"
import type { SessionProposal } from "../agent/sessions.js"
import { decideWatchWrites, type HeldProposal, SETTLE_GRACE_SECONDS } from "../agent/watch.js"
import { ConfigService } from "../services/ConfigService.js"
import { ReconcileService } from "../services/ReconcileService.js"
import { formatClock, formatDuration } from "../utils/time.js"
import { applyProposal, entryDescription, proposalTargets } from "./agentWrite.js"
import { fetchTicketByKey } from "./fetchTicket.js"
import * as WatchLease from "./watchLease.js"

/** Coding Agents whose sessions jcf can watch. Matches `reconcile --agent`. */
const SUPPORTED_AGENTS: ReadonlyArray<string> = ["claude"]

/**
 * How often to look, in seconds.
 *
 * Deliberately much longer than it takes to read the transcripts. A block is not writable until it
 * has settled anyway, so a faster poll buys no earlier write — only more work per hour to reach the
 * same answer.
 */
const DEFAULT_INTERVAL_SECONDS = 300

/** Wrong arguments, not a failed operation — fails the command so a script sees a non-zero exit. */
export class WatchUsageError extends Data.TaggedError("WatchUsageError")<{
  readonly message: string
}> {}

/** Why a tick stopped the watch, or that it did not. */
type TickOutcome =
  | { readonly _tag: "Continue" }
  | { readonly _tag: "Stop"; readonly reason: string }

/** What one watch run has written so far, for the line it prints on the way out. */
interface WatchTotals {
  blocks: number
  clockifySeconds: number
  jiraSeconds: number
}

/**
 * A cadence as a person would say it: `5m`, not `5m 0s`.
 *
 * `formatDuration` always spells the seconds out because it reports *worked* time, where the odd
 * seconds are the point. An interval is a round number nobody wants read back to them.
 */
const cadence = (seconds: number): string => formatDuration(seconds).replace(/ 0s$/, "")

/** How a held row reads on screen — one line, saying what would unblock it. */
const heldLine = (held: HeldProposal): string => {
  const when = held.reason._tag === "Unsettled"
    ? `settles at ${formatClock(new Date(held.reason.settlesAtMs))}`
    : "needs review — run jcf sync reconcile --agent claude"
  return `  ${held.proposal.ticketKey.padEnd(12)} ${proposalTargets(held.proposal).padEnd(17)} ${when}`
}

/** The bucket a held or reported row belongs to, for saying a thing once rather than every tick. */
const rowKey = (row: { readonly ticketKey: string; readonly day: string }): string => `${row.ticketKey}\u0000${row.day}`

/**
 * What makes a dry-run preview distinct from one already shown.
 *
 * The bucket alone is not enough: a ticket worked again after lunch produces a genuinely different
 * proposal for the same `(key, day)`, and that one deserves its own line. The deltas change whenever
 * there is anything new to say, so they belong in the key.
 */
const previewKey = (proposal: SessionProposal): string =>
  `${rowKey(proposal)}\u0000${proposal.clockifyDelta}\u0000${proposal.jiraDelta}`

export const runWatch = (options: {
  readonly agent: string
  readonly intervalSeconds: number
  readonly dryRun: boolean
}) =>
  Effect.gen(function*() {
    const svc = yield* ReconcileService
    const config = yield* ConfigService
    const cfg = yield* config.get
    const startedAtMs = yield* Clock.currentTimeMillis
    const settleSeconds = cfg.sessionIdleCapSeconds + SETTLE_GRACE_SECONDS

    const totals: WatchTotals = { blocks: 0, clockifySeconds: 0, jiraSeconds: 0 }
    // Said once per bucket, not once per tick: a ticket that cannot be placed would otherwise
    // repeat its own line every interval until the watch is killed.
    const announced = new Set<string>()

    if (cfg.sessionRoots.length === 0) {
      yield* Console.log("Nothing is opted in yet. Add a Session Root: jcf config set session-root <dir>")
      return
    }

    // One writer at a time. Subtracting what the sides hold makes a later tick safe and says nothing
    // about a simultaneous one: two watches can read the same gap before either writes it.
    const lease = yield* WatchLease.acquire({ intervalSeconds: options.intervalSeconds })
    if (lease._tag === "Taken") {
      yield* Console.log(
        `Another jcf watch has been running since ${formatClock(new Date(lease.sinceMs))}.` +
          " Two would write the same hours twice, so this one is stopping."
      )
      return
    }
    if (lease._tag === "Unavailable") {
      // Not the same as losing the race, and not something to shrug off: with no lease on disk there
      // is nothing to stop a second watch deriving the same gap and writing it a second time.
      yield* Console.error(`Cannot take the watch lease — ${lease.reason}.`)
      return yield* new WatchUsageError({ message: `Cannot take the watch lease: ${lease.reason}` })
    }
    const leasePath = lease.path
    const leaseOwner = lease.owner

    /**
     * Where this run starts looking.
     *
     * The cursor alone, with no floor of its own. Taking `max(cursor, now − settleWindow)` looked
     * safer and was the opposite: an old cursor then resolved to `now − settleWindow`, so every
     * restart back-dated a fresh window of unreviewed work. The lease decides whether a resume is
     * offered at all — only when the previous holder stopped recently — so by the time there is a
     * cursor here, reaching to it is exactly resuming what that run was already holding.
     */
    const watchFromMs = lease.resumeFromMs ?? startedAtMs

    yield* Console.log(
      `jcf watch ${options.agent}${options.dryRun ? "  (dry run — writes nothing)" : ""}`
    )
    yield* Console.log(
      `  Looking every ${cadence(options.intervalSeconds)}, from ${formatClock(new Date(watchFromMs))}.` +
        ` A block is written once it has been quiet for ${cadence(settleSeconds)}.`
    )
    yield* Console.log(
      "  Only branch-, path-, and standing-attributed work is written. Earlier work and anything" +
        " needing review: jcf sync reconcile --agent claude"
    )

    const carryOn: TickOutcome = { _tag: "Continue" }

    /**
     * One pass: derive, decide, describe, write.
     *
     * The window starts where the watch did, so the recorded side is measured over exactly the
     * span the session side is — a Clockify entry from before the watch began belongs to neither.
     */
    // The earliest instant this run has not resolved. Seeded at the window's start and moved forward
    // only past work that is settled and dealt with, so a run stopped mid-block leaves the block's
    // own start behind rather than the moment it happened to stop — resuming from the latter would
    // filter out the very prompts that made the block unsettled.
    let unresolvedFromMs = watchFromMs

    /**
     * Say we are still here, and stop if we are not.
     *
     * Called at the top of a tick and again immediately before writing. A tick can outlive its own
     * stale window — deriving, describing and writing all take time a `--interval 1` watch does not
     * have — and a contender that reclaimed the lease in the meantime would otherwise be writing the
     * same blocks in parallel. Two checks bound the exposure to one tick's write phase.
     */
    const stillMine = Effect.gen(function*() {
      const standing = yield* WatchLease.refresh({
        path: leasePath,
        owner: leaseOwner,
        heldSinceMs: startedAtMs,
        intervalSeconds: options.intervalSeconds,
        unresolvedFromMs
      })
      return standing._tag === "Mine"
        ? null
        : ({ _tag: "Stop", reason: `${standing.reason}, so this one is standing down.` } satisfies TickOutcome)
    })

    const tick = Effect.gen(function*() {
      const nowMs = yield* Clock.currentTimeMillis
      const held = yield* stillMine
      if (held !== null) return held
      const report = yield* svc.proposeFromSessions(
        { from: new Date(watchFromMs), to: new Date(nowMs) },
        { attribution: "deterministic" }
      ).pipe(
        // A tick that cannot read is a tick that writes nothing. The next one re-derives from
        // scratch, so a transient failure costs a delay rather than an hour.
        Effect.catch((error) => Console.error(`  Could not read sessions: ${error.message}`).pipe(Effect.as(null)))
      )
      if (report === null) return carryOn

      for (const excluded of report.excludedDays) {
        const key = `excluded\u0000${excluded.day}`
        if (announced.has(key)) continue
        announced.add(key)
        yield* Console.log(`  ${excluded.day}  skipped — ${excluded.reason}`)
      }
      for (const entry of report.unattributed) {
        const key = `unattributed\u0000${entry.day}`
        if (announced.has(key)) continue
        announced.add(key)
        yield* Console.log(
          `  ${formatDuration(entry.seconds)} on ${entry.day} that no branch, path, or standing rule places` +
            ` — jcf sync reconcile --agent ${options.agent}`
        )
      }

      const decision = decideWatchWrites(report.proposals, { nowMs })

      /**
       * Move the cursor to the earliest instant this tick is finished with.
       *
       * Two things hold it back, and both must, because the cursor is what a restart trusts. An
       * unsettled block can still grow, so its own start stays behind. And a *settled* block is not
       * finished with either until both sides that were short have taken it: this used to advance
       * here, before the writes below, so a Jira refusal after Clockify had succeeded persisted a
       * cursor past the block — and the restart the message asks for then filtered out the very row
       * whose Jira half was missing. `--dry-run` is the same shape without the failure: it writes
       * nothing, so it must leave nothing behind.
       *
       * With nothing held at all, the settle horizon is the boundary. Never moves backwards, so a
       * quiet look cannot forget a block an earlier one was holding.
       */
      const commitCursor = (unwritten: ReadonlyArray<number>): void => {
        const heldFrom = decision.held
          .filter((entry) => entry.reason._tag === "Unsettled")
          .flatMap((entry) => entry.proposal.spans.map((span) => span.startMs))
        const pendingFrom = [...heldFrom, ...unwritten]
        const horizon = pendingFrom.length === 0
          ? nowMs - settleSeconds * 1000
          : Math.min(...pendingFrom)
        unresolvedFromMs = Math.max(unresolvedFromMs, Math.min(horizon, nowMs))
      }

      /** The earliest instant a proposal covers — where the cursor must stop if it is not written. */
      const proposalStart = (proposal: SessionProposal): number =>
        Math.min(...proposal.spans.map((span) => span.startMs))

      for (const held of decision.held) {
        if (held.reason._tag !== "NeedsReview") continue
        const key = `review\u0000${rowKey(held.proposal)}`
        if (announced.has(key)) continue
        announced.add(key)
        yield* Console.log(heldLine(held))
      }
      // Under `--dry-run` nothing is written, so a settled row stays settled and would be described
      // and re-printed on every single tick — hundreds of paid Coding Agent calls for one unchanging
      // preview if left running overnight. Each distinct row is previewed once.
      const pending = options.dryRun
        ? decision.write.filter((proposal) => !announced.has(`preview\u0000${previewKey(proposal)}`))
        : decision.write
      if (options.dryRun) {
        for (const proposal of pending) announced.add(`preview\u0000${previewKey(proposal)}`)
      }
      // Every settled proposal starts out unwritten, and only a confirmed write clears one. A dry run
      // clears none — including a row it previewed on an earlier tick and is skipping now, which is
      // why this covers `decision.write` rather than `pending`.
      const unwritten = new Set(decision.write)
      const unwrittenStarts = (): ReadonlyArray<number> => [...unwritten].map(proposalStart)

      if (pending.length === 0) {
        commitCursor(unwrittenStarts())
        return carryOn
      }

      // Looked up per write rather than cached for the run: a watch outlives the facts, and an issue
      // renamed at lunchtime should read correctly on the entry written after it.
      const summaries = new Map<string, string>()
      for (const proposal of pending) {
        if (summaries.has(proposal.ticketKey)) continue
        const found = yield* fetchTicketByKey(proposal.ticketKey)
        if (found._tag === "Found") summaries.set(proposal.ticketKey, found.ticket.summary)
      }

      const notes = yield* svc.describeProposals({
        proposals: pending,
        digests: report.digests,
        summaries
      })

      // Re-checked here rather than only at the top of the tick: everything since then — the session
      // read, a ticket lookup per key, a Coding Agent call — is unbounded, and this is the last
      // moment before anything is written.
      if (!options.dryRun) {
        const stillHeld = yield* stillMine
        if (stillHeld !== null) {
          commitCursor(unwrittenStarts())
          return stillHeld
        }
      }

      for (const [index, proposal] of pending.entries()) {
        const description = entryDescription({
          summary: summaries.get(proposal.ticketKey) ?? null,
          note: notes[index] ?? null
        })
        yield* Console.log(
          `  ${formatClock(new Date(nowMs))}  ${proposal.ticketKey}  ${proposalTargets(proposal)}`
        )
        yield* Console.log(`    ${description}`)
        if (options.dryRun) {
          yield* Console.log("    · dry run — not written")
          continue
        }
        // Only what each side actually took. A Clockify failure or a Jira refusal still returns
        // here, and a closing summary that claimed hours neither system holds would be wrong in the
        // one direction this command must never be wrong in.
        const written = yield* applyProposal(svc, proposal, description)
        if (written.clockifySeconds > 0 || written.jiraSeconds > 0) totals.blocks += 1
        totals.clockifySeconds += written.clockifySeconds
        totals.jiraSeconds += written.jiraSeconds
        // Only when both sides that were short have taken it. A half-written block stays behind the
        // cursor, so the restart re-derives it and offers the missing side alone — the subtraction
        // that makes every tick safe is the same thing that stops the written side repeating.
        if (
          written.clockifySeconds >= proposal.clockifyDelta &&
          written.jiraSeconds >= proposal.jiraDelta
        ) {
          unwritten.delete(proposal)
        }
        if (!written.keepGoing) {
          commitCursor(unwrittenStarts())
          return {
            _tag: "Stop",
            reason: "Jira rejected the login. Run `jcf auth jira login`, then start the watch again."
          }
        }
      }
      commitCursor(unwrittenStarts())
      return carryOn
    })

    // A plain loop rather than recursion: every `yield*` is a suspension point, so this holds no
    // stack, and `for (;;)` puts its one exit — stopped — where it can be read.
    const loop = Effect.gen(function*() {
      for (;;) {
        const outcome = yield* tick
        if (outcome._tag === "Stop") {
          yield* Console.log(`  Stopped: ${outcome.reason}`)
          return
        }
        yield* Effect.sleep(Duration.seconds(options.intervalSeconds))
      }
    })

    // Printed however the watch ends, including Ctrl-C: a run that wrote nothing and a run that was
    // never working look identical otherwise.
    yield* loop.pipe(
      // Released however this ends, so the next watch does not wait out the stale window.
      Effect.ensuring(
        Effect.suspend(() =>
          WatchLease.release({
            path: leasePath,
            owner: leaseOwner,
            heldSinceMs: startedAtMs,
            intervalSeconds: options.intervalSeconds,
            unresolvedFromMs
          })
        )
      ),
      Effect.ensuring(
        Effect.suspend(() =>
          Console.log(
            totals.blocks === 0
              ? "  Wrote nothing this run."
              : `  Wrote ${totals.blocks} block(s): Clockify ${formatDuration(totals.clockifySeconds)},` +
                ` Jira ${formatDuration(totals.jiraSeconds)}.`
          )
        )
      )
    )
  })

export const watch = Command.make(
  "watch",
  {
    agent: Args.string("agent").pipe(Args.optional),
    interval: Options.integer("interval").pipe(
      Options.withDescription(`Seconds between looks (default: ${DEFAULT_INTERVAL_SECONDS})`),
      Options.optional
    ),
    dryRun: Options.boolean("dry-run").pipe(
      Options.withDescription("Report what would be written without creating anything"),
      Options.withDefault(false)
    )
  },
  ({ agent, dryRun, interval }) =>
    Effect.gen(function*() {
      const name = Option.isSome(agent) ? agent.value : "claude"
      if (!SUPPORTED_AGENTS.includes(name)) {
        const message = `Unsupported agent "${name}". Supported: ${SUPPORTED_AGENTS.join(", ")}.`
        yield* Console.error(message)
        return yield* new WatchUsageError({ message })
      }
      const intervalSeconds = Option.isSome(interval) ? interval.value : DEFAULT_INTERVAL_SECONDS
      if (intervalSeconds < 1) {
        const message = "--interval must be at least 1 second."
        yield* Console.error(message)
        return yield* new WatchUsageError({ message })
      }
      return yield* runWatch({ agent: name, intervalSeconds, dryRun })
    })
).pipe(
  Command.withDescription("Watch a Coding Agent's sessions and log settled work as it happens")
)
