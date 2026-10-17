import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { CanvasGraphReading, CanvasReviewContext } from "../src/canvas/model.js"
import { type CanvasViewState, initialCanvasView, makeCanvasWorld } from "../src/canvas/view-state.js"
import { ReviewCanvas, type ReviewCanvasProps, type ReviewCanvasText } from "../src/canvas/view.js"
import { sampleContext, sampleFindings, sampleGraph } from "./canvas-fixture.js"

const start = initialCanvasView(makeCanvasWorld(sampleGraph, sampleContext, sampleFindings))

/** What a reader sees: the markup without its tags. */
const textOf = (markup: string): string => markup.replace(/<[^>]+>/gu, "")

const render = (
  overrides: {
    readonly graph?: CanvasGraphReading
    readonly state?: Partial<CanvasViewState>
    readonly text?: ReviewCanvasText
    readonly context?: CanvasReviewContext
  } = {}
) => {
  const props: ReviewCanvasProps = {
    pullRequest: {
      repository: "relay/web",
      number: "463",
      title: "Move stage sync into a shared worker",
      sourceBranch: "stage-sync-worker",
      destinationBranch: "main"
    },
    reading: {
      graph: overrides.graph ?? { _tag: "Ready", graph: sampleGraph },
      context: overrides.context ?? sampleContext
    },
    findings: sampleFindings,
    review: { reviewer: "sec-cc", completedAt: Date.UTC(2026, 9, 16, 14, 22) },
    checks: { _tag: "Ready", failed: ["unit-tests"] },
    state: { ...start, ...overrides.state },
    onCommand: () => undefined,
    text: overrides.text ?? { _tag: "Loading" },
    hrefs: { code: "#code", pullRequests: "#code/pull-requests", file: (path) => `#diff/${path}` },
    handled: new Set(),
    onToggleHandled: () => undefined,
    timeZone: "UTC"
  }
  return renderToStaticMarkup(<ReviewCanvas {...props} />)
}

describe("ReviewCanvas", () => {
  it("draws the overview with every file, the legend and the minimap", () => {
    const markup = render()
    expect(markup.match(/data-canvas-node=/gu)).toHaveLength(14)
    expect(markup).toContain(
      'aria-label="socket.ts, sync-worker, partition A, +142 −0, high risk, P1, changed since you looked"'
    )
    expect(markup).toContain('data-canvas-part="legend"')
    expect(markup).toContain("Map, Overview")
    expect(markup).toContain("1 check failed")
    expect(markup).toContain("sec-cc review, 14:22: 1 P1, 2 P2, 1 P3")
    expect(markup).toContain("You looked at 13:20. 2 commits since, 4 files changed.")
  })

  it("swaps the legend for the key panel while the keyboard drives the overview", () => {
    const markup = render({ state: { keyboard: true } })
    expect(markup).toContain('data-canvas-part="keys"')
    expect(markup).not.toContain('data-canvas-part="legend"')
    expect(markup).toContain("4 edges:")
  })

  it("lists the files and disables zoom while the map builds", () => {
    const markup = render({
      graph: { _tag: "Building", headRevision: "e81f0c9", placed: 9, total: 14, files: sampleGraph.files }
    })
    expect(markup).toContain("Files, 14")
    expect(markup).toContain("Building the map: reading call and import relations, 9 of 14 files")
    expect(markup).toContain('aria-disabled="true"')
    expect(markup).not.toContain("data-canvas-node=")
  })

  it("explains missing dependency data instead of drawing no edges", () => {
    const markup = render({
      graph: { _tag: "Ready", graph: { ...sampleGraph, dependencies: { _tag: "NotRecorded", language: "TypeScript" } } }
    })
    expect(markup).toContain("there’s no dependency data for TypeScript in relay/web yet")
    expect(markup).toContain("No edges or partitions: dependency data missing")
  })

  it("shows a part's head lines with the finding card after its line", () => {
    const lines = Array.from({ length: 60 }, (_, index) => ({
      number: index + 1,
      text: `line ${index + 1}`,
      added: true
    }))
    const markup = render({
      state: { level: "diff", part: "connect()" },
      text: { _tag: "Ready", readAt: Date.UTC(2026, 9, 16, 14, 24), headCommit: "e81f0c9", lines }
    })
    expect(textOf(markup)).toContain("Diff read 14:24, head “Commit title unavailable”")
    expect(textOf(markup)).not.toContain("e81f0c9")
    expect(markup).toContain('title="Commit e81f0c9"')
    expect(markup).toContain('aria-label="Finding F1, between lines 16 and 17"')
    expect(markup.indexOf("Added line 16")).toBeLessThan(markup.indexOf("Finding F1"))
    expect(markup.indexOf("Finding F1")).toBeLessThan(markup.indexOf("Added line 17"))
    expect(markup).toContain("Mark handled")
  })

  it("names the commits a still-open finding was raised on and is open at, ids in tooltips only", () => {
    const lines = Array.from({ length: 60 }, (_, index) => ({
      number: index + 1,
      text: `line ${index + 1}`,
      added: true
    }))
    const markup = render({
      graph: { _tag: "Ready", graph: { ...sampleGraph, headRevision: "e81f0c9".padEnd(40, "0") } },
      context: {
        ...sampleContext,
        findings: {
          _tag: "Recorded",
          notes: {
            F1: {
              life: { _tag: "StillOpen", raisedAt: Date.UTC(2026, 9, 16, 11, 40), raisedHead: "7d2e1b4" },
              evidence: null
            }
          }
        }
      },
      state: { level: "diff", part: "connect()" },
      text: { _tag: "Ready", readAt: Date.UTC(2026, 9, 16, 14, 24), headCommit: "e81f0c9", lines }
    })
    expect(textOf(markup)).toContain(
      "Raised 11:40 on “Commit title unavailable”, still open at “Commit title unavailable”"
    )
    expect(textOf(markup)).not.toMatch(/7d2e1b4|e81f0c9/u)
    expect(markup).toContain('title="Commit 7d2e1b4"')
    expect(markup).toContain(`title="Commit ${"e81f0c9".padEnd(40, "0")}"`)
  })

  it("says when the lines cannot be read", () => {
    const markup = render({
      state: { level: "diff", part: "connect()" },
      text: { _tag: "Unavailable", message: "Lines unavailable." }
    })
    expect(markup).toContain("Lines unavailable.")
  })
})
