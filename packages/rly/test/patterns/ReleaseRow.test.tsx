// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  RlyReleasePresentation,
  RlyReleaseState,
  RlyReleaseTransitionNames
} from "../../src/patterns/ReleasePresentation.js"
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

const generatedTransitionNames = {
  relay: "release-01890f6f-6d6a-7cc0-98d2-000000000001-relay",
  verdict: "release-01890f6f-6d6a-7cc0-98d2-000000000001-verdict",
  version: "release-01890f6f-6d6a-7cc0-98d2-000000000001-version"
} satisfies RlyReleaseTransitionNames

const edgeTransitionNames = {
  relay: "--",
  verdict: "\uFFFD",
  version: "ROOT"
} satisfies RlyReleaseTransitionNames

const changingTransitionNames = (): {
  readonly names: RlyReleaseTransitionNames
  readonly reads: () => readonly [number, number, number]
} => {
  let relayReads = 0
  let verdictReads = 0
  let versionReads = 0
  return {
    names: {
      get relay() {
        relayReads += 1
        return relayReads === 1 ? generatedTransitionNames.relay : "none"
      },
      get verdict() {
        verdictReads += 1
        return verdictReads === 1 ? generatedTransitionNames.verdict : "root"
      },
      get version() {
        versionReads += 1
        return versionReads === 1 ? generatedTransitionNames.version : "123-release"
      }
    },
    reads: () => [relayReads, verdictReads, versionReads]
  }
}

const invalidTransitionNames: ReadonlyArray<readonly [RlyReleaseTransitionNames, string]> = [
  [{ ...generatedTransitionNames, relay: " " }, "Release transition relay name must contain visible text"],
  [{ ...generatedTransitionNames, relay: "none" }, "must not use a reserved CSS value: none"],
  [{ ...generatedTransitionNames, verdict: "INITIAL" }, "must not use a reserved CSS value: INITIAL"],
  [{ ...generatedTransitionNames, version: "match-element" }, "must not use a reserved CSS value: match-element"],
  [{ ...generatedTransitionNames, relay: "root" }, "must not use a reserved CSS value: root"],
  [{ ...generatedTransitionNames, relay: "\uD800" }, "must be a valid unescaped CSS custom identifier"],
  [{ ...generatedTransitionNames, relay: "\uDC00" }, "must be a valid unescaped CSS custom identifier"],
  [{ ...generatedTransitionNames, relay: "release / relay" }, "must be a valid unescaped CSS custom identifier"],
  [{ ...generatedTransitionNames, version: generatedTransitionNames.relay }, "Release transition names must be unique"]
]

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
    expect(
      [...row.querySelectorAll("[data-rly-release-fact]")].map((fact) => fact.getAttribute("data-rly-release-fact"))
    ).toEqual(["commit", "target", "changes"])
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

  it("assigns caller-owned shared geometry only while a release transition is active", () => {
    const row = render(
      <ReleaseRow onPreview={() => undefined} release={release} transitionNames={generatedTransitionNames} />
    )
    const parts = [...(row?.querySelectorAll<HTMLElement>("[data-rly-release-transition-part]") ?? [])]
    expect(parts.map((part) => [part.dataset.rlyReleaseTransitionPart, part.dataset.rlyReleaseTransitionName])).toEqual(
      [
        ["relay", generatedTransitionNames.relay],
        ["version", generatedTransitionNames.version],
        ["verdict", generatedTransitionNames.verdict]
      ]
    )

    const idleRow = render(<ReleaseRow onPreview={() => undefined} release={release} />)
    expect(
      [...(idleRow?.querySelectorAll<HTMLElement>("[data-rly-release-transition-part]") ?? [])].every(
        (part) => part.dataset.rlyReleaseTransitionName === undefined
      )
    ).toBe(true)
  })

  it("accepts browser-stable edge identifiers and snapshots changing accessor values", () => {
    const edgeRow = render(
      <ReleaseRow onPreview={() => undefined} release={release} transitionNames={edgeTransitionNames} />
    )
    const edgeParts = [...(edgeRow?.querySelectorAll<HTMLElement>("[data-rly-release-transition-part]") ?? [])]
    expect(edgeParts.map((part) => part.dataset.rlyReleaseTransitionName)).toEqual([
      edgeTransitionNames.relay,
      edgeTransitionNames.version,
      edgeTransitionNames.verdict
    ])

    const probe = changingTransitionNames()
    const changingRow = render(
      <ReleaseRow onPreview={() => undefined} release={release} transitionNames={probe.names} />
    )
    const changingParts = [...(changingRow?.querySelectorAll<HTMLElement>("[data-rly-release-transition-part]") ?? [])]
    expect(changingParts.map((part) => part.dataset.rlyReleaseTransitionName)).toEqual([
      generatedTransitionNames.relay,
      generatedTransitionNames.version,
      generatedTransitionNames.verdict
    ])
    expect(probe.reads()).toEqual([1, 1, 1])
  })

  it("rejects unsafe or colliding transition names at the public ReleaseRow contract", () => {
    for (const [transitionNames, expectedMessage] of invalidTransitionNames) {
      expect(() =>
        renderToStaticMarkup(
          <ReleaseRow onPreview={() => undefined} release={release} transitionNames={transitionNames} />
        )
      ).toThrow(expectedMessage)
    }
  })

  it("represents every release state through data only while preserving visible content", () => {
    const states = [
      "blocked",
      "ready",
      "deploying",
      "building",
      "shipped",
      "held",
      "unknown"
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

  it("renders an unknown release with an explicit unassigned owner instead of inventing a person", () => {
    const unassignedRelease = {
      algorithm: release.algorithm,
      approver: release.approver,
      codename: release.codename,
      facts: release.facts,
      freshness: release.freshness,
      freshnessDateTime: release.freshnessDateTime,
      freshnessTime: release.freshnessTime,
      id: "release-unknown",
      reason: "No readiness evaluation has been supplied for this release.",
      state: "unknown",
      symbolIndices: release.symbolIndices,
      tone: "neutral",
      verdict: "Readiness not evaluated",
      version: release.version
    } satisfies RlyReleasePresentation
    const row = render(<ReleaseRow onPreview={() => undefined} release={unassignedRelease} />)

    expect(row?.getAttribute("data-rly-release-state")).toBe("unknown")
    expect(row?.textContent).toContain("Readiness not evaluated")
    expect(row?.textContent).toContain("Unassigned")
    expect(row?.querySelector("[data-rly-release-owner='unassigned']")).not.toBeNull()
    expect(row?.textContent).not.toContain("Mara Bell")
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
