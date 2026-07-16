// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { DiffWorkbench, type DiffWorkbenchProps, type RlyDiffWorkbenchFinding } from "../../src/diff/DiffWorkbench.js"
import { render } from "../primitives/render.js"

const findings = [
  { content: <article>Human review finding</article>, id: "human-1" },
  { content: <article>Agent review finding</article>, id: "agent-1" }
] satisfies ReadonlyArray<RlyDiffWorkbenchFinding>

const commonProps = {
  findings,
  header: <header>Complete diff header</header>,
  inventory: <nav>Six changed files</nav>,
  label: "PR-184 diff review",
  scope: { label: "All six changed files", mode: "all-files" },
  statusNotice: "Three source files are ready to render.",
  viewer: <div>Virtualized code viewer</div>
} satisfies DiffWorkbenchProps

describe("DiffWorkbench", () => {
  it("keeps inventory, status, viewer, and every semantic finding in reading order", () => {
    const workbench = render(<DiffWorkbench {...commonProps} />)
    const slots = Array.from(workbench?.querySelectorAll("[data-rly-diff-workbench-slot]") ?? []).map((slot) =>
      slot.getAttribute("data-rly-diff-workbench-slot")
    )

    expect(slots).toEqual(["header", "inventory", "status", "viewer", "findings"])
    expect(workbench?.querySelector("section[aria-label='Changed files']")?.textContent).toContain("Six changed files")
    expect(workbench?.querySelector("section[aria-label='Code changes']")?.textContent).toContain(
      "Virtualized code viewer"
    )
    expect(workbench?.querySelector("aside[aria-label='Semantic findings'] ol")?.children).toHaveLength(2)
    expect(workbench?.querySelector("ol[aria-label='Semantic findings list']")?.getAttribute("tabindex")).toBe("0")
    expect(workbench?.textContent).toContain("Human review finding")
    expect(workbench?.textContent).toContain("Agent review finding")
  })

  it("exposes controlled all-files and selected-file presentations", () => {
    const gallery = render(
      <main>
        <DiffWorkbench {...commonProps} />
        <DiffWorkbench
          {...commonProps}
          onShowAllFiles={() => undefined}
          scope={{ fileId: "authorize", label: "src/payments/authorize.ts", mode: "selected-file" }}
        />
      </main>
    )
    const allFiles = gallery?.querySelector("[data-rly-diff-scope='all-files']")
    const selectedFile = gallery?.querySelector("[data-rly-diff-scope='selected-file']")

    expect(allFiles?.textContent).toContain("All files")
    expect(allFiles?.textContent).toContain("All six changed files")
    expect(selectedFile?.getAttribute("data-rly-diff-selected-file")).toBe("authorize")
    expect(selectedFile?.textContent).toContain("Selected file")
    expect(selectedFile?.textContent).toContain("src/payments/authorize.ts")
    const showAll = selectedFile?.querySelector<HTMLButtonElement>("button")
    expect(showAll?.textContent).toContain("Show all files")
  })

  it("renders an explicit empty finding state and rejects unstable finding identity", () => {
    const empty = render(
      <DiffWorkbench
        {...commonProps}
        emptyFindings={<p>No human or agent findings for this revision.</p>}
        findings={[]}
        statusNotice={undefined}
      />
    )

    expect(empty?.querySelector("[data-rly-diff-workbench-slot='status']")).toBeNull()
    expect(empty?.querySelector("[data-rly-diff-workbench-slot='findings'] ol")).toBeNull()
    expect(empty?.textContent).toContain("No human or agent findings for this revision.")
    expect(() =>
      renderToStaticMarkup(
        <DiffWorkbench
          {...commonProps}
          findings={[
            { content: "First", id: "duplicate" },
            { content: "Second", id: "duplicate" }
          ]}
        />
      )
    ).toThrow("finding ids must be unique")
    expect(() =>
      renderToStaticMarkup(
        <DiffWorkbench
          {...commonProps}
          scope={{ fileId: "authorize", label: "src/payments/authorize.ts", mode: "selected-file" }}
        />
      )
    ).toThrow("requires onShowAllFiles")
  })
})
