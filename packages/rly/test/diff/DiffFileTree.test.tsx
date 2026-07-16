// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DiffFileTree, type RlyDiffFile } from "../../src/diff/DiffFileTree.js"
import { render } from "../primitives/render.js"

const stateFiles = [
  { change: "added", content: { state: "ready" }, id: "added", path: "src/added.ts" },
  {
    change: "modified",
    content: { label: "Loading content", state: "loading" },
    id: "loading",
    path: "src/loading.ts"
  },
  { change: "deleted", content: { reason: "Image content", state: "binary" }, id: "binary", path: "assets/old.png" },
  {
    change: "renamed",
    content: { reason: "Generated client", state: "generated" },
    id: "renamed",
    path: "src/client.ts",
    previousPath: "src/generated.ts"
  },
  { change: "modified", content: { reason: "Over 2 MiB", state: "oversized" }, id: "large", path: "data/large.json" },
  {
    change: "modified",
    content: { reason: "Provider timeout", state: "unavailable" },
    id: "missing",
    path: "src/missing.ts"
  },
  { change: "modified", content: { reason: "Decode failed", state: "error" }, id: "error", path: "src/error.ts" }
] satisfies ReadonlyArray<RlyDiffFile>

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("DiffFileTree", () => {
  it("names every file change and content state without hiding exceptional paths", () => {
    const tree = render(
      <DiffFileTree
        data={{ files: stateFiles, state: "ready" }}
        heading="PR-184 inventory"
        onSelectedFileChange={() => undefined}
        selectedFileId="renamed"
      />
    )
    expect(tree?.querySelectorAll("[data-rly-diff-file-id]")).toHaveLength(7)
    for (const state of ["ready", "loading", "binary", "generated", "oversized", "unavailable", "error"]) {
      expect(tree?.querySelector(`[data-rly-diff-content-state='${state}']`)).not.toBeNull()
    }
    expect(tree?.textContent).toContain("src/generated.ts")
    expect(tree?.textContent).toContain("src/client.ts")
    expect(tree?.querySelector("[data-rly-diff-file-id='renamed'] button")?.getAttribute("aria-current")).toBe("true")
  })

  it("renders a complete lightweight 500-file inventory without truncation", () => {
    const files = Array.from({ length: 500 }, (_, index): RlyDiffFile => ({
      change: index === 0 ? "added" : "modified",
      content: { state: "ready" },
      id: `file-${index + 1}`,
      path: `src/features/feature-${index + 1}.ts`
    }))
    const tree = render(
      <DiffFileTree
        data={{ files, state: "ready" }}
        heading="500 changed files"
        onSelectedFileChange={() => undefined}
      />
    )
    expect(tree?.querySelectorAll("[data-rly-diff-file-id]")).toHaveLength(500)
    expect(tree?.querySelector("[data-rly-diff-file-id='file-500']")?.textContent).toContain("feature-500.ts")
    expect(tree?.querySelectorAll("pre")).toHaveLength(0)
    expect(tree?.textContent).toContain("500/500")
  })

  it("retains indexed paths during loading and error states", () => {
    const gallery = render(
      <main>
        <DiffFileTree
          data={{
            files: stateFiles.slice(0, 2),
            indexedCount: 2,
            label: "Indexing 2 of 8",
            state: "loading",
            totalCount: 8
          }}
          heading="Loading inventory"
          onSelectedFileChange={() => undefined}
        />
        <DiffFileTree
          data={{
            description: "The last seven indexed paths remain visible.",
            files: stateFiles,
            indexedCount: 7,
            state: "error",
            title: "Indexing stopped",
            totalCount: 8
          }}
          heading="Interrupted inventory"
          onSelectedFileChange={() => undefined}
        />
      </main>
    )
    expect(gallery?.querySelector("[data-rly-diff-inventory-state='loading']")?.getAttribute("aria-busy")).toBe("true")
    expect(gallery?.querySelectorAll("[data-rly-diff-inventory-state='error'] [data-rly-diff-file-id]")).toHaveLength(7)
    expect(gallery?.textContent).toContain("The last seven indexed paths remain visible.")
  })

  it("reports selection without changing controlled state", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const onSelectedFileChange = vi.fn()
    await act(async () =>
      root.render(
        <DiffFileTree
          data={{ files: stateFiles, state: "ready" }}
          heading="Changed files"
          onSelectedFileChange={onSelectedFileChange}
          selectedFileId="added"
        />
      )
    )
    const target = host.querySelector<HTMLButtonElement>("[data-rly-diff-file-id='error'] button")
    await act(async () => target?.click())
    expect(onSelectedFileChange).toHaveBeenCalledWith("error")
    expect(host.querySelector("[data-rly-diff-file-id='added'] button")?.getAttribute("aria-current")).toBe("true")
    await act(async () => root.unmount())
  })

  it("rejects incomplete counts, invalid renames, and invisible selection", () => {
    expect(() =>
      renderToStaticMarkup(
        <DiffFileTree
          data={{ files: stateFiles.slice(0, 2), indexedCount: 1, label: "Indexing", state: "loading", totalCount: 8 }}
          heading="Changed files"
          onSelectedFileChange={() => undefined}
        />
      )
    ).toThrow("indexedCount must match visible files")
    expect(() =>
      renderToStaticMarkup(
        <DiffFileTree
          data={{
            files: [
              { change: "renamed", content: { state: "ready" }, id: "same", path: "same.ts", previousPath: "same.ts" }
            ],
            state: "ready"
          }}
          heading="Changed files"
          onSelectedFileChange={() => undefined}
        />
      )
    ).toThrow("renamed paths must differ")
    expect(() =>
      renderToStaticMarkup(
        <DiffFileTree
          data={{ files: stateFiles, state: "ready" }}
          heading="Changed files"
          onSelectedFileChange={() => undefined}
          selectedFileId="not-indexed"
        />
      )
    ).toThrow("selectedFileId is not in the visible inventory")
  })
})
