// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RlyReleasePresentation, RlyReleaseState } from "../../src/patterns/ReleasePresentation.js"
import { ReleaseRow } from "../../src/patterns/ReleaseRow.js"
import { render } from "../primitives/render.js"

const owner = { id: "mara", name: "Mara Bell", role: "Release owner" }
const approver = { id: "dev", name: "Dev Shah", role: "Production approver" }
const release = {
  algorithm: "rly-relay-v1",
  approver,
  codename: "Copper Finch",
  facts: [
    { id: "commit", label: "Commit", value: "8fa21c7" },
    { id: "target", label: "Target", value: "production-eu-west-1" },
    { id: "changes", label: "Changes", value: "14 files" }
  ],
  freshness: "current",
  freshnessDateTime: "2026-07-13T09:42:00Z",
  freshnessTime: "09:42 UTC",
  id: "release-240",
  owner,
  reason: "All required evidence is present and the production approver is assigned.",
  state: "ready",
  symbolIndices: [2, 7, 13],
  tone: "positive",
  verdict: "Ready to deploy",
  version: "v2.4.0"
} satisfies RlyReleasePresentation

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("ReleaseRow", () => {
  it("renders a complete semantic release dossier without deriving the supplied verdict", () => {
    const row = render(
      <ReleaseRow
        agentEntry={<button type="button">Ask release agent</button>}
        onPreview={() => undefined}
        release={release}
      />
    )
    if (row === null) throw new Error("ReleaseRow did not render")

    expect(row.tagName).toBe("ARTICLE")
    expect(row.getAttribute("data-rly-release-state")).toBe("ready")
    expect(row.textContent).toContain("v2.4.0")
    expect(row.textContent).toContain("Copper Finch")
    expect(row.textContent).toContain("Ready to deploy")
    expect(row.textContent).toContain(release.reason)
    expect(row.textContent).toContain("Current")
    expect(row.textContent).toContain("09:42 UTC")
    expect(row.textContent).toContain("Mara Bell")
    expect(row.textContent).toContain("Dev Shah")
    expect(row.querySelectorAll("dl > div")).toHaveLength(release.facts.length)
    expect([...row.querySelectorAll("dt")].map((term) => term.textContent)).toEqual(["Commit", "Target", "Changes"])
    expect([...row.querySelectorAll("dd")].map((definition) => definition.textContent)).toEqual([
      "8fa21c7",
      "production-eu-west-1",
      "14 files"
    ])
    expect(row.textContent).toContain("Ask release agent")

    const contradictory = render(
      <ReleaseRow
        onPreview={() => undefined}
        release={{ ...release, reason: "The caller explicitly supplied this outcome.", verdict: "Do not release" }}
      />
    )
    expect(contradictory?.textContent).toContain("Do not release")
    expect(contradictory?.textContent).toContain("The caller explicitly supplied this outcome.")
  })

  it("represents all six release states through data only while preserving visible content", () => {
    const states = [
      "blocked",
      "ready",
      "deploying",
      "building",
      "shipped",
      "held"
    ] satisfies ReadonlyArray<RlyReleaseState>
    for (const state of states) {
      const row = render(
        <ReleaseRow
          onPreview={() => undefined}
          release={{ ...release, id: `release-${state}`, state, verdict: `Supplied ${state} verdict` }}
        />
      )
      expect(row?.getAttribute("data-rly-release-state")).toBe(state)
      expect(row?.textContent).toContain(`Supplied ${state} verdict`)
      expect(row?.querySelectorAll("dl > div")).toHaveLength(3)
    }
  })

  it("calls the preview callback exactly once for one activation", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const onPreview = vi.fn()
    await act(async () => root.render(<ReleaseRow onPreview={onPreview} release={release} />))
    const button = host.querySelector<HTMLButtonElement>("button")
    if (button === null) throw new Error("ReleaseRow preview action did not render")
    expect(button.textContent).toContain("Preview release")
    await act(async () => button.click())
    expect(onPreview).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it("validates release projections, people, and the visible action label", () => {
    expect(() =>
      renderToStaticMarkup(<ReleaseRow onPreview={() => undefined} release={{ ...release, version: " " }} />)
    ).toThrow("Release presentation version")
    expect(() =>
      renderToStaticMarkup(
        <ReleaseRow
          onPreview={() => undefined}
          release={{ ...release, facts: [{ id: "commit", label: "Commit", value: " " }] }}
        />
      )
    ).toThrow("Release presentation fact value")
    expect(() =>
      renderToStaticMarkup(
        <ReleaseRow onPreview={() => undefined} release={{ ...release, owner: { ...owner, name: " " } }} />
      )
    ).toThrow("Person name")
    expect(() =>
      renderToStaticMarkup(<ReleaseRow onPreview={() => undefined} previewLabel=" " release={release} />)
    ).toThrow("ReleaseRow previewLabel")
  })
})
