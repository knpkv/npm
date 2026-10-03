/**
 * Jira titles for ticket Bookings, looked up with `acli` and cached in the store for a day.
 *
 * **Mental model**
 *
 * - **Optional decoration.** A Booking is its key; a title only helps read it. Lookups run in the
 *   background after an ingest pass, so a slow or missing `acli` never delays a page.
 * - **Three answers, never blank.** A title is Known, or Unknown because Jira has no such ticket
 *   (`NotFound`, cached like a title) or because no lookup has succeeded yet (`NotLookedUp`).
 * - **A failed lookup caches nothing**, so the next pass tries again, and the failure is reported
 *   rather than swallowed.
 *
 * @module
 */
import { Clock, Data, Duration, Effect, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { TicketTitleValue } from "./Model.js"
import { type StoreError, UsageStore } from "./Store.js"

export class TicketLookupFailed extends Data.TaggedError("TicketLookupFailed")<{ readonly reason: string }> {}

/** Finds the summaries of the given keys; a key Jira does not return is absent from the map. */
export type TicketSearch = (
  keys: ReadonlyArray<string>
) => Effect.Effect<ReadonlyMap<string, string>, TicketLookupFailed>

const ACLI_TIMEOUT = Duration.seconds(30)
const FRESH_FOR_MILLIS = 24 * 60 * 60 * 1000
const KEYS_PER_SEARCH = 50

/** Looks up keys whose cached title is missing or older than a day. Returns the lookups that failed. */
export const refreshTicketTitles = (
  keys: ReadonlyArray<string>,
  search: TicketSearch
): Effect.Effect<ReadonlyArray<TicketLookupFailed>, StoreError, UsageStore> =>
  Effect.gen(function*() {
    const store = yield* UsageStore
    const now = yield* Clock.currentTimeMillis
    const cached = new Map((yield* store.tickets(keys)).map((ticket) => [ticket.key, ticket.fetchedAt]))
    const stale = [...new Set(keys)].filter((key) => {
      const fetchedAt = cached.get(key)
      return fetchedAt === undefined || now - fetchedAt > FRESH_FOR_MILLIS
    })
    const failures: Array<TicketLookupFailed> = []
    for (let start = 0; start < stale.length; start += KEYS_PER_SEARCH) {
      const batch = stale.slice(start, start + KEYS_PER_SEARCH)
      const found = yield* Effect.result(search(batch))
      if (found._tag === "Failure") {
        failures.push(found.failure)
        continue
      }
      for (const key of batch) {
        yield* store.saveTicket({ key, summary: found.success.get(key) ?? null, fetchedAt: now })
      }
    }
    return failures
  })

/** The cached title of each key. */
export const ticketTitles = (
  keys: ReadonlyArray<string>
): Effect.Effect<Readonly<Record<string, TicketTitleValue>>, StoreError, UsageStore> =>
  Effect.gen(function*() {
    const store = yield* UsageStore
    const cached = new Map((yield* store.tickets(keys)).map((ticket) => [ticket.key, ticket.summary]))
    const titles: Record<string, TicketTitleValue> = {}
    for (const key of keys) {
      const summary = cached.get(key)
      titles[key] = summary === undefined
        ? { _tag: "Unknown", reason: "NotLookedUp" }
        : summary === null
        ? { _tag: "Unknown", reason: "NotFound" }
        : { _tag: "Known", summary }
    }
    return titles
  })

const SearchResult = Schema.fromJsonString(Schema.Array(Schema.Struct({
  key: Schema.String,
  fields: Schema.Struct({ summary: Schema.optionalKey(Schema.String) })
})))
const decodeSearch = Schema.decodeUnknownEffect(SearchResult)

/**
 * `acli jira workitem search` for a batch of keys. Keys reach the JQL only after the Booking
 * pattern accepted them, so they cannot carry JQL syntax.
 */
export const acliTicketSearch = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const search: TicketSearch = (keys) =>
    spawner.string(
      ChildProcess.make("acli", [
        "jira",
        "workitem",
        "search",
        "--jql",
        `key in (${keys.join(",")})`,
        "--fields",
        "key,summary",
        "--limit",
        String(keys.length),
        "--json"
      ])
    ).pipe(
      // A hung acli (waiting on a login, a dead network) must not hold up the ingest pass behind it.
      Effect.timeoutOrElse({
        duration: ACLI_TIMEOUT,
        orElse: () => Effect.fail(new TicketLookupFailed({ reason: "acli did not answer within 30 seconds" }))
      }),
      Effect.mapError((error) =>
        error._tag === "TicketLookupFailed" ? error : new TicketLookupFailed({
          reason: error.reason._tag === "NotFound"
            ? "ticket titles need acli, which is not installed"
            : `acli could not run (${error.reason._tag})`
        })
      ),
      Effect.flatMap((output) =>
        decodeSearch(output).pipe(
          Effect.mapError(() => new TicketLookupFailed({ reason: "acli returned an unreadable reply" }))
        )
      ),
      Effect.map((items) => {
        const found = new Map<string, string>()
        for (const item of items) {
          if (item.fields.summary !== undefined) found.set(item.key, item.fields.summary)
        }
        return found
      })
    )
  return search
})
