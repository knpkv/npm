// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DiffFinding, type RlyDiffFinding, type RlyDiffFindingPrevention } from "../../src/diff/DiffFinding.js"
import { render } from "../primitives/render.js"

const currentFinding = {
  anchor: {
    contextHash: "ctx-66f31",
    fileId: "authorize",
    line: 84,
    path: "src/payments/authorize.ts",
    revision: "8fa21c7",
    side: "after",
    state: "current"
  },
  authorName: "Relay reviewer",
  body: "The retry branch can authorize the same payment twice.",
  id: "finding-1",
  prevention: {
    boundary: "Exclude generated provider clients.",
    enforcement: "eslint",
    existingRuleOrConfig: "local-rules/no-retry-key-replacement",
    invalidFixture: "A retry creates a new idempotency key inside the callback.",
    matcherOrInvariant: "A retry callback must reuse the operation key captured outside the callback.",
    sourcePaths: ["packages/payments/src/**"],
    summary: "Reject retry callbacks that replace an immutable operation key.",
    targetFile: "eslint-local-rules.cjs",
    validFixture: "A retry reuses the key captured before the callback."
  },
  severity: "critical",
  source: "agent",
  status: "open",
  title: "Idempotency key is not reused"
} satisfies RlyDiffFinding

const staleFinding = {
  ...currentFinding,
  anchor: {
    ...currentFinding.anchor,
    currentRevision: "91bd221",
    reason: "PR head changed after this finding was recorded.",
    state: "stale"
  },
  authorName: "Mina Chen",
  id: "finding-2",
  source: "human",
  status: "resolved"
} satisfies RlyDiffFinding

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("DiffFinding", () => {
  it("distinguishes human and agent authors while preserving immutable anchor evidence", () => {
    const gallery = render(
      <main>
        <DiffFinding finding={currentFinding} onAnchorActivate={() => undefined} />
        <DiffFinding finding={staleFinding} onAnchorActivate={() => undefined} />
      </main>
    )
    expect(gallery?.querySelector("[data-rly-diff-finding-source='agent']")?.textContent).toContain(
      "Agent finding · not an approval"
    )
    expect(gallery?.querySelector("[data-rly-diff-finding-source='human']")?.textContent).toContain("Human finding")
    expect(gallery?.textContent).toContain("8fa21c7")
    expect(gallery?.textContent).toContain("ctx-66f31")
    expect(gallery?.textContent).toContain("91bd221")
    expect(gallery?.querySelector("[data-rly-diff-finding-prevention='eslint']")?.textContent).toContain(
      "Prevent recurrence"
    )
    expect(gallery?.textContent).toContain("ESLint")
    expect(gallery?.textContent).not.toContain(">eslint<")
  })

  it("activates only current anchors and keeps stale reasons visible", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const onAnchorActivate = vi.fn()
    await act(async () =>
      root.render(
        <main>
          <DiffFinding finding={currentFinding} onAnchorActivate={onAnchorActivate} />
          <DiffFinding finding={staleFinding} onAnchorActivate={onAnchorActivate} />
        </main>
      )
    )
    const currentButton = host.querySelector<HTMLButtonElement>("[data-rly-diff-finding-anchor='current'] button")
    await act(async () => currentButton?.click())
    expect(onAnchorActivate).toHaveBeenCalledOnce()
    expect(onAnchorActivate).toHaveBeenCalledWith("finding-1")
    expect(host.querySelector("[data-rly-diff-finding-anchor='stale'] button")).toBeNull()
    expect(host.querySelector("[data-rly-diff-finding-anchor='stale']")?.textContent).toContain(
      "PR head changed after this finding was recorded."
    )
    await act(async () => root.unmount())
  })

  it("rejects invalid line and blank stale reasons", () => {
    expect(() =>
      renderToStaticMarkup(
        <DiffFinding
          finding={{ ...currentFinding, anchor: { ...currentFinding.anchor, line: 0 } }}
          onAnchorActivate={() => undefined}
        />
      )
    ).toThrow("line must be a positive integer")
    expect(() =>
      renderToStaticMarkup(
        <DiffFinding
          finding={{ ...staleFinding, anchor: { ...staleFinding.anchor, reason: " " } }}
          onAnchorActivate={() => undefined}
        />
      )
    ).toThrow("stale anchor reason")
    expect(() =>
      renderToStaticMarkup(
        <DiffFinding
          finding={{
            ...currentFinding,
            prevention: { ...currentFinding.prevention, sourcePaths: [] }
          }}
          onAnchorActivate={() => undefined}
        />
      )
    ).toThrow("prevention sourcePaths")
    expect(() =>
      renderToStaticMarkup(
        <DiffFinding
          finding={{
            ...currentFinding,
            prevention: { enforcement: "none", rationale: " ", summary: "Requires domain judgment." }
          }}
          onAnchorActivate={() => undefined}
        />
      )
    ).toThrow("prevention rationale")
  })

  it("requires prevention for agents and presents every enforcement label", () => {
    // @ts-expect-error Agent findings require an explicit prevention plan.
    const agentFindingWithoutPrevention: RlyDiffFinding = {
      ...currentFinding,
      prevention: undefined
    }
    expect(() =>
      renderToStaticMarkup(<DiffFinding finding={agentFindingWithoutPrevention} onAnchorActivate={() => undefined} />)
    ).toThrow("agent findings require a prevention plan")

    const automatedPlan = currentFinding.prevention
    const plansAndLabels = [
      [{ ...automatedPlan, enforcement: "ast-grep" }, "ast-grep"],
      [{ ...automatedPlan, enforcement: "eslint" }, "ESLint"],
      [{ ...automatedPlan, enforcement: "instruction" }, "Agent instruction"],
      [{ ...automatedPlan, enforcement: "test" }, "Test"],
      [{ ...automatedPlan, enforcement: "type-check" }, "Type check"],
      [
        { enforcement: "none", rationale: "This invariant requires domain judgment.", summary: "Review manually." },
        "Human judgment"
      ]
    ] satisfies ReadonlyArray<readonly [RlyDiffFindingPrevention, string]>
    for (const [plan, label] of plansAndLabels) {
      const markup = renderToStaticMarkup(
        <DiffFinding finding={{ ...currentFinding, prevention: plan }} onAnchorActivate={() => undefined} />
      )
      expect(markup).toContain(label)
    }
  })
})
