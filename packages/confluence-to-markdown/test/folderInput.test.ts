import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { folderIdFromUrl, parentIdFromInput, resolveFolderTarget, resolveParentId } from "../src/commands/folder.js"

describe("folderIdFromUrl", () => {
  // The URL bar is where a folder id actually comes from: it appears in no
  // page's front-matter, and the page endpoints 404 on it.
  it("reads the id from a folder URL", () => {
    expect(folderIdFromUrl("https://example.atlassian.net/wiki/spaces/PROJ/folder/2964717585/OOB+99"))
      .toBe("2964717585")
  })

  it("reads the id when the URL has no trailing slug", () => {
    expect(folderIdFromUrl("https://example.atlassian.net/wiki/spaces/PROJ/folder/2964717585"))
      .toBe("2964717585")
  })

  it.each([
    "https://example.atlassian.net/wiki/spaces/PROJ/folder/2964717585?focus=1",
    "https://example.atlassian.net/wiki/spaces/PROJ/folder/2964717585#section"
  ])("reads the id past a query or fragment: %s", (url) => {
    expect(folderIdFromUrl(url)).toBe("2964717585")
  })

  // A page URL must not be mistaken for a folder — the ids are not
  // interchangeable and the endpoints do not overlap.
  it.each([
    "https://example.atlassian.net/wiki/spaces/PROJ/pages/2964389908/Release+Notes",
    "https://example.atlassian.net/wiki/spaces/PROJ/folder/not-a-number/Thing",
    "2964717585"
  ])("returns undefined when there is no folder segment: %s", (input) => {
    expect(folderIdFromUrl(input)).toBeUndefined()
  })
})

describe("resolveParentId", () => {
  const run = (parent: string, baseUrl: string) => Effect.result(resolveParentId(parent, baseUrl))

  // Content ids are per-site: applying site A's parent id against site B nests
  // the new folder under whatever that number happens to name on B.
  it.effect("refuses a parent URL from a different site than the create target", () =>
    Effect.gen(function*() {
      const result = yield* run(
        "https://a.atlassian.net/wiki/spaces/PROJ/pages/12345/Release",
        "https://b.atlassian.net"
      )
      expect(result._tag).toBe("Failure")
    }))

  it.effect("accepts a parent URL from the target site, including a /wiki base URL", () =>
    Effect.gen(function*() {
      const result = yield* run(
        "https://example.atlassian.net/wiki/spaces/PROJ/pages/12345/Release",
        "https://example.atlassian.net/wiki"
      )
      expect(result).toMatchObject({ _tag: "Success", success: "12345" })
    }))

  it.effect("accepts a bare numeric id against any site", () =>
    Effect.gen(function*() {
      const result = yield* run("12345", "https://example.atlassian.net")
      expect(result).toMatchObject({ _tag: "Success", success: "12345" })
    }))

  // The id patterns match on the path alone, so a scheme-less paste still yields
  // an id while naming no parseable site. Skipping the origin check there would
  // let the guard pass on exactly the input it exists to catch.
  it.effect("refuses a URL-shaped parent with no scheme rather than skipping the site check", () =>
    Effect.gen(function*() {
      const result = yield* run(
        "example.atlassian.net/wiki/spaces/PROJ/pages/12345/Release",
        "https://other.atlassian.net"
      )
      expect(result._tag).toBe("Failure")
    }))
})

describe("parentIdFromInput", () => {
  // `--parent` documents a page *or* a folder, and both are pasted as URLs.
  it.each([
    ["https://example.atlassian.net/wiki/spaces/PROJ/pages/12345/Release", "12345"],
    ["https://example.atlassian.net/wiki/spaces/PROJ/folder/67890/OOB+99", "67890"],
    ["12345", "12345"]
  ])("reads the container id from %s", (input, expected) => {
    expect(parentIdFromInput(input)).toBe(expected)
  })

  // Anything else would be forwarded verbatim as `parentId` and come back as an
  // opaque 400.
  it.each([
    "https://example.atlassian.net/wiki/spaces/PROJ/overview",
    "PROJ",
    ""
  ])("returns undefined for %s", (input) => {
    expect(parentIdFromInput(input)).toBeUndefined()
  })
})

describe("resolveFolderTarget", () => {
  const run = (folderId: string | undefined, url: string | undefined, baseUrl: string | undefined) =>
    Effect.result(resolveFolderTarget(
      Option.fromUndefinedOr(folderId),
      Option.fromUndefinedOr(url),
      Option.fromUndefinedOr(baseUrl)
    ))

  it.effect("takes the site from the URL, so --base-url is not needed", () =>
    Effect.gen(function*() {
      const result = yield* run(
        undefined,
        "https://example.atlassian.net/wiki/spaces/PROJ/folder/2964717585/OOB+99",
        undefined
      )
      expect(result).toMatchObject({
        _tag: "Success",
        success: { baseUrl: "https://example.atlassian.net", id: "2964717585" }
      })
    }))

  it.effect("requires --base-url alongside a bare id", () =>
    Effect.gen(function*() {
      const result = yield* run("2964717585", undefined, undefined)
      expect(result._tag).toBe("Failure")
      const withBaseUrl = yield* run("2964717585", undefined, "https://example.atlassian.net")
      expect(withBaseUrl).toMatchObject({
        _tag: "Success",
        success: { baseUrl: "https://example.atlassian.net", id: "2964717585" }
      })
    }))

  // The two flags can name different folders on different sites, so picking a
  // winner would act on content the caller never asked for.
  it.effect("refuses --folder-id together with --url", () =>
    Effect.gen(function*() {
      const result = yield* run(
        "111",
        "https://example.atlassian.net/wiki/spaces/PROJ/folder/222/X",
        undefined
      )
      expect(result._tag).toBe("Failure")
    }))

  // A folder id only exists on the site the URL names; acting on another site's
  // content is a mistake, not a preference.
  it.effect("refuses a --base-url naming a different site than the URL", () =>
    Effect.gen(function*() {
      const result = yield* run(
        undefined,
        "https://a.atlassian.net/wiki/spaces/PROJ/folder/1/Thing",
        "https://b.atlassian.net"
      )
      expect(result._tag).toBe("Failure")
    }))

  // Same hole on the target side: without this the scheme-less value is treated
  // as a bare id and any --base-url is accepted for it.
  it.effect("refuses a scheme-less folder URL instead of treating it as a bare id", () =>
    Effect.gen(function*() {
      const result = yield* run(
        undefined,
        "example.atlassian.net/wiki/spaces/PROJ/folder/2964717585/X",
        "https://other.atlassian.net"
      )
      expect(result._tag).toBe("Failure")
    }))

  it.effect("accepts a --base-url that agrees with the URL", () =>
    Effect.gen(function*() {
      const result = yield* run(
        undefined,
        "https://example.atlassian.net/wiki/spaces/PROJ/folder/1/Thing",
        "https://example.atlassian.net/wiki"
      )
      expect(result).toMatchObject({
        _tag: "Success",
        success: { baseUrl: "https://example.atlassian.net", id: "1" }
      })
    }))
})
