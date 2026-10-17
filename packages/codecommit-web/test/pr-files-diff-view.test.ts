// @vitest-environment happy-dom
import { describe, expect, it, vi } from "@effect/vitest"
import { PullRequestId } from "@knpkv/codecommit-core/Domain.js"
import { createElement, createRef } from "react"
import { PRFilesDiffView, type PRFilesDiffViewProps } from "../src/client/components/pr-files-diff-view.js"
import { click, mountFixture } from "./pr-view-fixtures.js"

const diff: PRFilesDiffViewProps["diff"] = {
  pullRequestId: PullRequestId.make("7"),
  revisionId: "r1",
  baseCommit: "base",
  headCommit: "abcdef0123456789",
  files: [{
    index: 0,
    status: "modified",
    path: "retry.ts",
    previousPath: null,
    beforeMode: "100644",
    afterMode: "100755"
  }, { index: 1, status: "added", path: "new.ts", previousPath: null, beforeMode: null, afterMode: "100644" }]
}
const makeProps = (): PRFilesDiffViewProps => ({
  diff,
  pullRequestId: diff.pullRequestId,
  diffFailure: null,
  selectedFile: diff.files[0],
  selectedFileMode: "100644 → 100755",
  inventory: {
    state: "ready",
    files: [{ id: "0", path: "retry.ts", change: "modified", content: { state: "ready" } }, {
      id: "1",
      path: "new.ts",
      change: "added",
      content: { state: "ready" }
    }]
  },
  layout: "split",
  wrap: false,
  workbenchRef: createRef(),
  onSelectedFileChange: vi.fn(),
  onLayoutChange: vi.fn(),
  onWrapChange: vi.fn(),
  renderSelectedFile: vi.fn(() => createElement("div", null, "Fixture file content")),
  findings: {
    placement: "column",
    open: false,
    label: "2 findings",
    triggerRef: createRef(),
    onOpen: vi.fn(),
    renderPane: vi.fn(() => createElement("aside", null, "Fixture findings"))
  }
})
describe("PRFilesDiffView", () => {
  it("shows immutable head and modes, injects content and forwards file/layout/wrap choices", async () => {
    const props = makeProps()
    const { host } = await mountFixture(createElement(PRFilesDiffView, props))
    expect(host.textContent).toContain("2 changed files at head “Commit title unavailable”")
    expect(host.textContent).not.toContain("abcdef012345")
    expect(host.textContent).toContain("100644 → 100755")
    expect(host.querySelector("[aria-label=\"Selected file diff\"]")?.textContent).toContain("Fixture file content")
    const fileButton = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("new.ts"))
    expect(fileButton).toBeDefined()
    await click(host, fileButton?.textContent?.trim() ?? "Missing file")
    expect(props.onSelectedFileChange).toHaveBeenCalledWith("1")
    await click(host, "Stacked")
    await click(host, "Split")
    await click(host, "Wrap")
    expect(props.onLayoutChange).toHaveBeenNthCalledWith(1, "stacked")
    expect(props.onLayoutChange).toHaveBeenNthCalledWith(2, "split")
    expect(props.onWrapChange).toHaveBeenCalledOnce()
    expect(host.textContent).toContain("Relay is advisory")
  })

  it("retains injected exact-revision content under failure and renders empty diffs without loading a file", async () => {
    const props = makeProps()
    const { host, render } = await mountFixture(
      createElement(PRFilesDiffView, { ...props, diffFailure: "Provider unavailable." })
    )
    expect(host.textContent).toContain("Latest diff unavailable")
    expect(host.textContent).toContain("Showing the last successfully loaded exact revision")
    expect(host.textContent).toContain("Fixture file content")
    vi.mocked(props.renderSelectedFile).mockClear()
    await render(
      createElement(PRFilesDiffView, {
        ...props,
        diff: { ...diff, files: [] },
        selectedFile: undefined,
        selectedFileMode: null,
        inventory: { state: "ready", files: [] }
      })
    )
    expect(host.textContent).toContain("Empty diff")
    expect(host.textContent).toContain("No changed file")
    expect(props.renderSelectedFile).not.toHaveBeenCalled()
  })

  it.each(["drawer", "inline", "column"] satisfies ReadonlyArray<PRFilesDiffViewProps["findings"]["placement"]>)(
    "preserves $0 findings placement and drawer trigger ownership",
    async (placement) => {
      const props = makeProps()
      const { host } = await mountFixture(
        createElement(PRFilesDiffView, { ...props, findings: { ...props.findings, placement } })
      )
      expect(host.querySelector("[data-findings]")?.getAttribute("data-findings")).toBe(placement)
      if (placement === "drawer") {
        expect(host.textContent).not.toContain("Fixture findings")
        expect(props.findings.renderPane).not.toHaveBeenCalled()
        expect(props.findings.triggerRef.current?.getAttribute("aria-expanded")).toBe("false")
        await click(host, "2 findings")
        expect(props.findings.onOpen).toHaveBeenCalledOnce()
      } else {
        expect(host.textContent).toContain("Fixture findings")
        expect(props.findings.renderPane).toHaveBeenCalledOnce()
      }
    }
  )
})
