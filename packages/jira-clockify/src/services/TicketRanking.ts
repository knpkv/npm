/**
 * Which tickets win when parallel sessions compete for the same minutes.
 *
 * **Mental model**
 *
 * - **Evidence first**: ranking orders placed tickets; known sprint membership also permits a
 *   mention-weighted split of an unplaced session onto its own mined candidates. Neither adds
 *   transcript evidence or changes the wall-clock budget of a stretch.
 * - **Two facts, one extra request**: open-sprint tickets assigned to me come from one key-only JQL
 *   search. Tickets I already logged on a day come from the Jira tally the read takes anyway: JQL
 *   cannot tie `worklogAuthor` and `worklogDate` to the same worklog, so only worklog bodies say
 *   who logged what on which day.
 * - **Unknown is neutral**: when Jira cannot answer, every ticket ranks equally and evidence weight
 *   decides, exactly as before ranking existed. The failure is logged, not hidden in a number.
 *
 * @module
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { CandidateFact } from "./SessionAttributor.js"

/**
 * One page of a key-only JQL search. The page is decoded here, so the port stays independent of the
 * generated client's response types.
 */
export type JqlSearch<E> = (jql: string, nextPageToken: string | undefined) => Effect.Effect<unknown, E>

/** What Jira said about the tickets in a window, or that it could not say. */
export type RankingFacts =
  | {
    readonly _tag: "Known"
    /** Open-sprint tickets assigned to me. */
    readonly sprint: ReadonlySet<string>
    /** Tickets I already logged Jira time on, by local day. */
    readonly loggedByDay: ReadonlyMap<string, ReadonlySet<string>>
  }
  | { readonly _tag: "Unknown"; readonly reason: string }

const SPRINT_JQL = "sprint in openSprints() AND assignee = currentUser()"

/** Bound on pages per search; a ranking read that would exceed it is simply unknown. */
const MAX_PAGES = 10

class RankingReadError extends Data.TaggedError("RankingReadError")<{ readonly reason: string }> {}

/** One key-only search page. A page that does not decode makes the ranking unknown, never partial. */
const SearchPage = Schema.Struct({
  issues: Schema.Array(Schema.Struct({ key: Schema.String })),
  nextPageToken: Schema.optional(Schema.NullOr(Schema.String))
})
const decodeSearchPage = Schema.decodeUnknownEffect(SearchPage)

/** Every issue key a JQL search returns, all pages. */
const searchKeys = <E>(search: JqlSearch<E>, jql: string) =>
  Effect.gen(function*() {
    const keys = new Set<string>()
    let pageToken: string | undefined = undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const result: typeof SearchPage.Type = yield* search(jql, pageToken).pipe(
        Effect.mapError((cause) => new RankingReadError({ reason: `Jira search failed: ${String(cause)}` })),
        Effect.flatMap((response) =>
          decodeSearchPage(response).pipe(
            Effect.mapError(() => new RankingReadError({ reason: "Jira search page did not decode" }))
          )
        )
      )
      for (const issue of result.issues) keys.add(issue.key)
      const next: string | null | undefined = result.nextPageToken
      if (next === undefined || next === null || next.trim() === "") return keys
      pageToken = next
    }
    return yield* new RankingReadError({ reason: "Jira returned more pages than a ranking read takes" })
  })

/** One tallied Jira worklog: my seconds on a ticket on a local day. */
export interface LoggedTally {
  readonly ticketKey: string
  readonly day: string
  readonly seconds: number
}

/** Tickets I logged Jira time on, by local day. */
export const loggedByDay = (tally: ReadonlyArray<LoggedTally>): ReadonlyMap<string, ReadonlySet<string>> => {
  const byDay = new Map<string, Set<string>>()
  for (const row of tally) {
    if (row.seconds <= 0) continue
    byDay.set(row.day, (byDay.get(row.day) ?? new Set()).add(row.ticketKey))
  }
  return byDay
}

/**
 * Combine the open sprint with an already-read Jira tally. Never fails: a sprint Jira cannot answer
 * or a tally that could not be read yields `Unknown`, which ranks every ticket equally.
 */
export const readRankingFacts = <E>(
  search: JqlSearch<E>,
  tally: ReadonlyArray<LoggedTally> | undefined
): Effect.Effect<RankingFacts> =>
  Effect.gen(function*() {
    if (tally === undefined) return yield* new RankingReadError({ reason: "Jira worklogs could not be read" })
    const sprint = yield* searchKeys(search, SPRINT_JQL)
    return { _tag: "Known", sprint, loggedByDay: loggedByDay(tally) } satisfies RankingFacts
  }).pipe(
    Effect.catchTag("RankingReadError", (error) =>
      Effect.logWarning(`Ticket ranking unavailable, ranking by evidence only: ${error.reason}`).pipe(
        Effect.as({ _tag: "Unknown", reason: error.reason } satisfies RankingFacts)
      ))
  )

/**
 * Higher ranks first: an open-sprint ticket assigned to me outranks one that is not, and between
 * equals a ticket not yet logged that day outranks one already logged. Unknown facts rank all equal.
 */
export const ticketPriority = (facts: RankingFacts) => (ticketKey: string, day: string): number => {
  if (facts._tag === "Unknown") return 0
  const inSprint = facts.sprint.has(ticketKey) ? 2 : 0
  const notLogged = facts.loggedByDay.get(day)?.has(ticketKey) === true ? 0 : 1
  return inSprint + notLogged
}

/** Period-level facts for the attribution prompt: in my open sprint, and logged on any day of it. */
export const candidateFact = (facts: RankingFacts) => (ticketKey: string): CandidateFact | undefined => {
  if (facts._tag === "Unknown") return undefined
  return {
    inSprint: facts.sprint.has(ticketKey),
    logged: [...facts.loggedByDay.values()].some((keys) => keys.has(ticketKey))
  }
}
