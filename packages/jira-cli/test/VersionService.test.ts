import { describe, expect, it } from "@effect/vitest"
import { JiraApiClient, make } from "@knpkv/jira-api-client"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { stripEmails } from "../src/commands/version.js"
import type { Version } from "../src/VersionService.js"
import {
  extractContributorIds,
  layer as VersionServiceLayer,
  personFromObject,
  renderCustomFieldValue,
  toRelatedWork,
  VersionService
} from "../src/VersionService.js"

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("renderCustomFieldValue", () => {
  it("returns null for null/undefined/empty string", () => {
    expect(renderCustomFieldValue(null)).toBeNull()
    expect(renderCustomFieldValue(undefined)).toBeNull()
    expect(renderCustomFieldValue("")).toBeNull()
  })

  it("returns plain strings and coerces numbers/booleans", () => {
    expect(renderCustomFieldValue("hello")).toBe("hello")
    expect(renderCustomFieldValue(42)).toBe("42")
    expect(renderCustomFieldValue(true)).toBe("true")
  })

  it("renders cascading select as 'Parent > Child'", () => {
    expect(renderCustomFieldValue({ value: "High", child: { value: "Confidential" } })).toBe(
      "High > Confidential"
    )
  })

  it("renders a single select / option as its value", () => {
    expect(renderCustomFieldValue({ value: "High" })).toBe("High")
  })

  it("renders a user object as its display name", () => {
    expect(renderCustomFieldValue({ displayName: "Jane Doe" })).toBe("Jane Doe")
  })

  it("falls back to name when no value/displayName", () => {
    expect(renderCustomFieldValue({ name: "Backend" })).toBe("Backend")
  })

  it("joins arrays with ', ' and drops empties", () => {
    expect(renderCustomFieldValue([{ value: "A" }, { value: "B" }])).toBe("A, B")
    expect(renderCustomFieldValue([])).toBeNull()
    expect(renderCustomFieldValue([null, ""])).toBeNull()
  })

  it("returns null for an unknown object shape", () => {
    expect(renderCustomFieldValue({ foo: "bar" })).toBeNull()
  })
})

describe("personFromObject", () => {
  it("builds a Person from an object with accountId", () => {
    expect(personFromObject({ accountId: "abc", displayName: "Jane", emailAddress: "jane@example.com" })).toEqual({
      accountId: "abc",
      displayName: "Jane",
      emailAddress: "jane@example.com"
    })
  })

  it("falls back displayName to accountId and email to null", () => {
    expect(personFromObject({ accountId: "abc" })).toEqual({
      accountId: "abc",
      displayName: "abc",
      emailAddress: null
    })
  })

  it("uses fallbackId when the object has no accountId", () => {
    expect(personFromObject({ displayName: "Jane" }, "fid")).toEqual({
      accountId: "fid",
      displayName: "Jane",
      emailAddress: null
    })
  })

  it("treats a bare string as an accountId", () => {
    expect(personFromObject("abc")).toEqual({ accountId: "abc", displayName: "abc", emailAddress: null })
  })

  it("returns null with neither accountId nor fallback", () => {
    expect(personFromObject({ displayName: "Jane" })).toBeNull()
    expect(personFromObject(null)).toBeNull()
    expect(personFromObject("")).toBeNull()
  })
})

describe("extractContributorIds", () => {
  it("returns [] when contributors is missing or not an array", () => {
    expect(extractContributorIds({})).toEqual([])
    expect(extractContributorIds({ contributors: "nope" })).toEqual([])
  })

  it("extracts ids from strings and objects, skipping empties", () => {
    expect(
      extractContributorIds({
        contributors: ["a", { accountId: "b" }, { accountId: "" }, {}, ""]
      })
    ).toEqual(["a", "b"])
  })
})

describe("toRelatedWork", () => {
  it("normalises a related-work entry", () => {
    expect(
      toRelatedWork({
        relatedWorkId: "rw-1",
        title: "Release notes",
        category: "Communication",
        url: "https://example.com"
      })
    ).toEqual({
      relatedWorkId: "rw-1",
      title: "Release notes",
      category: "Communication",
      url: "https://example.com"
    })
  })

  it("defaults category to empty string and missing fields to null", () => {
    expect(toRelatedWork({})).toEqual({
      relatedWorkId: null,
      title: null,
      category: "",
      url: null
    })
  })
})

describe("stripEmails", () => {
  const versionWithEmails: Version = {
    id: "10",
    name: "1.0.0",
    description: null,
    released: true,
    archived: false,
    startDate: null,
    releaseDate: "2026-01-01",
    driver: { accountId: "d", displayName: "Dana", emailAddress: "dana@example.com" },
    contributors: [
      { accountId: "c1", displayName: "Cara", emailAddress: "cara@example.com" },
      { accountId: "c2", displayName: "Cliff", emailAddress: "cliff@example.com" }
    ],
    approvers: [
      {
        person: { accountId: "a1", displayName: "Amy", emailAddress: "amy@example.com" },
        status: "APPROVED",
        declineReason: null,
        description: null
      }
    ],
    tickets: [
      {
        key: "PROJ-1",
        summary: "Do thing",
        assignee: { accountId: "t1", displayName: "Tom", emailAddress: "tom@example.com" },
        labels: [],
        customFields: {}
      },
      { key: "PROJ-2", summary: null, assignee: null, labels: [], customFields: {} }
    ],
    url: "https://x/version/10"
  }

  it("nulls every Person.emailAddress across driver, contributors, approvers and assignees", () => {
    const stripped = stripEmails(versionWithEmails)
    expect(stripped.driver?.emailAddress).toBeNull()
    expect(stripped.contributors.map((c) => c.emailAddress)).toEqual([null, null])
    expect(stripped.approvers.map((a) => a.person.emailAddress)).toEqual([null])
    expect(stripped.tickets.map((t) => t.assignee?.emailAddress ?? null)).toEqual([null, null])
  })

  it("preserves non-email fields and overall shape", () => {
    const stripped = stripEmails(versionWithEmails)
    expect(stripped.driver?.displayName).toBe("Dana")
    expect(stripped.contributors.map((c) => c.accountId)).toEqual(["c1", "c2"])
    expect(stripped.approvers[0].status).toBe("APPROVED")
    expect(stripped.tickets.map((t) => t.key)).toEqual(["PROJ-1", "PROJ-2"])
  })

  it("leaves emails intact when callers keep the original (opt-in path)", () => {
    // The command emits the unmodified version when --emails is set; assert the
    // original is untouched (stripEmails returns a copy, never mutating input).
    expect(versionWithEmails.driver?.emailAddress).toBe("dana@example.com")
    expect(versionWithEmails.tickets[0].assignee?.emailAddress).toBe("tom@example.com")
  })

  it("handles a null driver and null assignees without throwing", () => {
    const stripped = stripEmails({ ...versionWithEmails, driver: null })
    expect(stripped.driver).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// released / unreleased + cap filtering (via a stubbed client)
// ---------------------------------------------------------------------------

const versionsFixture = [
  {
    id: "1",
    name: "1.0.0",
    released: true,
    self: "https://x/version/1",
    contributors: ["account-1", { accountId: "account-2", displayName: "Ada" }]
  },
  { id: "2", name: "2.0.0", released: false, self: "https://x/version/2" },
  { id: "3", name: "3.0.0", released: true, self: "https://x/version/3" },
  { id: "4", name: "4.0.0", released: false, self: "https://x/version/4" }
]

/**
 * Build a JiraApiClient mock whose HTTP transport routes by path: the version
 * list endpoint returns the fixture; the JQL search endpoint returns no issues
 * (so the contributor scan resolves to empty without further calls).
 */
const makeJiraLayer = () => {
  const httpClient = HttpClient.make((request) => {
    const body = request.url.includes("/project/PROJ/version")
      ? { values: versionsFixture, isLast: true }
      : { issues: [], isLast: true }
    return Effect.succeed(HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    ))
  })
  const api = make(httpClient, {
    baseUrl: "https://jira.test",
    auth: { type: "basic", email: "test@example.com", apiToken: Redacted.make("token") }
  })
  return Layer.succeed(
    JiraApiClient,
    JiraApiClient.of({
      ...api,
      uploadAttachment: () => Effect.die("unused Jira upload mock")
    })
  )
}

describe("listProjectVersions filtering", () => {
  it.effect("returns all versions when neither flag is set", () =>
    Effect.gen(function*() {
      const service = yield* VersionService
      const list = yield* service.listProjectVersions("PROJ")
      expect(list.map((v) => v.id)).toEqual(["1", "2", "3", "4"])
    }).pipe(Effect.provide(VersionServiceLayer), Effect.provide(makeJiraLayer())))

  it.effect("keeps only released versions when released=true", () =>
    Effect.gen(function*() {
      const service = yield* VersionService
      const list = yield* service.listProjectVersions("PROJ", { released: true })
      expect(list.map((v) => v.id)).toEqual(["1", "3"])
    }).pipe(Effect.provide(VersionServiceLayer), Effect.provide(makeJiraLayer())))

  it.effect("keeps only unreleased versions when unreleased=true", () =>
    Effect.gen(function*() {
      const service = yield* VersionService
      const list = yield* service.listProjectVersions("PROJ", { unreleased: true })
      expect(list.map((v) => v.id)).toEqual(["2", "4"])
    }).pipe(Effect.provide(VersionServiceLayer), Effect.provide(makeJiraLayer())))

  it.effect("caps the result count at maxResults", () =>
    Effect.gen(function*() {
      const service = yield* VersionService
      const list = yield* service.listProjectVersions("PROJ", { maxResults: 2 })
      expect(list.map((v) => v.id)).toEqual(["1", "2"])
    }).pipe(Effect.provide(VersionServiceLayer), Effect.provide(makeJiraLayer())))

  it.effect("preserves Jira Premium contributors decoded from the generated Version schema", () =>
    Effect.gen(function*() {
      const service = yield* VersionService
      const list = yield* service.listProjectVersions("PROJ", { maxResults: 1 })
      expect(list[0]?.contributors.map((person) => person.accountId)).toEqual(["account-1", "account-2"])
    }).pipe(Effect.provide(VersionServiceLayer), Effect.provide(makeJiraLayer())))
})
