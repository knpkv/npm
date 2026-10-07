// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BoundedDiffCodeView } from "../../src/diff/bounded/BoundedDiffCodeView.js"
import type { RlyDiffCodeAnnotation, RlyDiffCodeItem } from "../../src/diff/types.js"

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

  it("renders application-owned annotations in both layouts", () => {
    const annotation: RlyDiffCodeAnnotation = {
      accessibilityLabel: "High confidence release finding",
      id: "release-finding",
      location: { itemId: "release", lineNumber: 1, side: "additions" },
      render: () => <article>High · 96% · draft finding</article>
    }
    const modes: ReadonlyArray<"split" | "stacked"> = ["split", "stacked"]

    for (const mode of modes) {
      const html = renderToStaticMarkup(
        <BoundedDiffCodeView annotations={[annotation]} initialItems={[item]} mode={mode} />
      )
      expect(html).toContain('data-rly-diff-annotation="release-finding"')
      expect(html).toContain("High · 96% · draft finding")
      expect(html).toContain('tabindex="0"')
    }
  })

  afterEach(() => vi.restoreAllMocks())

  it("stacks a split view in a container too narrow for two code columns, and keeps it split when wide", async () => {
    const mountAt = async (width: number) => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, width, 400))
      const host = document.createElement("div")
      document.body.append(host)
      await act(async () => createRoot(host).render(<BoundedDiffCodeView initialItems={[item]} />))
      return host.querySelector("[data-rly-diff-code-view]")?.getAttribute("data-rly-diff-mode")
    }
    expect(await mountAt(400)).toBe("stacked")
    expect(await mountAt(1024)).toBe("split")
    // Not laid out yet (no layout engine): the requested mode stands.
    expect(await mountAt(0)).toBe("split")
  })

  it("returns annotation focus to its exact bounded line", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <BoundedDiffCodeView
          annotations={[
            {
              accessibilityLabel: "Release finding",
              id: "release-finding",
              location: { itemId: "release", lineNumber: 1, side: "additions" },
              render: ({ returnFocus }) => <button onClick={returnFocus}>Return to line</button>
            }
          ]}
          initialItems={[item]}
        />
      )
    )

    const card = host.querySelector<HTMLElement>("[data-rly-diff-annotation='release-finding']")
    const button = host.querySelector<HTMLButtonElement>("button")
    button?.focus()
    await act(async () => button?.click())
    expect(document.activeElement).toBe(
      host.querySelector("[data-rly-diff-item='release'][data-rly-diff-line='1'][data-rly-diff-line-side='additions']")
    )

    card?.focus()
    card?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }))
    expect(document.activeElement).toBe(
      host.querySelector("[data-rly-diff-item='release'][data-rly-diff-line='1'][data-rly-diff-line-side='additions']")
    )
    await act(async () => root.unmount())
    host.remove()
  })
})
