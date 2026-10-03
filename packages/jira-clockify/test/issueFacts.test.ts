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
  type CachedFact,
  emptyCache,
  factsFromIssues,
  isOwnedByMe,
  type IssueCache,
  IssueFacts,
  keyClause,
  mergeCache,
  OWNERSHIP_TTL_MS,
  parseIssueCache,
  serializeIssueCache,
  staleKeys
} from "../src/services/IssueFacts.js"
import { FAKE_ACCOUNT_ID, FAKE_HOME, makeFakeHeadless } from "../src/testing/fakeHeadless.js"

// Each case composes exactly the layer it needs and provides it at its own entry point.
// @effect-diagnostics strictEffectProvide:off

const issue = (key: string, summary: string, assignee?: string | null) => ({
  fields: assignee === undefined
    ? { summary }
    : { summary, assignee: assignee === null ? null : { accountId: assignee, displayName: assignee } },
  id: "1",
  key
})

describe("factsFromIssues", () => {
  it("owns an issue assigned to my account id", () => {
    const facts = factsFromIssues([issue("PROJ-1", "Retry wrapper", FAKE_ACCOUNT_ID)], FAKE_ACCOUNT_ID)
    expect(facts.get("PROJ-1")).toEqual({
      assignee: FAKE_ACCOUNT_ID,
      assignment: "mine",
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

  it("keeps known other ownership when Jira hides the display name", () => {
    const facts = factsFromIssues([{
      fields: { assignee: { accountId: "acct-them" }, summary: "Their work" },
      key: "PROJ-7"
    }], FAKE_ACCOUNT_ID)
    expect(facts.get("PROJ-7")).toMatchObject({
      assignee: null,
      assignment: "other-assignee",
      mine: false
    })
  })

  it("knows an explicit unassigned issue is not mine but keeps an unknown account unknown", () => {
    expect(factsFromIssues([issue("PROJ-3", "Nobody's", null)], FAKE_ACCOUNT_ID).get("PROJ-3"))
      .toMatchObject({ assignment: "unassigned", mine: false })
    expect(factsFromIssues([issue("PROJ-4", "Mine?", FAKE_ACCOUNT_ID)], null).get("PROJ-4")?.mine).toBeNull()
  })

  it("keeps omitted or incomplete assignee data unknown and eligible", () => {
    const facts = factsFromIssues([
      { id: "1", key: "PROJ-5" },
      { fields: { assignee: { displayName: "Hidden account" }, summary: "Visible title" }, key: "PROJ-6" }
    ], FAKE_ACCOUNT_ID)
    expect(facts.get("PROJ-5")).toEqual({
      assignee: null,
      assignment: "unknown",
      key: "PROJ-5",
      mine: null,
      title: null
    })
    expect(facts.get("PROJ-6")).toEqual({
      assignee: "Hidden account",
      assignment: "unknown",
      key: "PROJ-6",
      mine: null,
      title: "Visible title"
    })
    for (const key of ["PROJ-5", "PROJ-6"]) {
      expect(isOwnedByMe(key, { facts, mode: "assigned", overrides: [] })).toBe(true)
    }
  })
})

describe("the cache", () => {
  const cached = (key: string, checkedAtMs: number): CachedFact => ({
    assignee: null,
    assignment: "mine",
    checkedAtMs,
    key,
    mine: true,
    title: "Cached"
  })

  it("asks only about keys it has never seen or saw too long ago", () => {
    const cache: IssueCache = {
      accountId: FAKE_ACCOUNT_ID,
      cloudId: "cloud-fake",
      issues: new Map([["PROJ-1", cached("PROJ-1", 1_000)]])
    }
    expect(staleKeys({ cache, keys: ["PROJ-1", "PROJ-2"], nowMs: 2_000, ttlMs: 5_000 })).toEqual(["PROJ-2"])
    expect(staleKeys({ cache, keys: ["PROJ-1"], nowMs: 9_000, ttlMs: 5_000 })).toEqual(["PROJ-1"])
    // Not an Issue Key, so not something to ask Jira about.
    expect(staleKeys({ cache, keys: ["not-a-key"], nowMs: 2_000, ttlMs: 5_000 })).toEqual([])
  })

  // `mine` is a claim about one account. Logging in as somebody else does not make it stale, it
  // makes it about the wrong person.
  it("discards everything it knew when the account changes", () => {
    const cache: IssueCache = {
      accountId: "acct-them",
      cloudId: "cloud-fake",
      issues: new Map([["PROJ-1", cached("PROJ-1", 1_000)]])
    }
    const merged = mergeCache({
      accountId: FAKE_ACCOUNT_ID,
      cloudId: "cloud-fake",
      queriedKeys: [],
      cache,
      fresh: new Map(),
      nowMs: 2_000
    })
    expect(merged.issues.size).toBe(0)

    const kept = mergeCache({
      accountId: "acct-them",
      cloudId: "cloud-fake",
      queriedKeys: [],
      cache,
      fresh: new Map(),
      nowMs: 2_000
    })
    expect(kept.issues.get("PROJ-1")?.checkedAtMs).toBe(1_000)
  })

  it("removes a queried stale fact that a successful search no longer returns", () => {
    const cache: IssueCache = {
      accountId: FAKE_ACCOUNT_ID,
      cloudId: "cloud-fake",
      issues: new Map([
        ["PROJ-1", cached("PROJ-1", 1_000)],
        ["PROJ-2", cached("PROJ-2", 1_000)]
      ])
    }
    const merged = mergeCache({
      accountId: FAKE_ACCOUNT_ID,
      cloudId: "cloud-fake",
      queriedKeys: ["PROJ-1"],
      cache,
      fresh: new Map(),
      nowMs: 2_000
    })
    expect(merged.issues.has("PROJ-1")).toBe(false)
    expect(merged.issues.has("PROJ-2")).toBe(true)
  })

  it("survives a round trip through the file, and ignores a corrupt entry", () => {
    const cache = mergeCache({
      accountId: FAKE_ACCOUNT_ID,
      cloudId: "cloud-fake",
      queriedKeys: ["PROJ-1", "PROJ-7"],
      cache: emptyCache,
      fresh: factsFromIssues([
        issue("PROJ-1", "Retry wrapper", FAKE_ACCOUNT_ID),
        { fields: { assignee: { accountId: "acct-them" }, summary: "Their work" }, key: "PROJ-7" }
      ], FAKE_ACCOUNT_ID),
      nowMs: 7_000
    })
    const serialized = serializeIssueCache(cache)
    const read = parseIssueCache(serialized)
    expect(read).toEqual(cache)
    expect(read.issues.get("PROJ-7")?.assignment).toBe("other-assignee")
    expect(serialized).not.toContain("acct-them")
    expect(parseIssueCache("{\"accountId\":\"a\",\"issues\":{\"PROJ-1\":{\"title\":\"x\"}}}").issues.size).toBe(0)
    expect(parseIssueCache("not json at all{").issues.size).toBe(0)
  })

  it("refreshes legacy facts that cannot distinguish hidden names from no assignee", () => {
    const legacy = JSON.stringify({
      accountId: FAKE_ACCOUNT_ID,
      cloudId: "cloud-fake",
      issues: {
        "PROJ-7": {
          assignee: null,
          checkedAtMs: Number.MAX_SAFE_INTEGER,
          mine: false,
          title: "Their work"
        }
      }
    })
    const cache = parseIssueCache(legacy)
    expect(staleKeys({ cache, keys: ["PROJ-7"], nowMs: 7_000, ttlMs: OWNERSHIP_TTL_MS })).toEqual(["PROJ-7"])
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

  it.effect("caches omitted assignee data as unknown without withholding the ticket", () => {
    const fake = makeFakeHeadless({ issueSummaries: { "PROJ-5": "Visible title" } })
    return Effect.gen(function*() {
      const service = yield* IssueFacts
      const first = yield* service.lookup(["PROJ-5"])
      expect(first.facts.get("PROJ-5")?.mine).toBeNull()
      expect(isOwnedByMe("PROJ-5", {
        facts: first.facts,
        mode: "assigned",
        overrides: []
      })).toBe(true)

      const cached = parseIssueCache(fake.world.writtenFiles[`${FAKE_HOME}/.jcf/issues.json`] ?? "")
      expect(cached.issues.get("PROJ-5")?.mine).toBeNull()
      expect((yield* service.lookup(["PROJ-5"])).facts.get("PROJ-5")?.mine).toBeNull()
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("keeps explicit unassigned and different-account issues known not-owned", () =>
    Effect.gen(function*() {
      const service = yield* IssueFacts
      const answer = yield* service.lookup(["PROJ-3", "PROJ-4"])
      expect(answer.facts.get("PROJ-3")?.mine).toBe(false)
      expect(answer.facts.get("PROJ-4")?.mine).toBe(false)
      for (const key of ["PROJ-3", "PROJ-4"]) {
        expect(isOwnedByMe(key, { facts: answer.facts, mode: "assigned", overrides: [] })).toBe(false)
      }
    }).pipe(Effect.provide(
      makeFakeHeadless({
        issueAssignees: { "PROJ-3": null, "PROJ-4": "acct-them" },
        issueSummaries: { "PROJ-3": "Nobody's", "PROJ-4": "Theirs" }
      }).layer
    )))

  it.effect("replaces an ambiguous legacy cache fact with Jira's current assignment", () => {
    const fake = makeFakeHeadless({
      issueAssignees: { "PROJ-7": "acct-them" },
      issueAssigneeDisplayNames: { "PROJ-7": null },
      issueSummaries: { "PROJ-7": "Their work" }
    })
    fake.world.writtenFiles[`${FAKE_HOME}/.jcf/issues.json`] = JSON.stringify({
      accountId: FAKE_ACCOUNT_ID,
      cloudId: "cloud-fake",
      issues: {
        "PROJ-7": {
          assignee: null,
          checkedAtMs: Number.MAX_SAFE_INTEGER,
          mine: false,
          title: "Old title"
        }
      }
    })
    return Effect.gen(function*() {
      const service = yield* IssueFacts
      const answer = yield* service.lookup(["PROJ-7"])
      expect(answer.facts.get("PROJ-7")).toMatchObject({
        assignee: null,
        assignment: "other-assignee",
        mine: false,
        title: "Their work"
      })
      const persisted = parseIssueCache(fake.world.writtenFiles[`${FAKE_HOME}/.jcf/issues.json`] ?? "")
      expect(persisted.issues.get("PROJ-7")?.assignment).toBe("other-assignee")
    }).pipe(Effect.provide(fake.layer))
  })

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

  it.effect("does not turn a failed current-user lookup into not-mine facts", () =>
    Effect.gen(function*() {
      const facts = yield* IssueFacts
      const answer = yield* facts.lookup(["PROJ-1"])
      expect(answer).toEqual({ checked: false, facts: new Map() })
    }).pipe(Effect.provide(
      makeFakeHeadless({
        issueAssignees: { "PROJ-1": FAKE_ACCOUNT_ID },
        issueSummaries: { "PROJ-1": "Mine to do" },
        jiraCurrentUserFails: true
      }).layer
    )))

  it.effect("ignores a fresh cache from another Jira site with the same account", () => {
    const fake = makeFakeHeadless({
      issueAssignees: { "PROJ-1": FAKE_ACCOUNT_ID },
      issueSummaries: { "PROJ-1": "Fresh answer" }
    })
    fake.world.writtenFiles["/fake-home/.jcf/issues.json"] = serializeIssueCache({
      accountId: FAKE_ACCOUNT_ID,
      cloudId: "cloud-other",
      issues: new Map([["PROJ-1", {
        assignee: FAKE_ACCOUNT_ID,
        assignment: "mine",
        checkedAtMs: Number.MAX_SAFE_INTEGER,
        key: "PROJ-1",
        mine: true,
        title: "Wrong account"
      }]])
    })
    return Effect.gen(function*() {
      const facts = yield* IssueFacts
      const answer = yield* facts.lookup(["PROJ-1"])
      expect(answer.checked).toBe(true)
      expect(answer.facts.get("PROJ-1")).toMatchObject({ mine: true, title: "Fresh answer" })
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("asks nothing at all for no keys", () =>
    Effect.gen(function*() {
      const facts = yield* IssueFacts
      expect((yield* facts.lookup([])).facts.size).toBe(0)
    }).pipe(Effect.provide(makeFakeHeadless({}).layer)))
})
