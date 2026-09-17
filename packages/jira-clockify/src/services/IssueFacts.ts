/**
 * Who an Issue Key belongs to, and what it is called.
 *
 * **Mental model**
 *
 * - **A branch cannot tell authoring from reviewing.** Checking out a colleague's PR puts their
 *   Issue Key on the branch, and branch attribution then offers their ticket as your work. Jira
 *   knows the difference, so ownership is asked of Jira rather than guessed from the transcript.
 * - **One search, not one request per key.** A week of rows on six tickets costs a single
 *   `key in (…)` search, which also returns the titles — an Issue Key alone is not a timesheet
 *   anybody can read six months later.
 * - **Cached to disk, because neither fact moves quickly.** A title almost never changes and an
 *   assignee rarely does, so a week already looked at answers from `~/.jcf/issues.json` and a
 *   Jira outage costs nothing. Entries past {@link OWNERSHIP_TTL_MS} are re-asked.
 * - **Unknown is not "not yours".** Every failure — no login, an unreachable site, an issue in a
 *   project you cannot see — leaves a key with no fact. A caller may hide what Jira says belongs to
 *   someone else; it must never hide what Jira was not asked about, because that would silently drop
 *   hours nobody could then find.
 *
 * @module
 */
import { JiraApiClient } from "@knpkv/jira-api-client"
import { JiraAuth } from "@knpkv/jira-cli/JiraAuth"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { isTicketKey } from "../agent/sessions.js"
import { HomeDirectory } from "./HomeDirectory.js"

/** What Jira says about one Issue Key. */
export interface IssueFact {
  readonly key: string
  /** The issue title, or null when Jira answered without one. */
  readonly title: string | null
  /** Assignee display name, or null when the issue is unassigned. */
  readonly assignee: string | null
  /** True when the issue is assigned to the account this machine is logged in as. */
  readonly mine: boolean
}

/**
 * The answer to one lookup.
 *
 * `checked` says whether Jira was actually reached, so a surface can tell "these are not yours"
 * apart from "nobody could ask" — the second is a warning to show, never a reason to filter.
 */
export interface IssueFactsResult {
  readonly facts: ReadonlyMap<string, IssueFact>
  readonly checked: boolean
}

export interface IssueFactsContract {
  readonly lookup: (keys: ReadonlyArray<string>) => Effect.Effect<IssueFactsResult>
}

export class IssueFacts extends Context.Service<IssueFacts, IssueFactsContract>()("jcf/IssueFacts") {}

/**
 * How long an ownership answer is trusted before it is asked again.
 *
 * Twelve hours, which is a working day: a ticket reassigned this morning is right by tomorrow, and
 * nothing here is load-bearing enough to justify a request per page load. A title is cached under
 * the same clock only because it travels in the same response.
 */
export const OWNERSHIP_TTL_MS = 12 * 60 * 60 * 1000

/** Keys per search. JQL goes in a query string, so a hundred keys at once is a 414 waiting to happen. */
const KEYS_PER_SEARCH = 50

/** One cached fact, with when it was learned. */
export interface CachedFact extends IssueFact {
  readonly checkedAtMs: number
}

/**
 * The cache file's shape.
 *
 * `accountId` is stored beside the facts because `mine` is a claim *about that account*. Logging in
 * as somebody else — a second Atlassian site, a work and a personal account — makes every stored
 * `mine` meaningless rather than merely stale, so the whole file is discarded when it disagrees.
 */
export interface IssueCache {
  readonly accountId: string | null
  readonly issues: ReadonlyMap<string, CachedFact>
}

export const emptyCache: IssueCache = { accountId: null, issues: new Map() }

const CACHE_DIR = ".jcf"
const CACHE_FILE = "issues.json"

const readJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const JsonObject = Schema.Record(Schema.String, Schema.Json)
const isJsonObject = Schema.is(JsonObject)

const nested = (fields: Record<string, Schema.Json>, key: string, field: string): string | null => {
  const value = fields[key]
  if (!isJsonObject(value)) return null
  const inner = value[field]
  return Predicate.isString(inner) ? inner : null
}

/**
 * Shape the issues one search returned into facts, deciding ownership by account id.
 *
 * By account id and never by display name: two people can share a name, a name can be changed, and
 * a display name is absent entirely on a site that hides profiles. `mine` is false for an
 * unassigned issue — nobody owns it, so nothing about it is evidence that you do.
 */
export const factsFromIssues = (
  issues: ReadonlyArray<unknown>,
  myAccountId: string | null
): ReadonlyMap<string, IssueFact> => {
  const facts = new Map<string, IssueFact>()
  for (const issue of issues) {
    if (!isJsonObject(issue)) continue
    const key = issue["key"]
    if (!Predicate.isString(key)) continue
    const rawFields = issue["fields"]
    const fields = isJsonObject(rawFields) ? rawFields : {}
    const title = fields["summary"]
    const accountId = nested(fields, "assignee", "accountId")
    facts.set(key, {
      assignee: nested(fields, "assignee", "displayName"),
      key,
      mine: myAccountId !== null && accountId !== null && accountId === myAccountId,
      title: Predicate.isString(title) ? title : null
    })
  }
  return facts
}

/**
 * Read the cache file, keeping only entries that still parse as facts about `accountId`.
 *
 * Total, including on text that is not JSON at all: a cache is a convenience, so a file somebody
 * hand-edited badly costs one Jira search rather than a failed page load.
 */
export const parseIssueCache = (content: string): IssueCache => {
  const parsed = Option.getOrNull(readJson(content))
  if (!Predicate.isObject(parsed)) return emptyCache
  const accountId = Predicate.isString(parsed.accountId) ? parsed.accountId : null
  const issues = new Map<string, CachedFact>()
  const stored = parsed.issues
  if (Predicate.isObject(stored)) {
    for (const [key, entry] of Object.entries(stored)) {
      if (!isTicketKey(key) || !Predicate.isObject(entry)) continue
      if (!Predicate.isNumber(entry.checkedAtMs) || !Predicate.isBoolean(entry.mine)) continue
      issues.set(key, {
        assignee: Predicate.isString(entry.assignee) ? entry.assignee : null,
        checkedAtMs: entry.checkedAtMs,
        key,
        mine: entry.mine,
        title: Predicate.isString(entry.title) ? entry.title : null
      })
    }
  }
  return { accountId, issues }
}

export const serializeIssueCache = (cache: IssueCache): string =>
  JSON.stringify(
    {
      accountId: cache.accountId,
      issues: Object.fromEntries(
        [...cache.issues.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, fact]) => [key, {
          assignee: fact.assignee,
          checkedAtMs: fact.checkedAtMs,
          mine: fact.mine,
          title: fact.title
        }])
      )
    },
    null,
    2
  )

/** The keys a lookup has to actually ask about: never seen, or seen too long ago. */
export const staleKeys = (options: {
  readonly keys: ReadonlyArray<string>
  readonly cache: IssueCache
  readonly nowMs: number
  readonly ttlMs: number
}): ReadonlyArray<string> =>
  [...new Set(options.keys)]
    .filter(isTicketKey)
    .filter((key) => {
      const cached = options.cache.issues.get(key)
      return cached === undefined || options.nowMs - cached.checkedAtMs >= options.ttlMs
    })
    .sort()

/** Fold fresh answers into the cache, keeping what was not asked about this time. */
export const mergeCache = (options: {
  readonly cache: IssueCache
  readonly fresh: ReadonlyMap<string, IssueFact>
  readonly accountId: string | null
  readonly nowMs: number
}): IssueCache => {
  // A different account makes every stored `mine` a claim about somebody else.
  const kept = options.cache.accountId === options.accountId ? [...options.cache.issues.entries()] : []
  const issues = new Map<string, CachedFact>(kept)
  for (const [key, fact] of options.fresh) issues.set(key, { ...fact, checkedAtMs: options.nowMs })
  return { accountId: options.accountId, issues }
}

/** `key in (A-1, A-2)`, for the keys a search is about. */
export const keyClause = (keys: ReadonlyArray<string>): string => `key in (${keys.join(", ")})`

/** Split keys into searches, so one long week cannot blow the query string. */
const searchBatches = (keys: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => {
  const batches: Array<Array<string>> = []
  for (const key of keys) {
    const last = batches[batches.length - 1]
    if (last === undefined || last.length >= KEYS_PER_SEARCH) batches.push([key])
    else last.push(key)
  }
  return batches
}

export const layer = Layer.effect(
  IssueFacts,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = (yield* HomeDirectory).path
    const jira = yield* JiraApiClient
    const auth = yield* JiraAuth
    const dir = path.join(home, CACHE_DIR)
    const filePath = path.join(dir, CACHE_FILE)

    const readCache: Effect.Effect<IssueCache> = Effect.gen(function*() {
      const exists = yield* fs.exists(filePath)
      if (!exists) return emptyCache
      const content = yield* fs.readFileString(filePath)
      return yield* Effect.try({ catch: () => emptyCache, try: () => parseIssueCache(content) })
    }).pipe(Effect.catch(() => Effect.succeed(emptyCache)))

    const writeCache = (cache: IssueCache) =>
      Effect.gen(function*() {
        const exists = yield* fs.exists(dir)
        if (!exists) yield* fs.makeDirectory(dir, { recursive: true })
        yield* fs.writeFileString(filePath, serializeIssueCache(cache))
      }).pipe(Effect.catch(() => Effect.void))

    /** My own account id, or null when Jira cannot say — in which case nothing is mine. */
    const accountId: Effect.Effect<string | null> = jira.getCurrentUser({}).pipe(
      Effect.map((self) => {
        if (!isJsonObject(self)) return null
        const id = self["accountId"]
        return Predicate.isString(id) ? id : null
      }),
      Effect.catch(() => Effect.succeed(null))
    )

    const search = (keys: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<unknown>, "unavailable"> =>
      jira.searchIssuesUsingJql({
        params: { fields: ["summary", "assignee"], jql: keyClause(keys), maxResults: keys.length }
      }).pipe(
        Effect.map((result) => result.issues ?? []),
        Effect.mapError((): "unavailable" => "unavailable")
      )

    return IssueFacts.of({
      lookup: (keys) =>
        Effect.gen(function*() {
          const wanted = [...new Set(keys)].filter(isTicketKey)
          const cache = yield* readCache
          if (wanted.length === 0) return { checked: true, facts: new Map<string, IssueFact>() }

          const factsOf = (from: IssueCache): ReadonlyMap<string, IssueFact> =>
            new Map(
              wanted.flatMap((key) => {
                const cached = from.issues.get(key)
                return cached === undefined ? [] : [
                  [key, {
                    assignee: cached.assignee,
                    key,
                    mine: cached.mine,
                    title: cached.title
                  }] satisfies readonly [string, IssueFact]
                ]
              })
            )

          const nowMs = yield* Clock.currentTimeMillis
          const stale = staleKeys({ cache, keys: wanted, nowMs, ttlMs: OWNERSHIP_TTL_MS })
          if (stale.length === 0) return { checked: true, facts: factsOf(cache) }

          // A logged-out Jira resolves an empty cloudId into a URL Atlassian answers with a 404,
          // which would otherwise look exactly like "none of these issues exist" — and mark every
          // ticket as somebody else's.
          const loggedIn = yield* auth.isLoggedIn().pipe(Effect.catch(() => Effect.succeed(false)))
          if (!loggedIn) return { checked: false, facts: factsOf(cache) }

          const mine = yield* accountId
          const batches = yield* Effect.all(searchBatches(stale).map(search), { concurrency: 2 }).pipe(
            Effect.map((results) => results.flat()),
            Effect.catch(() => Effect.succeed(null))
          )
          // Jira refused. What is cached still stands; what is not stays unknown.
          if (batches === null) return { checked: false, facts: factsOf(cache) }

          const fresh = factsFromIssues(batches, mine)
          // A key asked about and not returned — deleted, or in a project this account cannot see —
          // gets no entry at all. It stays unknown, so it is re-asked next time and never filtered:
          // recording it as somebody else's is the one mistake that would hide real hours.
          const updated = mergeCache({ accountId: mine, cache, fresh, nowMs })
          yield* writeCache(updated)
          return { checked: true, facts: factsOf(updated) }
        })
    })
  })
)
