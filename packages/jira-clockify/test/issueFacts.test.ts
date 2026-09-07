/**
 * Who a ticket belongs to, and what it is called.
 *
 * The rule these exist to pin: Jira saying an issue is somebody else's is a fact a caller may act
 * on, and Jira not being asked is not. Every failure mode here has to come back as "unknown" rather
 * than as "not yours", because the second one hides hours that really happened.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  emptyCache,
  factsFromIssues,
  type IssueCache,
  IssueFacts,
  keyClause,
  mergeCache,
  parseIssueCache,
  serializeIssueCache,
  staleKeys
} from "../src/services/IssueFacts.js"
import { FAKE_ACCOUNT_ID, makeFakeHeadless } from "../src/testing/fakeHeadless.js"

// Each case composes exactly the layer it needs and provides it at its own entry point.
// @effect-diagnostics strictEffectProvide:off

const issue = (key: string, summary: string, assignee?: string) => ({
  fields: {
    summary,
    ...(assignee === undefined ? {} : { assignee: { accountId: assignee, displayName: assignee } })
  },
  id: "1",
  key
})

describe("factsFromIssues", () => {
  it("owns an issue assigned to my account id", () => {
    const facts = factsFromIssues([issue("PROJ-1", "Retry wrapper", FAKE_ACCOUNT_ID)], FAKE_ACCOUNT_ID)
    expect(facts.get("PROJ-1")).toEqual({
      assignee: FAKE_ACCOUNT_ID,
      key: "PROJ-1",
      mine: true,
      title: "Retry wrapper"
    })
  })

  // The case the whole feature is for: a branch checked out to review somebody's pull request.
  it("does not own an issue assigned to somebody else", () => {
    const facts = factsFromIssues([issue("PROJ-2", "Their work", "acct-them")], FAKE_ACCOUNT_ID)
    expect(facts.get("PROJ-2")?.mine).toBe(false)
    // The title still comes back: a row that is not proposable is still a row someone has to read.
    expect(facts.get("PROJ-2")?.title).toBe("Their work")
  })

  it("owns nothing when nobody is assigned, or when my own account is unknown", () => {
    expect(factsFromIssues([issue("PROJ-3", "Nobody's")], FAKE_ACCOUNT_ID).get("PROJ-3")?.mine).toBe(false)
    expect(factsFromIssues([issue("PROJ-4", "Mine?", FAKE_ACCOUNT_ID)], null).get("PROJ-4")?.mine).toBe(false)
  })

  it("keeps a key whose fields Jira left out, with no title", () => {
    const facts = factsFromIssues([{ id: "1", key: "PROJ-5" }], FAKE_ACCOUNT_ID)
    expect(facts.get("PROJ-5")).toEqual({ assignee: null, key: "PROJ-5", mine: false, title: null })
  })
})

describe("the cache", () => {
  const cached = (key: string, checkedAtMs: number) =>
    ({ assignee: null, checkedAtMs, key, mine: true, title: "Cached" }) as const

  it("asks only about keys it has never seen or saw too long ago", () => {
    const cache: IssueCache = { accountId: FAKE_ACCOUNT_ID, issues: new Map([["PROJ-1", cached("PROJ-1", 1_000)]]) }
    expect(staleKeys({ cache, keys: ["PROJ-1", "PROJ-2"], nowMs: 2_000, ttlMs: 5_000 })).toEqual(["PROJ-2"])
    expect(staleKeys({ cache, keys: ["PROJ-1"], nowMs: 9_000, ttlMs: 5_000 })).toEqual(["PROJ-1"])
    // Not an Issue Key, so not something to ask Jira about.
    expect(staleKeys({ cache, keys: ["not-a-key"], nowMs: 2_000, ttlMs: 5_000 })).toEqual([])
  })

  // `mine` is a claim about one account. Logging in as somebody else does not make it stale, it
  // makes it about the wrong person.
  it("discards everything it knew when the account changes", () => {
    const cache: IssueCache = { accountId: "acct-them", issues: new Map([["PROJ-1", cached("PROJ-1", 1_000)]]) }
    const merged = mergeCache({ accountId: FAKE_ACCOUNT_ID, cache, fresh: new Map(), nowMs: 2_000 })
    expect(merged.issues.size).toBe(0)

    const kept = mergeCache({ accountId: "acct-them", cache, fresh: new Map(), nowMs: 2_000 })
    expect(kept.issues.get("PROJ-1")?.checkedAtMs).toBe(1_000)
  })

  it("survives a round trip through the file, and ignores a corrupt entry", () => {
    const cache = mergeCache({
      accountId: FAKE_ACCOUNT_ID,
      cache: emptyCache,
      fresh: factsFromIssues([issue("PROJ-1", "Retry wrapper", FAKE_ACCOUNT_ID)], FAKE_ACCOUNT_ID),
      nowMs: 7_000
    })
    const read = parseIssueCache(serializeIssueCache(cache))
    expect(read).toEqual(cache)
    expect(parseIssueCache("{\"accountId\":\"a\",\"issues\":{\"PROJ-1\":{\"title\":\"x\"}}}").issues.size).toBe(0)
    expect(parseIssueCache("not json at all{").issues.size).toBe(0)
  })

  it("names the keys a search is about", () => {
    expect(keyClause(["PROJ-1", "PROJ-2"])).toBe("key in (PROJ-1, PROJ-2)")
  })
})

describe("IssueFacts.lookup", () => {
  it.effect("answers with titles and ownership, in one search", () =>
    Effect.gen(function*() {
      const facts = yield* IssueFacts
      const answer = yield* facts.lookup(["PROJ-1", "PROJ-2"])
      expect(answer.checked).toBe(true)
      expect(answer.facts.get("PROJ-1")).toMatchObject({ mine: true, title: "Mine to do" })
      expect(answer.facts.get("PROJ-2")).toMatchObject({ mine: false, title: "Theirs, reviewed by me" })
    }).pipe(Effect.provide(
      makeFakeHeadless({
        issueAssignees: { "PROJ-1": FAKE_ACCOUNT_ID, "PROJ-2": "acct-them" },
        issueSummaries: { "PROJ-1": "Mine to do", "PROJ-2": "Theirs, reviewed by me" }
      }).layer
    )))

  // A key Jira does not answer about — deleted, or in a project this account cannot see — must not
  // come back as somebody else's, or its hours vanish from the week with nothing to explain them.
  it.effect("leaves a key Jira never mentioned unknown", () =>
    Effect.gen(function*() {
      const facts = yield* IssueFacts
      const answer = yield* facts.lookup(["PROJ-1", "GONE-9"])
      expect(answer.checked).toBe(true)
      expect(answer.facts.has("GONE-9")).toBe(false)
    }).pipe(Effect.provide(
      makeFakeHeadless({
        issueAssignees: { "PROJ-1": FAKE_ACCOUNT_ID },
        issueSummaries: { "PROJ-1": "Mine to do" }
      }).layer
    )))

  it.effect("says it could not check when Jira is not logged in", () =>
    Effect.gen(function*() {
      const facts = yield* IssueFacts
      const answer = yield* facts.lookup(["PROJ-1"])
      expect(answer.checked).toBe(false)
      expect(answer.facts.size).toBe(0)
    }).pipe(Effect.provide(
      makeFakeHeadless({
        issueSummaries: { "PROJ-1": "Mine to do" },
        jiraLoggedIn: false
      }).layer
    )))

  it.effect("asks nothing at all for no keys", () =>
    Effect.gen(function*() {
      const facts = yield* IssueFacts
      expect((yield* facts.lookup([])).facts.size).toBe(0)
    }).pipe(Effect.provide(makeFakeHeadless({}).layer)))
})
