// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { BoundedDiffCodeView } from "../../src/diff/bounded/BoundedDiffCodeView.js"
import type { RlyDiffCodeItem } from "../../src/diff/types.js"

const item = {
  after: { contents: "const ready = true\nship()\n", name: "src/release.ts" },
  before: { contents: "const ready = false\n", name: "src/release.ts" },
  id: "release"
} satisfies RlyDiffCodeItem

describe("BoundedDiffCodeView", () => {
  it("renders Diffs-computed deletions and additions in split mode", () => {
    const html = renderToStaticMarkup(<BoundedDiffCodeView initialItems={[item]} />)

    expect(html).toContain("data-rly-diff-code-view")
    expect(html).toContain('data-rly-diff-mode="split"')
    expect(html).toContain("@@ -1,1 +1,2 @@")
    expect(html).toContain("const ready = false")
    expect(html).toContain("const ready = true")
    expect(html).toContain("ship()")
  })

  it("renders a unified, wrapped view and an explicit empty state", () => {
    const html = renderToStaticMarkup(<BoundedDiffCodeView initialItems={[item]} mode="stacked" wrap />)

    expect(html).toContain('data-rly-diff-mode="stacked"')
    expect(html).toContain(">−<")
    expect(html).toContain(">+<")
    expect(renderToStaticMarkup(<BoundedDiffCodeView empty="No source changes." initialItems={[]} />)).toContain(
      "No source changes."
    )
  })

  it("keeps metadata-only file changes fail-open", () => {
    const unchanged = {
      ...item,
      after: { ...item.before }
    } satisfies RlyDiffCodeItem

    expect(renderToStaticMarkup(<BoundedDiffCodeView initialItems={[unchanged]} />)).toContain(
      "No textual changes in this file."
    )
  })

  it("strips CRLF terminators from rendered code lines", () => {
    const crlf = {
      after: { contents: "a\r\nB\r\n", name: "src/crlf.ts" },
      before: { contents: "a\r\nb\r\n", name: "src/crlf.ts" },
      id: "crlf"
    } satisfies RlyDiffCodeItem
    const html = renderToStaticMarkup(<BoundedDiffCodeView initialItems={[crlf]} />)

    expect(html).toContain(">a<")
    expect(html).toContain(">B<")
    expect(html).not.toContain("\r")
  })
})
