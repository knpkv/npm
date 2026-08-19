import { describe, expect, it } from "@effect/vitest"
import { searchOutputLines } from "../src/commands/search.js"

const hit = (id: string, title: string) => ({
  title,
  url: `/spaces/PROJ/pages/${id}/${title}`,
  entityType: "content",
  content: { id, type: "page", status: "current" }
})

describe("searchOutputLines", () => {
  // `--limit 0` returns an empty page alongside a positive total. Saying
  // "(no results)" there answers the caller's question with the opposite of the
  // truth, and CQL is the lookup a caller branches on.
  it("distinguishes an empty page from an empty result set", () => {
    expect(searchOutputLines({ results: [], totalSize: 7 })).toEqual([
      "7 match(es), none shown — raise --limit"
    ])
  })

  // The nearby valid fixture: genuinely nothing matched.
  it("reports no results when the total is zero", () => {
    expect(searchOutputLines({ results: [], totalSize: 0 })).toEqual(["(no results)"])
  })

  it("reports no results when the total is absent", () => {
    expect(searchOutputLines({ results: [] })).toEqual(["(no results)"])
  })

  it("flags a page that is cut short by the limit", () => {
    const lines = searchOutputLines({ results: [hit("1", "Release Notes")], totalSize: 7 })

    expect(lines[0]).toBe("type  id  title")
    expect(lines[1]).toBe("page  1  Release Notes")
    expect(lines[2]).toBe("showing 1 of 7 — raise --limit for more")
  })

  // A complete answer must not carry a "there is more" line.
  it("adds no truncation line when the page holds every match", () => {
    const lines = searchOutputLines({ results: [hit("1", "Release Notes")], totalSize: 1 })

    expect(lines).toHaveLength(2)
  })
})
