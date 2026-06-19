import { describe, expect, it } from "@effect/vitest"
import { JiraApiClient } from "@knpkv/jira-api-client"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
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

// ---------------------------------------------------------------------------
// released / unreleased + cap filtering (via a stubbed client)
// ---------------------------------------------------------------------------

const versionsFixture = [
  { id: "1", name: "1.0.0", released: true, self: "https://x/version/1" },
  { id: "2", name: "2.0.0", released: false, self: "https://x/version/2" },
  { id: "3", name: "3.0.0", released: true, self: "https://x/version/3" },
  { id: "4", name: "4.0.0", released: false, self: "https://x/version/4" }
]

/**
 * Build a JiraApiClient mock whose `v3.client.GET` routes by path: the version
 * list endpoint returns the fixture; the JQL search endpoint returns no issues
 * (so the contributor scan resolves to empty without further calls).
 */
const makeJiraLayer = () =>
  Layer.succeed(JiraApiClient, {
    v3: {
      client: {
        GET: (path: string) =>
          path === "/rest/api/3/project/{projectIdOrKey}/version"
            ? Promise.resolve({
              data: { values: versionsFixture, isLast: true },
              response: { ok: true, status: 200 }
            })
            : Promise.resolve({
              data: { issues: [], isLast: true },
              response: { ok: true, status: 200 }
            })
      }
    }
  } as never)

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
})
