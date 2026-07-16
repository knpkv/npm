// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { DiffCodeView } from "../../src/diff/DiffCodeView.js"
import type { RlyDiffCodeItem } from "../../src/diff/types.js"
import { DiffWorkerProvider } from "../../src/diff/worker-pool.js"

const item = {
  after: { contents: "const ready = true\n", name: "src/release.ts" },
  before: { contents: "const ready = false\n", name: "src/release.ts" },
  id: "release"
} satisfies RlyDiffCodeItem

afterEach(() => document.body.replaceChildren())

describe("DiffCodeView", () => {
  it("always seeds the pinned renderer through its uncontrolled initialItems mode", () => {
    const html = renderToStaticMarkup(
      <DiffCodeView
        annotations={[
          { id: "finding-1", itemId: "release", lineNumber: 1, message: "Verify the gate", side: "additions" }
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
    await act(async () =>
      root.render(
        <DiffWorkerProvider
          workerFactory={() => {
            throw new Error("Workers blocked by policy")
          }}
        >
          <DiffCodeView initialItems={[item]} />
        </DiffWorkerProvider>
      )
    )
    expect(host.textContent).toContain("Worker acceleration is unavailable")
    expect(host.querySelectorAll("[role='status']")).toHaveLength(1)
    expect(host.querySelector("[data-rly-diff-code-fallback]")).toBeNull()
    expect(host.querySelectorAll("[data-rly-diff-code-view]")).toHaveLength(1)
    await act(async () => root.unmount())
  })

  it("renders an explicit empty state and validates annotations and context", () => {
    expect(renderToStaticMarkup(<DiffCodeView empty="No text changes in this release." initialItems={[]} />)).toContain(
      "No text changes in this release."
    )
    expect(() =>
      renderToStaticMarkup(
        <DiffCodeView
          annotations={[{ id: " ", itemId: "release", lineNumber: 1, message: "Finding", side: "additions" }]}
          initialItems={[item]}
        />
      )
    ).toThrow("annotation id")
    expect(() => renderToStaticMarkup(<DiffCodeView contextLines={-1} initialItems={[item]} />)).toThrow(
      "context lines"
    )
  })
})
