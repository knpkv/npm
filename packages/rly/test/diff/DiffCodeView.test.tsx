// @vitest-environment happy-dom

import { act, createRef } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DiffCodeAnnotation, requireDiffCodeAnnotations } from "../../src/diff/annotation.js"
import { DiffCodeView } from "../../src/diff/DiffCodeView.js"
import type { RlyDiffCodeAnnotation, RlyDiffCodeItem, RlyDiffCodeViewHandle } from "../../src/diff/types.js"
import { DiffWorkerProvider } from "../../src/diff/worker-pool.js"

const item = {
  after: { contents: "const ready = true\n", name: "src/release.ts" },
  before: { contents: "const ready = false\n", name: "src/release.ts" },
  id: "release"
} satisfies RlyDiffCodeItem
const shiftedContextItem = {
  after: { contents: "const inserted = true\nconst stable = true\n", name: "src/release.ts" },
  before: { contents: "const stable = true\n", name: "src/release.ts" },
  id: "shifted-context"
} satisfies RlyDiffCodeItem

const validAnnotation = {
  accessibilityLabel: "Finding",
  id: "finding",
  location: { itemId: "release", lineNumber: 1, side: "additions" },
  render: () => "Finding"
} satisfies RlyDiffCodeAnnotation
const rendererModes: ReadonlyArray<"split" | "stacked"> = ["split", "stacked"]

afterEach(() => document.body.replaceChildren())

describe("DiffCodeView", () => {
  it("always seeds the pinned renderer through its uncontrolled initialItems mode", () => {
    const html = renderToStaticMarkup(
      <DiffCodeView
        annotations={[
          {
            accessibilityLabel: "Verify the release gate",
            id: "finding-1",
            location: { itemId: "release", lineNumber: 1, side: "additions" },
            render: () => "Verify the gate"
          }
        ]}
        initialItems={[item]}
        mode="stacked"
        selectedLines={{ id: "release", range: { end: 1, start: 1 } }}
        wrap
      />
    )
    expect(html).toContain("data-rly-diff-code-view")
    expect(html).toContain('data-rly-diff-mode="stacked"')
    expect(html).not.toContain("Text diff fallback")
  })

  it("falls back to the same complete renderer without duplicating source text", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const onItemRender = vi.fn()
    await act(async () =>
      root.render(
        <DiffWorkerProvider
          workerFactory={() => {
            throw new Error("Workers blocked by policy")
          }}
        >
          <DiffCodeView initialItems={[item]} onItemRender={onItemRender} />
        </DiffWorkerProvider>
      )
    )
    expect(host.textContent).toContain("Worker acceleration is unavailable")
    expect(host.querySelectorAll("[role='status']")).toHaveLength(1)
    expect(host.querySelector("[data-rly-diff-code-fallback]")).toBeNull()
    expect(host.querySelectorAll("[data-rly-diff-code-view]")).toHaveLength(1)
    await vi.waitFor(() => {
      expect(onItemRender).toHaveBeenCalledWith(item.id, "fallback")
    })
    await act(async () => root.unmount())
  })

  it.each(rendererModes)("focuses an exact added line through the %s renderer", async (mode) => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const rendererRef = createRef<RlyDiffCodeViewHandle>()
    await act(async () =>
      root.render(
        <DiffWorkerProvider
          workerFactory={() => {
            throw new Error("Workers blocked by policy")
          }}
        >
          <DiffCodeView initialItems={[item]} mode={mode} ref={rendererRef} />
        </DiffWorkerProvider>
      )
    )

    await vi.waitFor(() => {
      expect(host.querySelector(`diffs-container[data-rly-diff-item="${item.id}"]`)).not.toBeNull()
    })
    const focused = rendererRef.current?.focusLine({
      id: item.id,
      lineNumber: 1,
      side: "additions",
      type: "line"
    })
    const container = host.querySelector<HTMLElement>(`diffs-container[data-rly-diff-item="${item.id}"]`)
    expect(container).not.toBeNull()
    expect(focused, container?.shadowRoot?.innerHTML).toBe(true)
    expect(container?.shadowRoot?.activeElement?.getAttribute("data-line")).toBe("1")
    await act(async () => root.unmount())
  })

  it("focuses both identities of a shifted stacked context line", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const rendererRef = createRef<RlyDiffCodeViewHandle>()
    await act(async () =>
      root.render(
        <DiffWorkerProvider
          workerFactory={() => {
            throw new Error("Workers blocked by policy")
          }}
        >
          <DiffCodeView initialItems={[shiftedContextItem]} mode="stacked" ref={rendererRef} />
        </DiffWorkerProvider>
      )
    )
    await vi.waitFor(() => {
      expect(host.querySelector(`diffs-container[data-rly-diff-item="${shiftedContextItem.id}"]`)).not.toBeNull()
    })
    const container = host.querySelector<HTMLElement>(`diffs-container[data-rly-diff-item="${shiftedContextItem.id}"]`)

    expect(
      rendererRef.current?.focusLine({
        id: shiftedContextItem.id,
        lineNumber: 2,
        side: "additions",
        type: "line"
      })
    ).toBe(true)
    expect(container?.shadowRoot?.activeElement?.getAttribute("data-line")).toBe("2")
    expect(
      rendererRef.current?.focusLine({
        id: shiftedContextItem.id,
        lineNumber: 1,
        side: "deletions",
        type: "line"
      })
    ).toBe(true)
    expect(container?.shadowRoot?.activeElement?.getAttribute("data-alt-line")).toBe("1")
    await act(async () => root.unmount())
  })

  it("renders an explicit empty state and validates annotations and context", () => {
    expect(renderToStaticMarkup(<DiffCodeView empty="No text changes in this release." initialItems={[]} />)).toContain(
      "No text changes in this release."
    )
    expect(() =>
      renderToStaticMarkup(
        <DiffCodeView
          annotations={[
            {
              accessibilityLabel: "Finding",
              id: " ",
              location: { itemId: "release", lineNumber: 1, side: "additions" },
              render: () => "Finding"
            }
          ]}
          initialItems={[item]}
        />
      )
    ).toThrow("annotation id")
    expect(() =>
      renderToStaticMarkup(
        <DiffCodeView
          annotations={[
            {
              accessibilityLabel: "Finding",
              id: "finding",
              location: { itemId: "release", lineNumber: 0, side: "additions" },
              render: () => "Finding"
            }
          ]}
          initialItems={[item]}
        />
      )
    ).toThrow("positive integer")
    expect(() => renderToStaticMarkup(<DiffCodeView contextLines={-1} initialItems={[item]} />)).toThrow(
      "context lines"
    )
  })

  it("rejects each invalid public annotation identity field", () => {
    expect(() => requireDiffCodeAnnotations([{ ...validAnnotation, accessibilityLabel: " " }])).toThrow(
      "accessibility label"
    )
    expect(() =>
      requireDiffCodeAnnotations([validAnnotation, { ...validAnnotation, accessibilityLabel: "Duplicate finding" }])
    ).toThrow("must be unique")
    expect(() =>
      requireDiffCodeAnnotations([{ ...validAnnotation, location: { ...validAnnotation.location, itemId: " " } }])
    ).toThrow("item id")
  })

  it("returns focus to the requested side when split fallback markers share a line number", async () => {
    const container = document.createElement("diffs-container")
    const shadow = container.shadowRoot
    if (shadow === null) throw new Error("Expected the diff container shadow root")
    const deletion = document.createElement("span")
    deletion.dataset.deletions = ""
    deletion.dataset.line = "1"
    deletion.tabIndex = -1
    const addition = document.createElement("span")
    addition.dataset.additions = ""
    addition.dataset.line = "1"
    addition.tabIndex = -1
    shadow.replaceChildren(deletion, addition)
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => root.render(<DiffCodeAnnotation annotation={validAnnotation} className="annotation" />))
    const card = container.querySelector<HTMLElement>("[data-rly-diff-annotation='finding']")
    card?.focus()
    card?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }))

    expect(shadow.activeElement).toBe(addition)
    await act(async () => root.unmount())
    container.remove()
  })

  it("returns focus through alternate-line renderer markup", async () => {
    const container = document.createElement("diffs-container")
    const shadow = container.shadowRoot
    if (shadow === null) throw new Error("Expected the diff container shadow root")
    const additions = document.createElement("span")
    additions.dataset.additions = ""
    const alternate = document.createElement("span")
    alternate.dataset.altLine = "1"
    alternate.tabIndex = -1
    additions.append(alternate)
    shadow.replaceChildren(additions)
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => root.render(<DiffCodeAnnotation annotation={validAnnotation} className="annotation" />))
    const card = container.querySelector<HTMLElement>("[data-rly-diff-annotation='finding']")
    card?.focus()
    card?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }))

    expect(shadow.activeElement).toBe(alternate)
    await act(async () => root.unmount())
    container.remove()
  })
})
