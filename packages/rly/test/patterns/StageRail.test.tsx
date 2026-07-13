// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  RLY_STAGE_RAIL_DEFAULT_VARIANTS,
  RLY_STAGE_RAIL_VARIANTS,
  type RlyStage,
  StageRail
} from "../../src/patterns/StageRail.js"
import { render } from "../primitives/render.js"

const owner = { id: "avery", name: "Avery Diaz", role: "Deployment operator" }
const stages = [
  { id: "queued", name: "Queued", state: "Not started", tone: "neutral" },
  { id: "build", name: "Build", reason: "Compiling release artifacts.", state: "Building", tone: "progress" },
  { id: "verify", name: "Verify", owner, state: "Verified", tone: "positive" },
  { id: "approval", name: "Approval", state: "Held", tone: "caution" },
  { id: "production", name: "Production", state: "Blocked", tone: "critical" },
  { id: "complete", name: "Complete", state: "Ready", tone: "positive" }
] satisfies ReadonlyArray<RlyStage>

describe("StageRail", () => {
  it("renders a labelled section and complete semantic ordered list", () => {
    const rail = render(<StageRail heading="Release progression" stages={stages} />)
    if (rail === null) throw new Error("StageRail did not render")
    const heading = rail.querySelector("h2")
    const list = rail.querySelector("ol")
    if (heading === null || list === null) throw new Error("StageRail semantics did not render")

    expect(heading.textContent).toBe("Release progression")
    expect(rail.getAttribute("aria-labelledby")).toBe(heading.id)
    expect(list.querySelectorAll(":scope > li")).toHaveLength(6)
    expect(list.querySelectorAll("[data-rly-stage-connector]")).toHaveLength(5)
    expect(list.querySelectorAll("[data-rly-stage-id]")).toHaveLength(6)
    expect(rail.textContent).toContain("Avery Diaz")
    expect(rail.textContent).toContain("Deployment operator")
    for (const state of ["Not started", "Building", "Verified", "Held", "Blocked", "Ready"]) {
      expect(rail.textContent).toContain(state)
    }
  })

  it("renders an explicit empty state without an empty list", () => {
    const rail = render(<StageRail heading="Release progression" stages={[]} />)
    expect(rail?.textContent).toContain("No stages recorded.")
    expect(rail?.querySelector("ol")).toBeNull()

    const custom = render(<StageRail emptyLabel="No deployment stages available." heading="Deployment" stages={[]} />)
    expect(custom?.textContent).toContain("No deployment stages available.")
  })

  it("does not render a dangling connector for one stage", () => {
    const single = { id: "queued", name: "Queued", state: "Not started", tone: "neutral" } satisfies RlyStage
    const rail = render(<StageRail heading="Single stage" stages={[single]} />)
    expect(rail?.querySelectorAll("li")).toHaveLength(1)
    expect(rail?.querySelector("[data-rly-stage-connector]")).toBeNull()
  })

  it("keeps arbitrary twenty-stage lists complete", () => {
    const twenty = Array.from({ length: 20 }, (_, index) => ({
      id: `stage-${index + 1}`,
      name: `Stage ${index + 1}`,
      state: index === 19 ? "Complete" : "Queued",
      tone: index === 19 ? "positive" : "neutral"
    })) satisfies ReadonlyArray<RlyStage>
    const rail = render(<StageRail heading="Twenty-stage workflow" size="compact" stages={twenty} />)
    expect(rail?.querySelectorAll("[data-rly-stage-id]")).toHaveLength(20)
    expect(rail?.querySelectorAll("[data-rly-stage-connector]")).toHaveLength(19)
    expect(rail?.textContent).toContain("Stage 20")
  })

  it("publishes only meaningful density metadata", () => {
    expect(RLY_STAGE_RAIL_DEFAULT_VARIANTS).toEqual({ size: "default" })
    expect(Object.keys(RLY_STAGE_RAIL_VARIANTS.size)).toEqual(["compact", "default"])
    const compact = render(<StageRail heading="Compact" size="compact" stages={stages} />)
    expect(compact?.className).toContain(RLY_STAGE_RAIL_VARIANTS.size.compact.className)
  })

  it("rejects blank presentation fields and duplicate ids", () => {
    expect(() => renderToStaticMarkup(<StageRail heading=" " stages={[]} />)).toThrow("StageRail heading")
    expect(() => renderToStaticMarkup(<StageRail emptyLabel=" " heading="Stages" stages={[]} />)).toThrow(
      "StageRail emptyLabel"
    )
    expect(() =>
      renderToStaticMarkup(
        <StageRail heading="Stages" stages={[{ id: " ", name: "Build", state: "Ready", tone: "positive" }]} />
      )
    ).toThrow("StageRail stage id")
    expect(() =>
      renderToStaticMarkup(
        <StageRail heading="Stages" stages={[{ id: "build", name: " ", state: "Ready", tone: "positive" }]} />
      )
    ).toThrow("StageRail name")
    expect(() =>
      renderToStaticMarkup(
        <StageRail heading="Stages" stages={[{ id: "build", name: "Build", state: " ", tone: "positive" }]} />
      )
    ).toThrow("StageRail state")
    expect(() =>
      renderToStaticMarkup(
        <StageRail
          heading="Stages"
          stages={[{ id: "build", name: "Build", reason: " ", state: "Ready", tone: "positive" }]}
        />
      )
    ).toThrow("StageRail reason")
    const duplicate = { id: "duplicate", name: "Duplicate", state: "Queued", tone: "neutral" } satisfies RlyStage
    expect(() => renderToStaticMarkup(<StageRail heading="Stages" stages={[duplicate, duplicate]} />)).toThrow(
      "StageRail stage ids must be unique"
    )
  })
})
