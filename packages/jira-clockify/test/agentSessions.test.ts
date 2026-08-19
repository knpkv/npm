import { describe, expect, it } from "@effect/vitest"
import {
  activeWindows,
  attributeSession,
  buildSessionDigest,
  buildSessionProposals,
  deterministicAttribution,
  expandHomePath,
  isPlaceholderTicketKey,
  isWithinPrefix,
  isWithinSessionRoots,
  mergeSpansWithinDays,
  mineTicketKeys,
  type SessionAttribution,
  splitCredits,
  standingAttribution,
  type TicketDayCredit,
  ticketKeyFromBranch,
  ticketKeyFromPath
} from "../src/agent/sessions.js"

// Timezone-independent: build instants from local components so a day boundary is a *local*
// midnight wherever the suite runs.
const at = (year: number, month: number, day: number, hour: number, minute: number, second = 0): number =>
  new Date(year, month - 1, day, hour, minute, second, 0).getTime()

const activity = (sessionId: string, atMs: number) => ({ sessionId, atMs })

describe("mineTicketKeys", () => {
  it("dedupes and preserves first-appearance order", () => {
    expect(mineTicketKeys("fix PROJ-42 then ABC-7 then PROJ-42 again")).toEqual(["PROJ-42", "ABC-7"])
  })

  it("ignores lowercase and single-letter look-alikes", () => {
    expect(mineTicketKeys("branch feat/jcf-ai bumped to v2-3 and x-9")).toEqual([])
  })

  // Frequency is anti-correlated with what should be billed, so a key mentioned once ranks
  // exactly like one mentioned fifty times.
  it("does not rank by frequency", () => {
    const text = `${"KNOWN-99 ".repeat(50)} plus WORKED-1`
    expect(mineTicketKeys(text)).toEqual(["KNOWN-99", "WORKED-1"])
  })

  it("drops placeholder keys so documentation examples cannot generate worklogs", () => {
    expect(mineTicketKeys("see PROJ-123, PROJ-1234, PROJ-333 and the real PROJ-5662")).toEqual(["PROJ-5662"])
  })

  it("caps the candidate list so a prompt stays bounded", () => {
    const text = Array.from({ length: 40 }, (_, i) => `PROJ-${5000 + i}`).join(" ")
    expect(mineTicketKeys(text, { limit: 5 })).toHaveLength(5)
  })

  it("finds nothing in a transcript that mentions no key", () => {
    expect(mineTicketKeys("just refactoring the parser today")).toEqual([])
  })
})

describe("isPlaceholderTicketKey", () => {
  it.each([
    ["PROJ-123", true],
    ["PROJ-1234", true],
    ["PROJ-333", true],
    ["PROJ-4444", true],
    ["PROJ-12", false],
    ["PROJ-1", false],
    ["PROJ-5662", false],
    ["PROJ-100", false]
  ])("%s -> %s", (key, expected) => {
    expect(isPlaceholderTicketKey(key)).toBe(expected)
  })
})

describe("deterministic signals", () => {
  it("takes the key from a branch", () => {
    expect(ticketKeyFromBranch("feat/PROJ-5662-otel")).toBe("PROJ-5662")
  })

  it("returns null for a branch template with no number", () => {
    expect(ticketKeyFromBranch("feat/PROJ-XXXX-otel")).toBeNull()
  })

  it("returns null for an integration branch", () => {
    expect(ticketKeyFromBranch("release-candidate")).toBeNull()
    expect(ticketKeyFromBranch("develop")).toBeNull()
    expect(ticketKeyFromBranch(null)).toBeNull()
  })

  // A branch is a deliberate act, so a low ticket number in one is not treated as filler.
  it("does not apply the placeholder filter to a branch", () => {
    expect(ticketKeyFromBranch("feat/PROJ-123-early-days")).toBe("PROJ-123")
  })

  it("takes the deepest key from a path, which is what makes worktrees attributable", () => {
    expect(ticketKeyFromPath("/dev/repo/worktrees/PROJ-1/PROJ-2/src")).toBe("PROJ-2")
    expect(ticketKeyFromPath("/dev/repo/plain")).toBeNull()
  })
})

describe("prefix matching", () => {
  it("matches on a separator boundary, not a bare string prefix", () => {
    expect(isWithinPrefix("/a/b/c", "/a/b")).toBe(true)
    expect(isWithinPrefix("/a/b", "/a/b")).toBe(true)
    expect(isWithinPrefix("/a/bc", "/a/b")).toBe(false)
  })

  it("tolerates trailing slashes on either side", () => {
    expect(isWithinPrefix("/a/b/", "/a/b")).toBe(true)
    expect(isWithinPrefix("/a/b/c", "/a/b/")).toBe(true)
  })

  it("treats an empty prefix as matching nothing rather than everything", () => {
    expect(isWithinPrefix("/a/b", "")).toBe(false)
  })

  it("expands a leading tilde", () => {
    expect(expandHomePath("~/dev/work", "/home/me")).toBe("/home/me/dev/work")
    expect(expandHomePath("~", "/home/me")).toBe("/home/me")
    expect(expandHomePath("/absolute", "/home/me")).toBe("/absolute")
  })

  it("keeps out-of-scope directories out of scope", () => {
    const roots = ["/home/me/dev/work"]
    expect(isWithinSessionRoots("/home/me/dev/work/repo", roots)).toBe(true)
    expect(isWithinSessionRoots("/private/tmp/scratch", roots)).toBe(false)
    expect(isWithinSessionRoots("/home/me/dev/work/repo", [])).toBe(false)
  })
})

describe("standingAttribution", () => {
  const map = {
    "/home/me/dev/docs": "DOCS-1",
    "/home/me/dev/docs/interviews": "HIRE-1"
  }

  it("prefers the longest matching prefix", () => {
    expect(standingAttribution("/home/me/dev/docs/interviews/round-2", map)).toBe("HIRE-1")
    expect(standingAttribution("/home/me/dev/docs/releases", map)).toBe("DOCS-1")
  })

  it("leaves unmapped directories unattributed rather than absorbing them", () => {
    expect(standingAttribution("/home/me/dev/other", map)).toBeNull()
  })
})

describe("attributeSession", () => {
  const session = {
    sessionId: "s1",
    cwd: "/home/me/dev/docs",
    gitBranch: null,
    candidateKeys: ["PROJ-7", "PROJ-8"]
  }

  it("prefers a branch over every weaker signal", () => {
    const result = attributeSession(
      { ...session, gitBranch: "feat/PROJ-1-x", cwd: "/dev/PROJ-2" },
      { standingMap: { "/dev": "PROJ-3" }, agentChoice: { ticketKey: "PROJ-7", confidence: 1 }, confidenceFloor: 0.7 }
    )
    expect(result).toMatchObject({ ticketKey: "PROJ-1", signal: "branch", confidence: null })
  })

  it("falls back to the path when the branch names nothing", () => {
    const result = attributeSession(
      { ...session, gitBranch: "HEAD", cwd: "/dev/PROJ-2" },
      { standingMap: { "/dev": "PROJ-3" }, confidenceFloor: 0.7 }
    )
    expect(result).toMatchObject({ ticketKey: "PROJ-2", signal: "path" })
  })

  // Adding a Standing Attribution can only ever add attribution, never redirect existing work.
  it("uses a Standing Attribution only when branch and path are silent", () => {
    const result = deterministicAttribution(session, { standingMap: { "/home/me/dev/docs": "DOCS-1" } })
    expect(result).toEqual({ ticketKey: "DOCS-1", signal: "standing" })
  })

  it("accepts a Coding Agent choice drawn from the transcript's own keys", () => {
    const result = attributeSession(session, {
      standingMap: {},
      agentChoice: { ticketKey: "PROJ-8", confidence: 0.9 },
      confidenceFloor: 0.7
    })
    expect(result).toMatchObject({ ticketKey: "PROJ-8", signal: "agent", confidence: 0.9 })
    expect(result.belowConfidenceFloor).toBe(false)
  })

  // The closed choice set is what makes an invented key impossible rather than merely unlikely.
  it("rejects a key the transcript never mentioned, however confident", () => {
    const result = attributeSession(session, {
      standingMap: {},
      agentChoice: { ticketKey: "INVENTED-1", confidence: 1 },
      confidenceFloor: 0.7
    })
    expect(result).toMatchObject({ ticketKey: null, signal: "none" })
  })

  it("marks a below-floor choice so it can be reported without being offered", () => {
    const result = attributeSession(session, {
      standingMap: {},
      agentChoice: { ticketKey: "PROJ-7", confidence: 0.4 },
      confidenceFloor: 0.7
    })
    expect(result).toMatchObject({ ticketKey: "PROJ-7", signal: "agent", belowConfidenceFloor: true })
  })

  it("reports a session with no signal at all as unattributed", () => {
    const result = attributeSession(
      { sessionId: "s2", cwd: "/dev/plain", gitBranch: "develop", candidateKeys: [] },
      { standingMap: {}, confidenceFloor: 0.7 }
    )
    expect(result).toMatchObject({ ticketKey: null, signal: "none" })
  })
})

describe("activeWindows and sharing", () => {
  const idleCapSeconds = 300

  /**
   * The real composition: discover windows, attribute sessions, then share overlaps. Sharing is
   * only meaningful once sessions have Issue Keys, so testing the two steps together is what
   * actually pins the behaviour.
   */
  const creditFor = (
    events: ReadonlyArray<{ sessionId: string; atMs: number }>,
    tickets: Readonly<Record<string, string | null>>
  ) => {
    const attributions: ReadonlyArray<SessionAttribution> = Object.entries(tickets).map(([sessionId, ticketKey]) => ({
      sessionId,
      ticketKey,
      signal: ticketKey === null ? "none" : "branch",
      confidence: null,
      belowConfidenceFloor: false
    }))
    return splitCredits(activeWindows(events, { idleCapSeconds }), attributions)
  }

  const ticketSeconds = (split: ReturnType<typeof creditFor>, ticketKey: string, day: string): number =>
    split.attributed.find((row) => row.ticketKey === ticketKey && row.day === day)?.seconds ?? 0

  it("finds no window for no events, or for a single event", () => {
    expect(activeWindows([], { idleCapSeconds })).toEqual([])
    expect(activeWindows([activity("s1", at(2026, 7, 1, 10, 0))], { idleCapSeconds })).toEqual([])
  })

  // Duration comes from the gap between a session's *own* events. Borrowing another session's next
  // event to invent one is what the old last-touch rule did.
  it("credits nothing when each session has a single event", () => {
    const split = creditFor(
      [activity("s1", at(2026, 7, 1, 10, 0)), activity("s2", at(2026, 7, 1, 10, 2))],
      { s1: "PROJ-1", s2: "PROJ-2" }
    )
    expect(split.attributed).toEqual([])
  })

  it("credits a session's own gap to its ticket", () => {
    const split = creditFor(
      [activity("s1", at(2026, 7, 1, 10, 0)), activity("s1", at(2026, 7, 1, 10, 2))],
      { s1: "PROJ-1" }
    )
    expect(ticketSeconds(split, "PROJ-1", "2026-07-01")).toBe(120)
  })

  // The bug this ordering exists to prevent: two sessions on ONE ticket must not halve each other.
  // Splitting per session instead of per Issue Key silently lost that overlap.
  it("unions two concurrent sessions on the same ticket, losing nothing", () => {
    const split = creditFor(
      [
        activity("s1", at(2026, 7, 1, 10, 0)),
        activity("s1", at(2026, 7, 1, 10, 4)),
        activity("s2", at(2026, 7, 1, 10, 0)),
        activity("s2", at(2026, 7, 1, 10, 4))
      ],
      { s1: "PROJ-1", s2: "PROJ-1" }
    )
    expect(ticketSeconds(split, "PROJ-1", "2026-07-01")).toBe(240)
    expect(split.attributed[0]?.activeSeconds).toBe(240)
  })

  // The request: an hour on two tickets at once is half an hour each, not an hour to whichever
  // session happened to be chattier.
  it("splits a fully overlapping window equally between two tickets", () => {
    const split = creditFor(
      [
        activity("s1", at(2026, 7, 1, 10, 0)),
        activity("s1", at(2026, 7, 1, 10, 4)),
        activity("s2", at(2026, 7, 1, 10, 0)),
        activity("s2", at(2026, 7, 1, 10, 4))
      ],
      { s1: "PROJ-1", s2: "PROJ-2" }
    )
    expect(ticketSeconds(split, "PROJ-1", "2026-07-01")).toBe(120)
    expect(ticketSeconds(split, "PROJ-2", "2026-07-01")).toBe(120)
  })

  it("splits a three-way overlap into thirds", () => {
    const events = ["s1", "s2", "s3"].flatMap((id) => [
      activity(id, at(2026, 7, 1, 10, 0)),
      activity(id, at(2026, 7, 1, 10, 3))
    ])
    const split = creditFor(events, { s1: "PROJ-1", s2: "PROJ-2", s3: "PROJ-3" })
    for (const key of ["PROJ-1", "PROJ-2", "PROJ-3"]) {
      expect(ticketSeconds(split, key, "2026-07-01")).toBe(60)
    }
  })

  it("divides only the overlapping part, leaving solo stretches whole", () => {
    const split = creditFor(
      [
        activity("s1", at(2026, 7, 1, 10, 0)),
        activity("s1", at(2026, 7, 1, 10, 4)),
        activity("s2", at(2026, 7, 1, 10, 2)),
        activity("s2", at(2026, 7, 1, 10, 4))
      ],
      { s1: "PROJ-1", s2: "PROJ-2" }
    )
    // 10:00-10:02 is PROJ-1 alone (120s); 10:02-10:04 is shared (60s each).
    expect(ticketSeconds(split, "PROJ-1", "2026-07-01")).toBe(180)
    expect(ticketSeconds(split, "PROJ-2", "2026-07-01")).toBe(60)
  })

  it("reports wall-clock active seconds next to the shared credit", () => {
    const split = creditFor(
      [
        activity("s1", at(2026, 7, 1, 10, 0)),
        activity("s1", at(2026, 7, 1, 10, 4)),
        activity("s2", at(2026, 7, 1, 10, 0)),
        activity("s2", at(2026, 7, 1, 10, 4))
      ],
      { s1: "PROJ-1", s2: "PROJ-2" }
    )
    const row = split.attributed.find((entry) => entry.ticketKey === "PROJ-1")
    expect(row?.seconds).toBe(120)
    expect(row?.activeSeconds).toBe(240)
  })

  // Unplaced time occupied the clock too, so it takes part in the split rather than letting an
  // attributed ticket claim a moment it was only half responsible for.
  it("shares with unattributed time as well", () => {
    const split = creditFor(
      [
        activity("s1", at(2026, 7, 1, 10, 0)),
        activity("s1", at(2026, 7, 1, 10, 4)),
        activity("s2", at(2026, 7, 1, 10, 0)),
        activity("s2", at(2026, 7, 1, 10, 4))
      ],
      { s1: "PROJ-1", s2: null }
    )
    expect(ticketSeconds(split, "PROJ-1", "2026-07-01")).toBe(120)
    expect(split.unattributed).toEqual([{ day: "2026-07-01", seconds: 120, sessionCount: 1 }])
  })

  it("caps a long gap at the Idle Cap, so lunch is not billed", () => {
    const split = creditFor(
      [activity("s1", at(2026, 7, 1, 12, 0)), activity("s1", at(2026, 7, 1, 13, 0))],
      { s1: "PROJ-1" }
    )
    expect(ticketSeconds(split, "PROJ-1", "2026-07-01")).toBe(300)
  })

  it("credits an interval exactly equal to the Idle Cap in full", () => {
    const split = creditFor(
      [activity("s1", at(2026, 7, 1, 10, 0)), activity("s1", at(2026, 7, 1, 10, 5))],
      { s1: "PROJ-1" }
    )
    expect(ticketSeconds(split, "PROJ-1", "2026-07-01")).toBe(300)
  })

  it("credits nothing for adjacent identical timestamps", () => {
    const split = creditFor(
      [activity("s1", at(2026, 7, 1, 10, 0)), activity("s1", at(2026, 7, 1, 10, 0))],
      { s1: "PROJ-1" }
    )
    expect(split.attributed).toEqual([])
  })

  it("splits an interval crossing local midnight at midnight", () => {
    const split = creditFor(
      [activity("s1", at(2026, 7, 1, 23, 58)), activity("s1", at(2026, 7, 2, 0, 1))],
      { s1: "PROJ-1" }
    )
    expect(ticketSeconds(split, "PROJ-1", "2026-07-01")).toBe(120)
    expect(ticketSeconds(split, "PROJ-1", "2026-07-02")).toBe(60)
  })

  it("credits an overnight gap to nobody", () => {
    const split = creditFor(
      [activity("s1", at(2026, 7, 1, 14, 30)), activity("s1", at(2026, 7, 2, 9, 0))],
      { s1: "PROJ-1" }
    )
    expect(ticketSeconds(split, "PROJ-1", "2026-07-01")).toBe(300)
    expect(ticketSeconds(split, "PROJ-1", "2026-07-02")).toBe(0)
  })

  it("credits nothing when the Idle Cap is zero", () => {
    const split = splitCredits(
      activeWindows(
        [activity("s1", at(2026, 7, 1, 10, 0)), activity("s1", at(2026, 7, 1, 10, 5))],
        { idleCapSeconds: 0 }
      ),
      [{ sessionId: "s1", ticketKey: "PROJ-1", signal: "branch", confidence: null, belowConfidenceFloor: false }]
    )
    expect(split.attributed).toEqual([])
  })

  // Sharing divides an instant, never duplicates it, so a day of heavy parallel work still totals
  // the wall clock it occupied — the property that keeps a multi-session day off twenty hours.
  it("totals the wall clock of the union, however many tickets overlap", () => {
    const events = ["s1", "s2", "s3"].flatMap((id) => [
      activity(id, at(2026, 7, 1, 10, 0)),
      activity(id, at(2026, 7, 1, 10, 2)),
      activity(id, at(2026, 7, 1, 10, 4))
    ])
    const split = creditFor(events, { s1: "PROJ-1", s2: "PROJ-2", s3: "PROJ-3" })
    const total = split.attributed.reduce((sum, row) => sum + row.seconds, 0)
    expect(total).toBe(240)
  })
})

describe("splitCredits", () => {
  /** A credited bucket from `[fromH, fromM, toH, toM]` spans on `day`, seconds derived from them. */
  const credited = (
    sessionId: string,
    day: string,
    spans: ReadonlyArray<readonly [number, number, number, number]>
  ) => {
    const [year, month, dayOfMonth] = day.split("-").map(Number)
    const built = spans.map(([fromH, fromM, toH, toM]) => ({
      startMs: new Date(year!, month! - 1, dayOfMonth!, fromH, fromM, 0, 0).getTime(),
      endMs: new Date(year!, month! - 1, dayOfMonth!, toH, toM, 0, 0).getTime()
    }))
    return {
      sessionId,
      day,
      seconds: built.reduce((total, span) => total + (span.endMs - span.startMs) / 1000, 0),
      spans: built
    }
  }

  const attribution = (overrides: Partial<SessionAttribution> & { sessionId: string }): SessionAttribution => ({
    ticketKey: null,
    signal: "none",
    confidence: null,
    belowConfidenceFloor: false,
    ...overrides
  })

  it("folds several sessions onto one Issue Key and keeps the weakest signal", () => {
    const split = splitCredits(
      [
        credited("s1", "2026-07-01", [[10, 0, 10, 10]]),
        credited("s2", "2026-07-01", [[11, 0, 11, 5]])
      ],
      [
        attribution({ sessionId: "s1", ticketKey: "PROJ-1", signal: "branch" }),
        attribution({ sessionId: "s2", ticketKey: "PROJ-1", signal: "agent", confidence: 0.8 })
      ]
    )
    expect(split.attributed).toHaveLength(1)
    expect(split.attributed[0]).toMatchObject({
      ticketKey: "PROJ-1",
      day: "2026-07-01",
      seconds: 900,
      signal: "agent",
      confidence: 0.8
    })
    // Two separate blocks of work, kept separate because they are not contiguous.
    expect(split.attributed[0]!.spans).toHaveLength(2)
  })

  it("keeps below-floor credit out of the proposable set but still reports it", () => {
    const split = splitCredits(
      [credited("s1", "2026-07-01", [[10, 0, 10, 10]])],
      [attribution({
        sessionId: "s1",
        ticketKey: "PROJ-1",
        signal: "agent",
        confidence: 0.2,
        belowConfidenceFloor: true
      })]
    )
    expect(split.attributed).toEqual([])
    expect(split.withheld).toHaveLength(1)
  })

  it("reports unplaced hours per day with the session count", () => {
    const split = splitCredits(
      [
        credited("s1", "2026-07-01", [[10, 0, 10, 10]]),
        credited("s2", "2026-07-01", [[11, 0, 11, 5]])
      ],
      [attribution({ sessionId: "s1" }), attribution({ sessionId: "s2" })]
    )
    expect(split.unattributed).toEqual([{ day: "2026-07-01", seconds: 900, sessionCount: 2 }])
  })

  it("treats credit for an unknown session as unattributed rather than dropping it", () => {
    const split = splitCredits([credited("ghost", "2026-07-01", [[10, 0, 10, 1]])], [])
    expect(split.unattributed).toEqual([{ day: "2026-07-01", seconds: 60, sessionCount: 1 }])
  })
})

// Regression guard: merging welded two windows that met at midnight into one, whose start decided
// the day — silently moving a morning's work onto the previous day. It recurred once at a second
// merge site, which is why every merge now goes through the day-aware helper.
describe("mergeSpansWithinDays", () => {
  it("merges touching spans", () => {
    const merged = mergeSpansWithinDays([
      { startMs: at(2026, 7, 1, 10, 0), endMs: at(2026, 7, 1, 10, 10) },
      { startMs: at(2026, 7, 1, 10, 10), endMs: at(2026, 7, 1, 10, 20) }
    ])
    expect(merged).toEqual([{ startMs: at(2026, 7, 1, 10, 0), endMs: at(2026, 7, 1, 10, 20) }])
  })

  it("never merges across a local midnight", () => {
    const merged = mergeSpansWithinDays([
      { startMs: at(2026, 7, 1, 23, 50), endMs: at(2026, 7, 2, 0, 0) },
      { startMs: at(2026, 7, 2, 0, 0), endMs: at(2026, 7, 2, 0, 10) }
    ])
    expect(merged).toEqual([
      { startMs: at(2026, 7, 1, 23, 50), endMs: at(2026, 7, 2, 0, 0) },
      { startMs: at(2026, 7, 2, 0, 0), endMs: at(2026, 7, 2, 0, 10) }
    ])
  })

  it("cuts a multi-day span into one span per day", () => {
    const merged = mergeSpansWithinDays([{ startMs: at(2026, 7, 1, 23, 0), endMs: at(2026, 7, 3, 1, 0) }])
    expect(merged).toHaveLength(3)
  })
})

describe("buildSessionProposals", () => {
  const credit = (seconds: number): ReadonlyArray<TicketDayCredit> => [{
    ticketKey: "PROJ-1",
    day: "2026-07-01",
    seconds,
    signal: "branch",
    confidence: null,
    spans: [{ startMs: at(2026, 7, 1, 10, 0), endMs: at(2026, 7, 1, 10, 0) + seconds * 1000 }]
  }]

  it("proposes the whole amount when neither side holds anything", () => {
    const proposals = buildSessionProposals(credit(3600), [], { minimumSeconds: 60, excludedDays: [] })
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ clockifyDelta: 3600, jiraDelta: 3600 })
  })

  // Each side is sized to its own gap, so an hour already in Jira does not shrink the Clockify row.
  it("sizes each side to its own gap", () => {
    const proposals = buildSessionProposals(
      credit(3600),
      [{ ticketKey: "PROJ-1", day: "2026-07-01", clockifySeconds: 0, jiraSeconds: 3000 }],
      { minimumSeconds: 60, excludedDays: [] }
    )
    expect(proposals[0]).toMatchObject({ clockifyDelta: 3600, jiraDelta: 600 })
  })

  it("proposes nothing when both sides already hold the time", () => {
    const proposals = buildSessionProposals(
      credit(3600),
      [{ ticketKey: "PROJ-1", day: "2026-07-01", clockifySeconds: 3600, jiraSeconds: 3600 }],
      { minimumSeconds: 60, excludedDays: [] }
    )
    expect(proposals).toEqual([])
  })

  it("never proposes a negative amount when a side holds more than the session accounts for", () => {
    const proposals = buildSessionProposals(
      credit(600),
      [{ ticketKey: "PROJ-1", day: "2026-07-01", clockifySeconds: 7200, jiraSeconds: 7200 }],
      { minimumSeconds: 60, excludedDays: [] }
    )
    expect(proposals).toEqual([])
  })

  it("drops sub-minute gaps, which Jira could not record faithfully anyway", () => {
    const proposals = buildSessionProposals(credit(45), [], { minimumSeconds: 60, excludedDays: [] })
    expect(proposals).toEqual([])
  })

  it("withholds an excluded day entirely", () => {
    const proposals = buildSessionProposals(credit(3600), [], {
      minimumSeconds: 60,
      excludedDays: ["2026-07-01"]
    })
    expect(proposals).toEqual([])
  })
})

describe("buildSessionDigest", () => {
  it("joins prompts in order and drops blanks", () => {
    expect(buildSessionDigest(["first", "  ", "second"])).toBe("first\nsecond")
  })

  it("stops at the character budget so one long transcript cannot dominate", () => {
    const digest = buildSessionDigest(["a".repeat(50), "b".repeat(50)], { maxChars: 60 })
    expect(digest.length).toBeLessThanOrEqual(61)
    expect(digest.startsWith("a".repeat(50))).toBe(true)
  })

  it("returns an empty digest for a session with no text", () => {
    expect(buildSessionDigest([])).toBe("")
  })
})
