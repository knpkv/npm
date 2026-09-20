import { scheduleRuns } from "./schedule.js"
import * as SourceConsumption from "./sourceConsumption.js"
/**
 * Pure core for turning Agent Session evidence into Proposed Worklogs.
 *
 * **Mental model**
 *
 * - **Evidence, not a side**: a transcript records that work happened at particular moments,
 *   never how long it lasted. Everything here derives a *proposal*; nothing here is
 *   authoritative and nothing here writes. See ADR-0006.
 * - **Last-touch partition**: every instant between two adjacent Session Activity events is
 *   credited to the *earlier* event's session, and only if the gap is within the Idle Cap.
 *   Each interval is therefore credited exactly once, so the sum over all Issue Keys can never
 *   exceed the wall clock of the window. That inequality is the safety property that makes a
 *   Proposed Worklog safe to accept without auditing the rest of the day.
 * - **Attribution precedence**: branch, then path, then Standing Attribution, then Coding Agent.
 *   The first signal to yield an Issue Key wins, so re-running never reshuffles attributions.
 * - **Closed choice set**: a Coding Agent may only pick an Issue Key that literally appears in
 *   the transcript. {@link attributeSession} enforces that structurally, so an invented key is
 *   impossible rather than merely discouraged.
 *
 * **Gotchas**
 *
 * - Provider-agnostic on purpose: nothing here knows about Claude, JSONL, or the filesystem, so
 *   adding a second Coding Agent is additive.
 * - Placeholder rejection applies to *mined* candidates only, never to a branch or path. A branch
 *   name is a deliberate act; a number in prose is not. A real project numbered `PROJ-123` would
 *   otherwise be unattributable.
 * - Credit is bounded to the window by the caller: only Session Activity inside `[from, to)` is
 *   passed in, so the last event of the window contributes no trailing interval. That is a
 *   deliberate under-count of at most one Idle Cap per window edge.
 *
 * @module
 */
import { localDay, nextLocalMidnight } from "../utils/time.js"

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/**
 * Which evidence placed a session on an Issue Key. `none` means no signal did — the session is
 * an Unattributed Session and is reported with its hours rather than guessed at.
 */
export type AttributionSignal = "branch" | "path" | "standing" | "agent" | "none"

/**
 * Attribution Signals in precedence order — the first to yield an Issue Key wins. Also the
 * trust order: a bucket built from several sessions reports its *weakest* signal, because a row
 * is only as trustworthy as its least trustworthy evidence.
 */
export const ATTRIBUTION_PRECEDENCE: ReadonlyArray<AttributionSignal> = [
  "branch",
  "path",
  "standing",
  "agent",
  "none"
]

const signalRank = (signal: AttributionSignal): number => {
  const index = ATTRIBUTION_PRECEDENCE.indexOf(signal)
  return index === -1 ? ATTRIBUTION_PRECEDENCE.length : index
}

/** Everything the attribution rules need to know about one Agent Session. */
export interface AttributableSession {
  readonly sessionId: string
  /** Session Root-relative working directory the session ran in. */
  readonly cwd: string
  /** Git branch recorded on the session, or null when the session recorded none. */
  readonly gitBranch: string | null
  /** Issue Keys mined from the transcript — the closed choice set for a Coding Agent. */
  readonly candidateKeys: ReadonlyArray<string>
}

/** How one Agent Session was placed (or not placed) on an Issue Key. */
export interface SessionAttribution {
  readonly sessionId: string
  readonly ticketKey: string | null
  readonly signal: AttributionSignal
  /** Coding Agent confidence in `[0, 1]`. null for every deterministic signal. */
  readonly confidence: number | null
  /**
   * True when a Coding Agent named an Issue Key but its confidence fell below the floor.
   * Such credit is reported so the hours stay visible, but is never offered for confirmation.
   */
  readonly belowConfidenceFloor: boolean
}

/**
 * An Issue Key as Jira writes them: at least two leading uppercase alphanumerics then a number.
 * Deliberately stricter than the Clockify description parser — this runs over free prose and
 * directory names, where `feat/jcf-ai` and `v2-3` must not look like tickets.
 *
 * Bounded by explicit non-alphanumerics rather than `\b`, because `_` is a word character: `\b` put
 * no boundary between `_` and `P`, so the branch and worktree names people actually use —
 * `feature_PROJ-42_work` — matched nothing at all, and the session went unattributed and therefore
 * unlogged. Underscore is the only difference; letters and digits still have to stop.
 */
const TICKET_KEY = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,9}-\d{1,6}(?![A-Za-z0-9])/g

const matchTicketKeys = (text: string): ReadonlyArray<string> => [...text.matchAll(TICKET_KEY)].map((m) => m[0])

/**
 * True when a string is an Issue Key and nothing else.
 *
 * A Standing Attribution is the one Issue Key nobody mines — it is typed into a config file — so it
 * is also the one that can be empty or malformed. An empty key writes a Clockify description of
 * `[] …`, which {@link parseTicketKey} then refuses to read back, so the next tally cannot see the
 * entry and a watch writes the same time again on every settled tick, forever.
 */
export const isTicketKey = (value: string): boolean => {
  const matches = matchTicketKeys(value)
  return matches.length === 1 && matches[0] === value
}

/**
 * True for Issue Keys whose number reads as documentation filler rather than a real ticket:
 * an ascending run from 1 (`123`, `1234`) or a repeated digit (`333`, `4444`), both at least
 * three digits long. Short numbers are left alone so a young project's `PROJ-12` still counts.
 *
 * Only ever applied to keys mined from prose. `PROJ-XXXX` needs no rule — it has no digits and
 * so never matches {@link TICKET_KEY} in the first place.
 */
export const isPlaceholderTicketKey = (key: string): boolean => {
  const digits = key.slice(key.lastIndexOf("-") + 1)
  if (digits.length < 3) return false
  const ascendingFromOne = digits.split("").every((d, i) => d === String((i + 1) % 10))
  const allSameDigit = digits.split("").every((d) => d === digits[0])
  return ascendingFromOne || allSameDigit
}

const DEFAULT_CANDIDATE_LIMIT = 20

/**
 * Issue Keys mentioned anywhere in a transcript, deduped and in order of first appearance,
 * with placeholders dropped and the list capped so a Coding Agent prompt stays bounded.
 *
 * Deliberately *unordered by frequency*: a known-issues document mentions the tickets it
 * describes dozens of times, so frequency is anti-correlated with what should be billed.
 */
export const mineTicketKeys = (
  text: string,
  options?: { readonly limit?: number | undefined }
): ReadonlyArray<string> => {
  const limit = options?.limit ?? DEFAULT_CANDIDATE_LIMIT
  const seen = new Set<string>()
  const keys: Array<string> = []
  for (const key of matchTicketKeys(text)) {
    if (seen.has(key) || isPlaceholderTicketKey(key)) continue
    seen.add(key)
    keys.push(key)
    if (keys.length >= limit) break
  }
  return keys
}

/**
 * The Issue Key a git branch names, or null. Takes the first match so `PROJ-1/PROJ-2` resolves
 * predictably, and applies no placeholder filter — naming a branch is a deliberate act.
 */
export const ticketKeyFromBranch = (branch: string | null | undefined): string | null => {
  if (branch === null || branch === undefined || branch === "") return null
  return matchTicketKeys(branch)[0] ?? null
}

/**
 * The Issue Key a working directory path names, or null. Takes the *last* match so the deepest
 * segment wins — a worktree at `~/dev/repo/worktrees/PROJ-1/PROJ-2` is working on `PROJ-2`.
 *
 * This is what makes detached worktrees (whose branch reads `HEAD`) attributable.
 */
export const ticketKeyFromPath = (cwd: string): string | null => {
  const keys = matchTicketKeys(cwd)
  return keys.length > 0 ? keys[keys.length - 1]! : null
}

const withoutTrailingSlash = (path: string): string => path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path

/** Expand a leading `~` against `home`. Paths without one are returned unchanged. */
export const expandHomePath = (path: string, home: string): string => {
  if (path === "~") return home
  if (path.startsWith("~/")) return `${withoutTrailingSlash(home)}/${path.slice(2)}`
  return path
}

/**
 * True when `path` is `prefix` or sits beneath it. Compares on a path *separator boundary*, so
 * `/a/bc` is not inside `/a/b` — the bug a bare `startsWith` would introduce.
 */
export const isWithinPrefix = (path: string, prefix: string): boolean => {
  const normalisedPath = withoutTrailingSlash(path)
  const normalisedPrefix = withoutTrailingSlash(prefix)
  if (normalisedPrefix.length === 0) return false
  return normalisedPath === normalisedPrefix || normalisedPath.startsWith(`${normalisedPrefix}/`)
}

/**
 * True when a session's working directory sits inside any Session Root. Sessions outside every
 * root are never read, so scratch directories and side projects cannot generate proposals.
 */
export const isWithinSessionRoots = (cwd: string, roots: ReadonlyArray<string>): boolean =>
  roots.some((root) => isWithinPrefix(cwd, root))

/**
 * The Standing Attribution for a working directory: the Issue Key mapped to the *longest*
 * matching directory prefix, so `~/dev/docs/releases` and `~/dev/docs/interviews` can differ.
 */
export const standingAttribution = (
  cwd: string,
  map: Readonly<Record<string, string>>
): string | null => {
  let best: string | null = null
  let bestLength = -1
  for (const [prefix, ticketKey] of Object.entries(map)) {
    if (!isWithinPrefix(cwd, prefix) || prefix.length <= bestLength) continue
    best = ticketKey
    bestLength = prefix.length
  }
  return best
}

/** A deterministic placement — reached without consulting a Coding Agent. */
export interface DeterministicAttribution {
  readonly ticketKey: string
  readonly signal: "branch" | "path" | "standing"
}

/**
 * Place a session using the deterministic signals only, or null when none apply.
 *
 * Kept separate from {@link attributeSession} because the *absence* of a result here is exactly
 * the condition for spending a Coding Agent call — which is why a run where every session is
 * branch-attributed costs nothing.
 */
export const deterministicAttribution = (
  session: AttributableSession,
  options: { readonly standingMap: Readonly<Record<string, string>> }
): DeterministicAttribution | null => {
  const fromBranch = ticketKeyFromBranch(session.gitBranch)
  if (fromBranch !== null) return { ticketKey: fromBranch, signal: "branch" }
  const fromPath = ticketKeyFromPath(session.cwd)
  if (fromPath !== null) return { ticketKey: fromPath, signal: "path" }
  const standing = standingAttribution(session.cwd, options.standingMap)
  if (standing !== null) return { ticketKey: standing, signal: "standing" }
  return null
}

/** What a Coding Agent decided about one session. `null` is a valid, expected answer. */
export interface AgentChoice {
  readonly ticketKey: string
  readonly confidence: number
}

/**
 * Resolve one session's final attribution, applying the full precedence and both guards on a
 * Coding Agent's answer: the chosen key must appear in the session's own candidate set, and a
 * choice below `confidenceFloor` is marked so it can be reported without being offered.
 */
export const attributeSession = (
  session: AttributableSession,
  options: {
    readonly standingMap: Readonly<Record<string, string>>
    /** Only consulted when no deterministic signal placed the session. */
    readonly agentChoice?: AgentChoice | null | undefined
    readonly confidenceFloor: number
  }
): SessionAttribution => {
  const deterministic = deterministicAttribution(session, { standingMap: options.standingMap })
  if (deterministic !== null) {
    return {
      sessionId: session.sessionId,
      ticketKey: deterministic.ticketKey,
      signal: deterministic.signal,
      confidence: null,
      belowConfidenceFloor: false
    }
  }

  const choice = options.agentChoice
  const unattributed: SessionAttribution = {
    sessionId: session.sessionId,
    ticketKey: null,
    signal: "none",
    confidence: null,
    belowConfidenceFloor: false
  }
  // The choice set is closed over the transcript's own text: a key the transcript never
  // mentioned cannot reach a worklog, however confidently it was named.
  if (choice === null || choice === undefined || !session.candidateKeys.includes(choice.ticketKey)) {
    return unattributed
  }

  return {
    sessionId: session.sessionId,
    ticketKey: choice.ticketKey,
    signal: "agent",
    confidence: choice.confidence,
    belowConfidenceFloor: choice.confidence < options.confidenceFloor
  }
}

// ---------------------------------------------------------------------------
// Duration: the last-touch partition
// ---------------------------------------------------------------------------

/** One recorded moment of work inside an Agent Session. */
export interface SessionActivity {
  readonly sessionId: string
  /** Epoch milliseconds. */
  readonly atMs: number
}

/** A half-open span of credited time, `[startMs, endMs)`, never crossing a local midnight. */
export interface CreditedSpan {
  readonly startMs: number
  readonly endMs: number
}

/**
 * A span of credited time that carries the seconds it contributes to its bucket.
 *
 * The unit a person can accept on its own. A row is exactly the sum of its blocks, so accepting four
 * blocks one at a time and accepting the whole row put the same total in both systems — which is
 * what makes writing a morning now and an afternoon later safe rather than a way to double-log.
 *
 * `seconds` is credit, not wall clock: time worked on several Issue Keys at once is divided between
 * them, so a block's seconds can be shorter than the interval it spans. That gap is the sharing
 * doing its job, and hiding it by reporting the wall clock would overstate the day.
 */
export interface CreditedBlock {
  readonly startMs: number
  readonly endMs: number
  readonly seconds: number
  /** Stable start of the source cluster, even when scheduling moves this rendered block. */
  readonly sourceStartMs?: number | undefined
  /** Provider seconds already written under a corrected ticket for this source block. */
  readonly clockifyConsumedSeconds?: number | undefined
  /** Provider seconds already written under a corrected ticket for this source block. */
  readonly jiraConsumedSeconds?: number | undefined
}

/**
 * Merge spans that touch or overlap, so a hundred one-minute credits read as one block of work.
 */
export const mergeSpans = (spans: ReadonlyArray<CreditedSpan>): ReadonlyArray<CreditedSpan> => {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const merged: Array<{ startMs: number; endMs: number }> = []
  for (const span of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && span.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, span.endMs)
      continue
    }
    merged.push({ startMs: span.startMs, endMs: span.endMs })
  }
  return merged
}

/**
 * Merge overlapping spans, then cut the result at every local midnight.
 *
 * Merging alone is not enough anywhere spans are day-bucketed afterwards: two windows that meet at
 * midnight touch, so a plain merge welds them into one span whose start decides the day — putting a
 * whole morning's work onto the previous day. Every merge in this module goes through here.
 */
export const mergeSpansWithinDays = (spans: ReadonlyArray<CreditedSpan>): ReadonlyArray<CreditedSpan> => {
  const bounded: Array<CreditedSpan> = []
  for (const span of mergeSpans(spans)) {
    let cursor = span.startMs
    while (cursor < span.endMs) {
      const chunkEnd = Math.min(span.endMs, nextLocalMidnight(cursor))
      bounded.push({ startMs: cursor, endMs: chunkEnd })
      cursor = chunkEnd
    }
  }
  return bounded
}

/**
 * The windows a single session was active in: each gap between its own adjacent events, cut off at
 * the Idle Cap, and split at local midnight. Merged, so contiguous work reads as one block.
 */
const sessionActiveWindows = (
  events: ReadonlyArray<number>,
  capMs: number,
  observedAtMs: number
): ReadonlyArray<CreditedSpan> => {
  const raw: Array<CreditedSpan> = []
  const sorted = [...events].sort((a, b) => a - b)
  for (let index = 0; index < sorted.length - 1; index++) {
    const from = sorted[index]
    const next = sorted[index + 1]
    if (from === undefined || next === undefined) continue
    // Beyond the Idle Cap nobody was working, so the window ends there rather than at the next event.
    raw.push({ startMs: from, endMs: Math.min(next, from + capMs) })
  }

  // The last prompt gets its window too, bounded by the Idle Cap and by how far we can see.
  //
  // Not cosmetic. Without it a final prompt contributes nothing *until* some later prompt arrives,
  // and then a window appears retroactively — one that can overlap a block already settled and
  // written, halving that block's share after the fact while the new share is written as well. Two
  // tickets then hold more time between them than the clock has. Materialising it on sight is what
  // makes "settled" mean settled: every window a prompt will ever produce exists as soon as the
  // prompt does.
  const last = sorted[sorted.length - 1]
  if (last !== undefined && observedAtMs > last) {
    raw.push({ startMs: last, endMs: Math.min(observedAtMs, last + capMs) })
  }

  return mergeSpansWithinDays(raw)
}

/** A session's active windows, day-bounded and merged. */
export interface SessionWindows {
  readonly sessionId: string
  readonly spans: ReadonlyArray<CreditedSpan>
}

/**
 * When each session was working: the gaps between its own adjacent events, cut off at the Idle Cap.
 *
 * Deliberately stops short of dividing anything. Sharing has to happen between *Issue Keys*, and
 * which key a session belongs to is not known until it has been attributed — two sessions on the
 * same ticket must not halve each other's time. See {@link splitCredits}.
 */
export const activeWindows = (
  activity: ReadonlyArray<SessionActivity>,
  options: {
    readonly idleCapSeconds: number
    /**
     * How far presence may be credited past a session's last prompt — the end of the window being
     * reconciled, or now for a watch. Bounds the trailing window so a period never credits time
     * beyond what it can actually see.
     */
    readonly observedAtMs: number
    /**
     * Per-session upper bound on the trailing window, for a stretch that gave way to another under a
     * different branch or directory. Presence after its final prompt ends where the next stretch
     * begins: the same person carried straight on, so crediting the tail to both would put the
     * minutes around a switch on two Issue Keys at once.
     */
    readonly boundsBySession?: ReadonlyMap<string, number> | undefined
  }
): ReadonlyArray<SessionWindows> => {
  const capMs = Math.max(0, options.idleCapSeconds) * 1000
  const eventsBySession = new Map<string, Array<number>>()
  for (const event of activity) {
    const events = eventsBySession.get(event.sessionId) ?? []
    events.push(event.atMs)
    eventsBySession.set(event.sessionId, events)
  }
  return [...eventsBySession.entries()]
    .map(([sessionId, events]) => ({
      sessionId,
      spans: sessionActiveWindows(
        events,
        capMs,
        Math.min(options.observedAtMs, options.boundsBySession?.get(sessionId) ?? Number.POSITIVE_INFINITY)
      )
    }))
    .filter((session) => session.spans.length > 0)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

/**
 * Every instant where at least one bucket was active, cut into slices at each point where the set
 * of active buckets changes, with the buckets active in that slice.
 */
const overlapSlices = (
  spansByBucket: ReadonlyMap<string, ReadonlyArray<CreditedSpan>>
): ReadonlyArray<{ readonly startMs: number; readonly endMs: number; readonly bucketIds: ReadonlyArray<string> }> => {
  const boundaries = new Set<number>()
  for (const spans of spansByBucket.values()) {
    for (const span of spans) {
      boundaries.add(span.startMs)
      boundaries.add(span.endMs)
    }
  }
  const ordered = [...boundaries].sort((a, b) => a - b)
  const slices: Array<{ startMs: number; endMs: number; bucketIds: ReadonlyArray<string> }> = []
  for (let i = 0; i < ordered.length - 1; i++) {
    const startMs = ordered[i]!
    const endMs = ordered[i + 1]!
    const bucketIds = [...spansByBucket.entries()]
      .filter(([, spans]) => spans.some((span) => span.startMs <= startMs && span.endMs >= endMs))
      .map(([bucketId]) => bucketId)
    if (bucketIds.length > 0) slices.push({ startMs, endMs, bucketIds })
  }
  return slices
}

/**
 * The shortest stretch that may own time on its own, in seconds.
 *
 * Fifteen minutes, because a timeline that changes ticket every three minutes is not a record of how
 * anyone works — it is an artefact of reading several concurrent transcripts at once. A day of that
 * is unreadable on a calendar and indefensible on a timesheet.
 */
export const DEFAULT_DWELL_SECONDS = 900

/** One stretch of the day and the buckets that own it. */
export interface OwnedRun {
  readonly startMs: number
  readonly endMs: number
  readonly bucketIds: ReadonlyArray<string>
}

const sameOwners = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index])

/**
 * True when two touching stretches may become one: same owners, same local day.
 *
 * The day check is load-bearing. Runs are bucketed by the day their start falls in, so welding a
 * stretch ending at midnight to the one beginning there would move the small hours of Tuesday onto
 * Monday and report Tuesday as empty. The windows arrive already split at midnight for exactly this
 * reason; coalescing must not undo it.
 */
const joinable = (previous: OwnedRun, next: OwnedRun): boolean =>
  previous.endMs === next.startMs &&
  sameOwners(previous.bucketIds, next.bucketIds) &&
  localDay(new Date(previous.startMs)) === localDay(new Date(next.startMs))

/** Join touching stretches with identical owners. A gap of idle time always separates two runs. */
const mergeRuns = (runs: ReadonlyArray<OwnedRun>): ReadonlyArray<OwnedRun> => {
  const merged: Array<OwnedRun> = []
  for (const run of runs) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && joinable(previous, run)) {
      merged[merged.length - 1] = { ...previous, endMs: run.endMs }
      continue
    }
    merged.push(run)
  }
  return merged
}

/**
 * Coalesce ownership so it changes no more often than the Dwell Floor.
 *
 * **What this is for.** Three concurrent sessions on three Issue Keys interleave their prompts, and
 * read literally that says the work changed ticket every few minutes. It did not — that is an
 * artefact of reading several transcripts at once. A day of it is two dozen slivers on a calendar and
 * indefensible on a timesheet.
 *
 * **Two rules, in order.**
 *
 * 1. *A ticket present for less than the floor inside one connected source cluster, interrupting work
 *    that resumes after it, was not a ticket that was worked on.* It was a keystroke inside other work — a branch
 *    checked, a file opened, a question asked — so its time goes to the work around it. This is what
 *    actually removes the slivers: they rarely touch anything, because a transcript goes quiet
 *    between prompts, and they are as often overlapping as adjacent, because concurrent sessions
 *    overlap by definition. Adjacency and overlap were both tried as the test and both left the
 *    interleaving as they found it. The requirement for work on *both* sides is what keeps a genuine
 *    short piece of work — eight minutes on another ticket, and then the day moves on — from being
 *    swallowed by what came before it.
 * 2. *Tenancy, not adjacency.* Between tickets that were genuinely worked on, whoever takes the
 *    timeline holds it for at least the floor: a stretch beginning inside that tenure and owned by
 *    someone else is credited to the incumbent. This catches two real tickets alternating quickly.
 *
 * **What it never does.** It reassigns time and never creates or drops any — idle gaps are not swept
 * into a tenure — so the inequality that makes a proposal safe to accept survives intact. Nothing is
 * ever welded across a local midnight, because runs are bucketed by the day they start in.
 *
 * **Unplaced hours take no part.** A stretch nothing placed neither holds a tenure nor loses its time
 * to one: promoting it would bill work no transcript placed on that ticket, and demoting an
 * attributed sliver into it would quietly discard billable work. An attributed tenure simply
 * continues across it.
 *
 * **A minor ticket with nothing to belong to keeps its own time.** Four minutes alone in an otherwise
 * empty day has no surrounding work to join, and dropping it would lose work that happened.
 */
export const applyDwellFloor = (
  slices: ReadonlyArray<OwnedRun>,
  options: {
    readonly dwellSeconds: number
    /** True when a bucket's time is eligible to be proposed for an Issue Key. */
    readonly attributed: (bucketId: string) => boolean
  }
): ReadonlyArray<OwnedRun> => {
  const dwellMs = Math.max(0, options.dwellSeconds) * 1000
  if (dwellMs === 0) return mergeRuns(slices)
  const runs = mergeRuns(slices)

  // How long each attributed ticket was present in one connected source cluster, sharing ignored:
  // the question is whether it was worked on at all, not how much of a shared minute it would be
  // credited. A later disconnected cluster must not change ownership a watch already settled.
  const clusterIds: Array<number> = []
  let clusterId = 0
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!
    const previous = runs[index - 1]
    if (
      previous !== undefined &&
      (previous.endMs !== run.startMs || localDay(new Date(previous.startMs)) !== localDay(new Date(run.startMs)))
    ) {
      clusterId++
    }
    clusterIds.push(clusterId)
  }
  const presence = new Map<string, number>()
  const presenceKey = (bucketId: string, cluster: number) => `${bucketId}\u0000${String(cluster)}`
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!
    const cluster = clusterIds[index]!
    for (const bucketId of run.bucketIds) {
      const key = presenceKey(bucketId, cluster)
      presence.set(key, (presence.get(key) ?? 0) + (run.endMs - run.startMs))
    }
  }
  const major = (bucketId: string, index: number): boolean =>
    !options.attributed(bucketId) || (presence.get(presenceKey(bucketId, clusterIds[index]!)) ?? 0) >= dwellMs

  /** The nearest major, attributed owners on the same day, looking one way from `index`. */
  const majorOwnersToward = (index: number, day: string, step: -1 | 1): ReadonlyArray<string> | undefined => {
    let boundary = step === -1 ? runs[index]!.startMs : runs[index]!.endMs
    for (let at = index + step; at >= 0 && at < runs.length; at += step) {
      const candidate = runs[at]!
      if (localDay(new Date(candidate.startMs)) !== day) return undefined
      // A settled idle gap is a temporal barrier: work appended beyond it must never reassign a
      // block a watch could already have written. Only a connected source cluster may absorb a
      // minor interruption.
      if (step === -1 ? candidate.endMs !== boundary : candidate.startMs !== boundary) return undefined
      boundary = step === -1 ? candidate.startMs : candidate.endMs
      const owners = candidate.bucketIds.filter((id) => major(id, at) && options.attributed(id))
      if (owners.length > 0) return owners
    }
    return undefined
  }

  const withoutMinors = runs.map((run, index) => {
    const day = localDay(new Date(run.startMs))
    const kept = run.bucketIds.filter((id) => major(id, index))
    if (kept.length > 0) return { ...run, bucketIds: kept }
    // Every owner was minor, so this is only an *interruption* if the work it interrupts resumes:
    // there has to be major work on both sides of it. Eight minutes on another ticket after half an
    // hour, with nothing after it, is a short piece of work rather than a keystroke inside a longer
    // one — and swallowing it would lose the change of ticket a person actually made.
    const before = majorOwnersToward(index, day, -1)
    const after = majorOwnersToward(index, day, 1)
    return before === undefined || after === undefined ? run : { ...run, bucketIds: before }
  })

  // Phase two: between tickets that were genuinely worked on, ownership holds for the floor.
  let tenant: { readonly bucketIds: ReadonlyArray<string>; readonly sinceMs: number } | null = null
  const held: Array<OwnedRun> = []
  for (const run of mergeRuns(withoutMinors)) {
    const previous = held[held.length - 1]
    if (
      previous !== undefined &&
      (previous.endMs !== run.startMs || localDay(new Date(previous.startMs)) !== localDay(new Date(run.startMs)))
    ) {
      tenant = null
    }
    const attributedRun = run.bucketIds.every(options.attributed)
    if (!attributedRun) {
      held.push(run)
      continue
    }
    const sameDay = tenant !== null && localDay(new Date(tenant.sinceMs)) === localDay(new Date(run.startMs))
    if (tenant !== null && sameDay && sameOwners(tenant.bucketIds, run.bucketIds)) {
      held.push(run)
      continue
    }
    const overlapsTenant = tenant !== null && run.bucketIds.some((id) => tenant!.bucketIds.includes(id))
    if (tenant !== null && sameDay && run.startMs - tenant.sinceMs < dwellMs && !overlapsTenant) {
      held.push({ ...run, bucketIds: tenant.bucketIds })
      continue
    }
    tenant = { bucketIds: run.bucketIds, sinceMs: run.startMs }
    held.push(run)
  }
  return mergeRuns(held)
}

/** A run of one bucket's time, still carrying its credit in milliseconds. */
interface PricedSpan {
  readonly startMs: number
  readonly endMs: number
  readonly creditedMs: number
  readonly sourceStartMs: number
}

/**
 * Coalesce a bucket's runs into the blocks a person sees, adding up the credit each one carries.
 *
 * `gapMs` is the Dwell Floor. Once ownership cannot change inside the floor, two runs of the same
 * ticket four minutes apart are one stretch of work with a pause in it, and offering them as two
 * blocks says something about the day that is not true. Runs that merely touch are joined at any
 * floor, including zero.
 *
 * Never across a local midnight, because everything downstream buckets by day: welding the last run
 * of Monday to the first of Tuesday would file a whole morning under the wrong date.
 */
const coalesceBlocks = (spans: ReadonlyArray<PricedSpan>, gapMs: number): ReadonlyArray<PricedSpan> => {
  const ordered = [...spans].sort((a, b) => a.startMs - b.startMs)
  const joined: Array<PricedSpan> = []
  for (const span of ordered) {
    const previous = joined[joined.length - 1]
    if (
      previous !== undefined &&
      span.startMs - previous.endMs <= gapMs &&
      localDay(new Date(previous.startMs)) === localDay(new Date(span.startMs))
    ) {
      joined[joined.length - 1] = {
        creditedMs: previous.creditedMs + span.creditedMs,
        endMs: Math.max(previous.endMs, span.endMs),
        startMs: previous.startMs,
        sourceStartMs: Math.min(previous.sourceStartMs, span.sourceStartMs)
      }
      continue
    }
    joined.push(span)
  }
  return joined
}

/**
 * Give every block whole seconds that add up to the day's total, exactly.
 *
 * Flooring each block on its own leaves the row short by up to a second per block, and a row whose
 * blocks do not add up to it is a row nobody can check — the panel would offer 56m 36s and its five
 * blocks would come to 56m 32s. The seconds the flooring drops go to the blocks with the largest
 * fractional part, which is the same rule an invoice uses to make its lines sum to its total.
 */
const wholeSeconds = (spans: ReadonlyArray<PricedSpan>, totalSeconds: number): ReadonlyArray<CreditedBlock> => {
  const floored = spans.map((span) => ({
    remainder: (span.creditedMs / 1000) - Math.floor(span.creditedMs / 1000),
    seconds: Math.floor(span.creditedMs / 1000),
    span
  }))
  let spare = totalSeconds - floored.reduce((sum, entry) => sum + entry.seconds, 0)
  // Largest fractional part first, and an earlier block wins a tie so the result never depends on
  // the order runs happened to arrive in.
  const order = [...floored].sort((a, b) => b.remainder - a.remainder || a.span.startMs - b.span.startMs)
  for (const entry of order) {
    if (spare <= 0) break
    entry.seconds += 1
    spare -= 1
  }
  return floored.map((entry) => ({
    endMs: entry.span.endMs,
    seconds: entry.seconds,
    startMs: entry.span.startMs,
    sourceStartMs: entry.span.sourceStartMs
  }))
}

/** Credited and wall-clock seconds for one bucket on one day. */
interface BucketDayCredit {
  readonly seconds: number
  readonly activeSeconds: number
  readonly blocks: ReadonlyArray<CreditedBlock>
  /** Earliest source instant needed to reconstruct the scheduled blocks. */
  readonly sourceStartMs: number
  /** Last source instant that can still redistribute the scheduled blocks. */
  readonly settlementEndMs: number
}

/**
 * Share time between buckets, scheduling overlapping attributed work into sequential blocks.
 *
 * Where several buckets were active at the same instant, that instant is divided equally between
 * them, so an hour spent on three tickets at once credits twenty minutes to each rather than an
 * hour to whichever session happened to log an event first. Two sessions on the *same* bucket do
 * not divide anything — their windows are unioned first, because there is no ambiguity about which
 * Issue Key that time belongs to.
 *
 * A slice's duration is divided, never duplicated, so the total across every bucket can never
 * exceed the wall clock of the day. With a positive dwell floor, overlapping attributed runs
 * are scheduled evenly among the strongest tickets that fit; zero preserves raw shares.
 */
const shareBetweenBuckets = (
  spansByBucket: ReadonlyMap<string, ReadonlyArray<CreditedSpan>>,
  options: {
    readonly dwellSeconds: number
    readonly attributed: (bucketId: string) => boolean
  }
): ReadonlyMap<string, ReadonlyMap<string, BucketDayCredit>> => {
  const totals = new Map<string, Map<string, { creditedMs: number; activeMs: number }>>()
  const add = (bucketId: string, day: string, creditedMs: number, activeMs: number) => {
    const byDay = totals.get(bucketId) ?? new Map<string, { creditedMs: number; activeMs: number }>()
    const existing = byDay.get(day) ?? { creditedMs: 0, activeMs: 0 }
    byDay.set(day, { creditedMs: existing.creditedMs + creditedMs, activeMs: existing.activeMs + activeMs })
    totals.set(bucketId, byDay)
  }

  // Ownership is coalesced first, so the hours and the picture come from the same timeline. Deriving
  // the totals from the runs and the spans from the original windows would put a row's seconds and
  // its blocks at odds — and the blocks are what a person checks the seconds against.
  const originalRuns = applyDwellFloor(overlapSlices(spansByBucket), options)
  const runs = scheduleRuns(originalRuns, options.dwellSeconds, options.attributed)
  for (const run of originalRuns) {
    for (const id of run.bucketIds) add(id, localDay(new Date(run.startMs)), 0, run.endMs - run.startMs)
  }
  const runSpans = new Map<string, Array<PricedSpan>>()
  const settlementEnds = new Map<string, Map<string, number>>()
  const sourceStarts = new Map<string, Map<string, number>>()
  for (const run of runs) {
    // Windows are already day-bounded, so a run never straddles two days.
    const day = localDay(new Date(run.startMs))
    const duration = run.endMs - run.startMs
    // Divided, never duplicated: this is the one place an instant becomes seconds, and it is the
    // same number that reaches the row's total and the block a person accepts.
    const creditedMs = duration / run.bucketIds.length
    for (const [index, bucketId] of run.bucketIds.entries()) {
      add(bucketId, day, creditedMs, 0)
      const byDay = settlementEnds.get(bucketId) ?? new Map<string, number>()
      byDay.set(day, Math.max(byDay.get(day) ?? 0, run.settlementEndMs))
      settlementEnds.set(bucketId, byDay)
      const startsByDay = sourceStarts.get(bucketId) ?? new Map<string, number>()
      startsByDay.set(day, Math.min(startsByDay.get(day) ?? Number.POSITIVE_INFINITY, run.sourceStartMs))
      sourceStarts.set(bucketId, startsByDay)
      runSpans.set(bucketId, [...(runSpans.get(bucketId) ?? []), {
        creditedMs,
        endMs: options.dwellSeconds > 0 ? run.startMs + creditedMs * (index + 1) : run.endMs,
        startMs: options.dwellSeconds > 0 ? run.startMs + creditedMs * index : run.startMs,
        sourceStartMs: run.sourceStartMs
      }])
    }
  }

  const result = new Map<string, Map<string, BucketDayCredit>>()
  for (const [bucketId, byDay] of totals) {
    const spansByDay = new Map<string, Array<PricedSpan>>()
    for (const span of runSpans.get(bucketId) ?? []) {
      const day = localDay(new Date(span.startMs))
      spansByDay.set(day, [...(spansByDay.get(day) ?? []), span])
    }
    const perDay = new Map<string, BucketDayCredit>()
    for (const [day, sums] of byDay) {
      // Floor, not round. A share of an odd-length slice is fractional, and rounding each bucket
      // up independently can push the day one second past the wall clock it occupied — breaking
      // the one invariant this shape exists to guarantee. Flooring errs the way the design prefers.
      const seconds = Math.floor(sums.creditedMs / 1000)
      perDay.set(day, {
        activeSeconds: Math.floor(sums.activeMs / 1000),
        // The blocks are the row: the same runs, coalesced for reading, sharing out the same total.
        blocks: wholeSeconds(
          coalesceBlocks(spansByDay.get(day) ?? [], 0),
          seconds
        ),
        settlementEndMs: settlementEnds.get(bucketId)?.get(day) ?? 0,
        sourceStartMs: sourceStarts.get(bucketId)?.get(day) ?? 0,
        seconds
      })
    }
    result.set(bucketId, perDay)
  }
  return result
}

// ---------------------------------------------------------------------------
// Credits by Issue Key
// ---------------------------------------------------------------------------

/** Seconds one Issue Key accounts for on one local calendar day, with the evidence behind it. */
export interface TicketDayCredit {
  readonly ticketKey: string
  readonly day: string
  readonly seconds: number
  readonly signal: AttributionSignal
  /**
   * Coding Agent confidence behind this bucket, or null when no Coding Agent was involved.
   * The *lowest* of the contributing sessions, for the same reason the signal is the weakest one.
   */
  readonly confidence: number | null
  /** Wall-clock seconds spent on this Issue Key before sharing overlaps with other keys. */
  readonly activeSeconds: number
  /**
   * When the work happened and what each stretch is worth, ascending. Sums to `seconds` exactly, so
   * a surface can offer one block at a time without the parts and the whole disagreeing.
   */
  readonly blocks: ReadonlyArray<CreditedBlock>
  /** Earliest source instant needed to reconstruct these scheduled blocks. */
  readonly sourceStartMs: number
  /** Last source instant that can still redistribute the scheduled blocks. */
  readonly settlementEndMs: number
  /**
   * The sessions that contributed to this bucket, in id order.
   *
   * Carried so a caller can find the transcripts behind a row — describing what was worked on needs
   * the prompts, and by this point the spans have been merged past the point of knowing whose they
   * were.
   */
  readonly sessionIds: ReadonlyArray<string>
}

/** Hours that happened on a day but could not be placed on any Issue Key. */
export interface UnattributedDayCredit {
  readonly day: string
  readonly seconds: number
  readonly sessionCount: number
  /**
   * The distinct working directories the unplaced sessions ran in, sorted.
   *
   * Carried because the repair for unplaced hours is a Standing Attribution, and a Standing
   * Attribution is a *directory* prefix — a report that says only "3h40m unattributed" tells a
   * reader nothing they can act on. Deliberately no per-directory seconds: the share of a day
   * belonging to one directory is not something this split computes, and inventing it would be a
   * number nobody could check. Empty when the caller supplied no working directories.
   */
  readonly cwds: ReadonlyArray<string>
}

/** Session credit sorted into what can be proposed, what is only reported, and what is unplaced. */
export interface CreditSplit {
  /** Attributed and trusted — eligible to become a Proposed Worklog. */
  readonly attributed: ReadonlyArray<TicketDayCredit>
  /** Attributed by a Coding Agent below the confidence floor — reported, never offered. */
  readonly withheld: ReadonlyArray<TicketDayCredit>
  /** No signal placed these hours. Reported so they stay visible. */
  readonly unattributed: ReadonlyArray<UnattributedDayCredit>
}

/** The lower of two confidences, treating "no Coding Agent involved" as absent rather than zero. */
const weakerConfidence = (a: number | null, b: number | null): number | null => {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

/** Where a session's time goes: onto an Issue Key it can be proposed for, held back, or unplaced. */
type BucketKind = "attributed" | "withheld" | "unattributed"

const bucketId = (kind: BucketKind, ticketKey: string | null): string => `${kind}\u0000${ticketKey ?? ""}`

/**
 * Fold per-session active windows onto Issue Keys, dividing every overlap between *distinct* keys.
 *
 * Bucketing happens before sharing, which is the whole point: two sessions on the same Issue Key
 * union their windows and lose nothing, while two sessions on different keys split the instants they
 * share. Below-floor and unplaced time gets its own buckets so neither can be silently dropped nor
 * silently proposed — and both still take part in the split, because they occupied real time.
 */
export const splitCredits = (
  windows: ReadonlyArray<SessionWindows>,
  attributions: ReadonlyArray<SessionAttribution>,
  options?: {
    /** Where each session ran, so unplaced hours can name the directories behind them. */
    readonly cwdBySession?: ReadonlyMap<string, string> | undefined
    /**
     * The Dwell Floor in seconds: how long a stretch must be to own time on its own. Defaults to
     * {@link DEFAULT_DWELL_SECONDS}; zero turns the rule off and reports the raw interleaving.
     */
    readonly dwellSeconds?: number | undefined
  }
): CreditSplit => {
  const bySession = new Map(attributions.map((attribution) => [attribution.sessionId, attribution]))

  const spansByBucket = new Map<string, Array<CreditedSpan>>()
  const metaByBucket = new Map<
    string,
    {
      kind: BucketKind
      ticketKey: string | null
      signal: AttributionSignal
      confidence: number | null
      sessions: Set<string>
    }
  >()

  // Which sessions contributed to a bucket *on a given day*, not merely to the bucket.
  //
  // A week's run emits one row per day, and each row's evidence has to be that day's. Carrying the
  // bucket's whole session set would ask a Coding Agent to describe Monday's work from Friday's
  // prompts — and that sentence is written verbatim into a Clockify description and a Jira worklog.
  const sessionsByBucketDay = new Map<string, Set<string>>()
  const dayKey = (bucketId: string, day: string) => `${bucketId}\u0000${day}`

  for (const session of windows) {
    const attribution = bySession.get(session.sessionId)
    const ticketKey = attribution?.ticketKey ?? null
    const kind: BucketKind = ticketKey === null
      ? "unattributed"
      : attribution?.belowConfidenceFloor === true
      ? "withheld"
      : "attributed"
    const id = bucketId(kind, ticketKey)

    spansByBucket.set(id, [...(spansByBucket.get(id) ?? []), ...session.spans])
    // Session windows are already day-bounded, so a span belongs to exactly one day.
    for (const span of session.spans) {
      const key = dayKey(id, localDay(new Date(span.startMs)))
      sessionsByBucketDay.set(key, (sessionsByBucketDay.get(key) ?? new Set()).add(session.sessionId))
    }
    const existing = metaByBucket.get(id)
    const signal = attribution?.signal ?? "none"
    const confidence = attribution?.confidence ?? null
    metaByBucket.set(id, {
      kind,
      ticketKey,
      // A bucket is only as trustworthy as its weakest evidence.
      signal: existing === undefined || signalRank(signal) > signalRank(existing.signal) ? signal : existing.signal,
      confidence: existing === undefined ? confidence : weakerConfidence(existing.confidence, confidence),
      sessions: new Set([...(existing?.sessions ?? []), session.sessionId])
    })
  }

  const shared = shareBetweenBuckets(
    new Map([...spansByBucket.entries()].map(([id, spans]) => [id, mergeSpansWithinDays(spans)])),
    {
      attributed: (id) => metaByBucket.get(id)?.kind === "attributed",
      dwellSeconds: options?.dwellSeconds ?? DEFAULT_DWELL_SECONDS
    }
  )

  const attributed: Array<TicketDayCredit> = []
  const withheld: Array<TicketDayCredit> = []
  const unattributed: Array<UnattributedDayCredit> = []

  for (const [id, perDay] of shared) {
    const meta = metaByBucket.get(id)
    if (meta === undefined) continue
    for (const [day, credit] of perDay) {
      if (credit.seconds <= 0) continue
      const daySessions = sessionsByBucketDay.get(dayKey(id, day)) ?? meta.sessions
      if (meta.kind === "unattributed") {
        const cwds = [
          ...new Set(
            [...daySessions].flatMap((sessionId) => {
              const cwd = options?.cwdBySession?.get(sessionId)
              return cwd === undefined ? [] : [cwd]
            })
          )
        ].sort()
        unattributed.push({ day, seconds: credit.seconds, sessionCount: daySessions.size, cwds })
        continue
      }
      const row: TicketDayCredit = {
        ticketKey: meta.ticketKey ?? "",
        day,
        seconds: credit.seconds,
        signal: meta.signal,
        confidence: meta.confidence,
        activeSeconds: credit.activeSeconds,
        blocks: credit.blocks,
        sourceStartMs: credit.sourceStartMs,
        settlementEndMs: credit.settlementEndMs,
        sessionIds: [...daySessions].sort()
      }
      if (meta.kind === "withheld") withheld.push(row)
      else attributed.push(row)
    }
  }

  const byDayThenTicket = (
    a: { day: string; ticketKey: string },
    b: { day: string; ticketKey: string }
  ) => (a.day === b.day ? a.ticketKey.localeCompare(b.ticketKey) : a.day.localeCompare(b.day))

  return {
    attributed: attributed.sort(byDayThenTicket),
    withheld: withheld.sort(byDayThenTicket),
    unattributed: unattributed.sort((a, b) => a.day.localeCompare(b.day))
  }
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/** What Clockify and Jira already hold for one `(Issue Key, day)` bucket. */
export interface RecordedBucket {
  readonly ticketKey: string
  readonly day: string
  readonly clockifySeconds: number
  readonly jiraSeconds: number
  readonly intervals?:
    | ReadonlyArray<{
      readonly source?: SourceConsumption.Source | undefined
      readonly startMs?: number | undefined
      readonly endMs?: number | undefined
      readonly entry?: {
        readonly source: SourceConsumption.Source
        readonly id: string
        readonly startMs: number
        readonly endMs: number
        readonly description: string | null
      } | undefined
    }>
    | undefined
}

/** A Proposed Worklog: the gap between what a session accounts for and what is already recorded. */
export interface SessionProposal {
  readonly ticketKey: string
  readonly day: string
  readonly signal: AttributionSignal
  /** Coding Agent confidence, or null when the attribution needed no Coding Agent. */
  readonly confidence: number | null
  /**
   * When the session's work happened and what each stretch is worth — the evidence behind
   * `sessionSeconds`, which is their sum. Also the unit of acceptance: a surface may offer these one
   * at a time, so long as it never writes more for the bucket than `sessionSeconds` in total.
   */
  readonly blocks: ReadonlyArray<CreditedBlock>
  /** Earliest source instant needed to reconstruct these scheduled blocks. */
  readonly sourceStartMs: number
  /** Last source instant that can still redistribute the scheduled blocks. */
  readonly settlementEndMs: number
  /**
   * Credited seconds: this Issue Key's share of the time worked. Where several keys were worked on
   * at once, that time is divided equally, so no instant is ever counted twice.
   */
  readonly sessionSeconds: number
  /** Wall-clock seconds active, before sharing. Exceeds `sessionSeconds` on parallel work. */
  readonly activeSeconds: number
  readonly clockifySeconds: number
  readonly jiraSeconds: number
  /** Seconds Clockify is short. 0 when it is not short. */
  readonly clockifyDelta: number
  /** Seconds Jira is short. 0 when it is not short. */
  readonly jiraDelta: number
  /** The sessions behind this row, for a caller that needs to read what they were about. */
  readonly sessionIds: ReadonlyArray<string>
  /** Fresh provider intervals used to place later CLI/watch top-ups in their uncovered source ranges. */
  readonly recordedIntervals?:
    | ReadonlyArray<{
      readonly source: SourceConsumption.Source
      readonly startMs: number
      readonly endMs: number
    }>
    | undefined
}

/**
 * Turn Attributed Intervals into Proposed Worklogs by subtracting what each side already holds.
 *
 * Each side is sized to *its own* gap, so a day where Clockify has nothing but Jira already has
 * an hour proposes the right amount to each rather than the same number twice. Live provider
 * durations and private provider-ID source bindings jointly protect corrected-ticket writes;
 * a complete read of a genuinely deleted entry may correctly reopen its time.
 */
/**
 * Which systems a reconciliation is about.
 *
 * A side that is out is not read, not proposed for, and not written to. That is stronger than
 * skipping its write: a side nobody read holds an unknown amount, and treating unknown as zero would
 * propose the whole day for it — which is precisely the double-log this arithmetic exists to prevent.
 */
export interface ReconcileSides {
  readonly clockify: boolean
  readonly jira: boolean
}

/** Both systems: what reconciliation means unless someone says otherwise. */
export const bothSides: ReconcileSides = { clockify: true, jira: true }

export const buildSessionProposals = (
  credits: ReadonlyArray<TicketDayCredit>,
  recorded: ReadonlyArray<RecordedBucket>,
  options: {
    /** Below this, a gap is noise and is not offered. Matches the 60s Jira worklog floor. */
    readonly minimumSeconds: number
    /** Days withheld from proposals entirely — e.g. a day with a Timer still running. */
    readonly excludedDays: ReadonlyArray<string>
    /** Which systems this run is about. Both by default. */
    readonly sides?: ReconcileSides | undefined
    /** Marker-bearing entries that remain outside ordinary ticket/day totals. */
    readonly consumptionRows?: ReadonlyArray<SourceConsumption.RecordedRow> | undefined
    /** Provider-ID-verified consumption from the server-private durable ledger. */
    readonly sourceEntries?: ReadonlyArray<SourceConsumption.ResolvedEntry> | undefined
  }
): ReadonlyArray<SessionProposal> => {
  const sides = options.sides ?? bothSides
  const excluded = new Set(options.excludedDays)
  const recordedByBucket = new Map(recorded.map((r) => [`${r.ticketKey}\u0000${r.day}`, r]))
  const consumptionRows = [
    ...recorded.map((row) => ({ ticketKey: row.ticketKey, day: row.day, intervals: row.intervals ?? [] })),
    ...(options.consumptionRows ?? [])
  ]

  const gap = (sessionSeconds: number, recordedSeconds: number): number => {
    const delta = sessionSeconds - recordedSeconds
    return delta >= options.minimumSeconds ? delta : 0
  }

  return credits
    .filter((credit) => !excluded.has(credit.day))
    .map((credit) => {
      const existing = recordedByBucket.get(`${credit.ticketKey}\u0000${credit.day}`)
      const clockifySeconds = existing?.clockifySeconds ?? 0
      const jiraSeconds = existing?.jiraSeconds ?? 0
      const sourceRowId = `${credit.day}:${credit.ticketKey}`
      const heldByBlock = SourceConsumption.consumptionForBlocks(
        consumptionRows,
        sourceRowId,
        credit.blocks,
        sides,
        options.sourceEntries
      )
      const blocks = credit.blocks.map((block, index) => {
        const held = heldByBlock[index] ?? { clockify: 0, jira: 0 }
        return {
          ...block,
          ...(held.clockify > 0 && { clockifyConsumedSeconds: Math.min(block.seconds, held.clockify) }),
          ...(held.jira > 0 && { jiraConsumedSeconds: Math.min(block.seconds, held.jira) })
        }
      })
      const correctedClockifySeconds = blocks.reduce(
        (sum, block) => sum + (block.clockifyConsumedSeconds ?? 0),
        0
      )
      const correctedJiraSeconds = blocks.reduce((sum, block) => sum + (block.jiraConsumedSeconds ?? 0), 0)
      return {
        ticketKey: credit.ticketKey,
        day: credit.day,
        signal: credit.signal,
        confidence: credit.confidence,
        blocks,
        sourceStartMs: credit.sourceStartMs,
        settlementEndMs: credit.settlementEndMs,
        sessionSeconds: credit.seconds,
        activeSeconds: credit.activeSeconds,
        clockifySeconds,
        jiraSeconds,
        recordedIntervals: (existing?.intervals ?? []).flatMap((interval) =>
          interval.source === undefined || interval.startMs === undefined || interval.endMs === undefined
            ? []
            : [{ source: interval.source, startMs: interval.startMs, endMs: interval.endMs }]
        ),
        // Zero for a side that is out of scope, never the whole day: its tally was not read, so the
        // only defensible statement about its gap is that this run makes none.
        clockifyDelta: sides.clockify ? gap(credit.seconds, clockifySeconds + correctedClockifySeconds) : 0,
        jiraDelta: sides.jira ? gap(credit.seconds, jiraSeconds + correctedJiraSeconds) : 0,
        sessionIds: credit.sessionIds
      }
    })
    .filter((proposal) => proposal.clockifyDelta > 0 || proposal.jiraDelta > 0)
}

// ---------------------------------------------------------------------------
// Session digest
// ---------------------------------------------------------------------------

const DEFAULT_DIGEST_CHARS = 4000

/**
 * A compact, bounded digest of a session's prompts for a Coding Agent to read. Takes text from
 * the start of the session — where the task is stated — and stops at the character budget, so
 * one very long transcript cannot dominate the prompt.
 */
export const buildSessionDigest = (
  texts: ReadonlyArray<string>,
  options?: { readonly maxChars?: number | undefined }
): string => {
  const maxChars = options?.maxChars ?? DEFAULT_DIGEST_CHARS
  const parts: Array<string> = []
  let length = 0
  for (const raw of texts) {
    const text = raw.trim()
    if (text === "") continue
    const remaining = maxChars - length
    if (remaining <= 0) break
    const clipped = text.length > remaining ? text.slice(0, remaining) : text
    parts.push(clipped)
    length += clipped.length + 1
  }
  return parts.join("\n")
}
