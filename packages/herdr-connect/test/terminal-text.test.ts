/** Copy text and links come from rendered rows, so wrap joining and the scheme allowlist are the contract. */
import { describe, expect, it } from "@effect/vitest"
import { findUrls, logicalLines, safeUrl, selectionText, urlAt } from "../src/terminal-text.js"

describe("safeUrl", () => {
  it("opens only http and https", () => {
    expect(safeUrl("https://example.test/a")).toBe("https://example.test/a")
    expect(safeUrl("http://example.test")).toBe("http://example.test/")
    for (
      const unsafe of [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,x",
        "tel:123",
        "ssh://host",
        "mailto:a@b.c"
      ]
    ) {
      expect(safeUrl(unsafe)).toBeNull()
    }
  })

  it("rejects text that only looks like a URL", () => {
    expect(safeUrl("https://")).toBeNull()
    expect(safeUrl("not a url")).toBeNull()
  })
})

describe("findUrls", () => {
  it("trims sentence punctuation but keeps query and fragment", () => {
    expect(findUrls("see https://example.test/guide?step=2, then retry.")).toEqual([
      { start: 4, end: 37, url: "https://example.test/guide?step=2" }
    ])
    expect(findUrls("(https://example.test/a#b).").map((url) => url.url)).toEqual(["https://example.test/a#b"])
  })

  it("keeps balanced brackets inside a URL", () => {
    expect(findUrls("https://en.example.test/wiki/A_(b)").map((url) => url.url)).toEqual([
      "https://en.example.test/wiki/A_(b)"
    ])
  })

  it("ignores unsafe schemes and finds several links", () => {
    expect(findUrls("javascript:alert(1) file:///x https://a.test http://b.test/").map((url) => url.url)).toEqual([
      "https://a.test/",
      "http://b.test/"
    ])
  })
})

describe("wrapped rows", () => {
  const cols = 10
  const rows = ["0123456789", "abc       ", "short     ", "full-width", "          "]

  it("joins a row that fills the width into the next one", () => {
    expect(logicalLines(rows, cols).map((line) => line.text)).toEqual(["0123456789abc", "short", "full-width"])
  })

  it("finds a URL that wraps across rows from a cell on either row", () => {
    const wrapped = ["go https:/", "/a.test/x ", "next      "]
    expect(urlAt(wrapped, cols, { row: 0, col: 4 })?.url).toBe("https://a.test/x")
    expect(urlAt(wrapped, cols, { row: 1, col: 3 })?.url).toBe("https://a.test/x")
    expect(urlAt(wrapped, cols, { row: 2, col: 1 })).toBeNull()
  })

  it("copies trimmed rows, joining wraps and keeping real line breaks", () => {
    expect(selectionText(rows, cols, { row: 0, col: 0 }, { row: 2, col: 9 })).toBe("0123456789abc\nshort")
    expect(selectionText(rows, cols, { row: 0, col: 5 }, { row: 1, col: 1 })).toBe("56789ab")
  })

  it("cannot join a wrap that lands on a space, which looks like a short line", () => {
    expect(logicalLines(["four five ", "six       "], cols).map((line) => line.text)).toEqual(["four five", "six"])
  })

  it("orders a selection made backwards", () => {
    expect(selectionText(rows, cols, { row: 2, col: 4 }, { row: 2, col: 0 })).toBe("short")
  })
})
