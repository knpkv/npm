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
 */
const TICKET_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g

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
 * The Issue Key a git branch names, or null. Takes the first match so `RPS-1/RPS-2` resolves
 * predictably, and applies no placeholder filter — naming a branch is a deliberate act.
 */
export const ticketKeyFromBranch = (branch: string | null | undefined): string | null => {
  if (branch === null || branch === undefined || branch === "") return null
  return matchTicketKeys(branch)[0] ?? null
}

/**
 * The Issue Key a working directory path names, or null. Takes the *last* match so the deepest
 * segment wins — a worktree at `~/dev/repo/worktrees/RPS-1/RPS-2` is working on `RPS-2`.
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
      spans: sessionActiveWindows(events, capMs, options.observedAtMs)
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

/** Credited and wall-clock seconds for one bucket on one day. */
interface BucketDayCredit {
  readonly seconds: number
  readonly activeSeconds: number
  readonly spans: ReadonlyArray<CreditedSpan>
}

/**
 * Share time between buckets, dividing every overlap equally.
 *
 * Where several buckets were active at the same instant, that instant is divided equally between
 * them, so an hour spent on three tickets at once credits twenty minutes to each rather than an
 * hour to whichever session happened to log an event first. Two sessions on the *same* bucket do
 * not divide anything — their windows are unioned first, because there is no ambiguity about which
 * Issue Key that time belongs to.
 *
 * A slice's duration is divided, never duplicated, so the total across every bucket can never
 * exceed the wall clock of the day.
 */
const shareBetweenBuckets = (
  spansByBucket: ReadonlyMap<string, ReadonlyArray<CreditedSpan>>
): ReadonlyMap<string, ReadonlyMap<string, BucketDayCredit>> => {
  const totals = new Map<string, Map<string, { creditedMs: number; activeMs: number }>>()
  const add = (bucketId: string, day: string, creditedMs: number, activeMs: number) => {
    const byDay = totals.get(bucketId) ?? new Map<string, { creditedMs: number; activeMs: number }>()
    const existing = byDay.get(day) ?? { creditedMs: 0, activeMs: 0 }
    byDay.set(day, { creditedMs: existing.creditedMs + creditedMs, activeMs: existing.activeMs + activeMs })
    totals.set(bucketId, byDay)
  }

  for (const slice of overlapSlices(spansByBucket)) {
    // Windows are already day-bounded, so a slice never straddles two days.
    const day = localDay(new Date(slice.startMs))
    const duration = slice.endMs - slice.startMs
    for (const bucketId of slice.bucketIds) add(bucketId, day, duration / slice.bucketIds.length, duration)
  }

  const result = new Map<string, Map<string, BucketDayCredit>>()
  for (const [bucketId, byDay] of totals) {
    const spansByDay = new Map<string, Array<CreditedSpan>>()
    for (const span of spansByBucket.get(bucketId) ?? []) {
      const day = localDay(new Date(span.startMs))
      spansByDay.set(day, [...(spansByDay.get(day) ?? []), span])
    }
    const perDay = new Map<string, BucketDayCredit>()
    for (const [day, sums] of byDay) {
      perDay.set(day, {
        // Floor, not round. A share of an odd-length slice is fractional, and rounding each bucket
        // up independently can push the day one second past the wall clock it occupied — breaking
        // the one invariant this shape exists to guarantee. Flooring errs the way the design prefers.
        seconds: Math.floor(sums.creditedMs / 1000),
        activeSeconds: Math.floor(sums.activeMs / 1000),
        spans: mergeSpansWithinDays(spansByDay.get(day) ?? [])
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
  /** When the work happened, merged and ascending. */
  readonly spans: ReadonlyArray<CreditedSpan>
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
  attributions: ReadonlyArray<SessionAttribution>
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
    new Map([...spansByBucket.entries()].map(([id, spans]) => [id, mergeSpansWithinDays(spans)]))
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
        unattributed.push({ day, seconds: credit.seconds, sessionCount: daySessions.size })
        continue
      }
      const row: TicketDayCredit = {
        ticketKey: meta.ticketKey ?? "",
        day,
        seconds: credit.seconds,
        signal: meta.signal,
        confidence: meta.confidence,
        activeSeconds: credit.activeSeconds,
        spans: credit.spans,
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
}

/** A Proposed Worklog: the gap between what a session accounts for and what is already recorded. */
export interface SessionProposal {
  readonly ticketKey: string
  readonly day: string
  readonly signal: AttributionSignal
  /** Coding Agent confidence, or null when the attribution needed no Coding Agent. */
  readonly confidence: number | null
  /** When the session's work happened — the evidence behind `sessionSeconds`. */
  readonly spans: ReadonlyArray<CreditedSpan>
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
}

/**
 * Turn Attributed Intervals into Proposed Worklogs by subtracting what each side already holds.
 *
 * Each side is sized to *its own* gap, so a day where Clockify has nothing but Jira already has
 * an hour proposes the right amount to each rather than the same number twice. Subtracting live
 * state is also the whole of the idempotency story: nothing is persisted, so running twice
 * cannot double-log and a manually deleted entry is correctly re-proposed.
 */
export const buildSessionProposals = (
  credits: ReadonlyArray<TicketDayCredit>,
  recorded: ReadonlyArray<RecordedBucket>,
  options: {
    /** Below this, a gap is noise and is not offered. Matches the 60s Jira worklog floor. */
    readonly minimumSeconds: number
    /** Days withheld from proposals entirely — e.g. a day with a Timer still running. */
    readonly excludedDays: ReadonlyArray<string>
  }
): ReadonlyArray<SessionProposal> => {
  const excluded = new Set(options.excludedDays)
  const recordedByBucket = new Map(recorded.map((r) => [`${r.ticketKey}\u0000${r.day}`, r]))

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
      return {
        ticketKey: credit.ticketKey,
        day: credit.day,
        signal: credit.signal,
        confidence: credit.confidence,
        spans: credit.spans,
        sessionSeconds: credit.seconds,
        activeSeconds: credit.activeSeconds,
        clockifySeconds,
        jiraSeconds,
        clockifyDelta: gap(credit.seconds, clockifySeconds),
        jiraDelta: gap(credit.seconds, jiraSeconds),
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
