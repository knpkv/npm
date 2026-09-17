import * as Schema from "effect/Schema"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { type Patch, parsePatch } from "@knpkv/rly/diff/patch"
import type { Findings, Guide } from "../src/guide/model.js"
import { Usage } from "../src/guide/model.js"
import { coverageProblems, placeAll } from "../src/guide/plan.js"
import { GuidePage, GuideUsage } from "../src/guide/view.js"

/** Unwrap a patch these tests expect to be well formed. */
const parsed = (text: string): Patch => {
  const result = parsePatch(text)
  if (result._tag === "PatchInvalid") throw new Error(`unexpected invalid patch: ${result.reason}`)
  return result.patch
}

const patch = parsed(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10 +20 @@
-old
+new
`)
const guide: Guide = {
  title: "Guard releases",
  intent: "Unapproved releases could ship.\n\nRequire signed evidence.",
  sections: [
    {
      title: "Release gate",
      overview: "> [!IMPORTANT]\n> Check the revision before shipping.",
      diffs: [{ file: "a.ts", summary: "Require approval." }]
    }
  ],
  unplacedFiles: [],
  review: { gitRef: "abc" }
}
const findings: Findings = {
  checklist: [],
  issues: [
    {
      id: 1,
      severity: "P2",
      file: "a.ts",
      line: 20,
      summary: "Check signature",
      explanation: "A signed approval for A must not authorize **B**."
    },
    { id: 2, severity: "P1", file: "a.ts", line: 99, summary: "Outside" }
  ]
}

describe("guide", () => {
  it("places every finding or explains why it cannot anchor", () => {
    expect(placeAll(patch, findings).map((item) => item.kind)).toEqual(["anchored", "general"])
    const html = renderToStaticMarkup(<GuidePage guide={guide} patch={patch} findings={findings} />)
    expect(html).toContain("data-rly-root")
    expect(html).toContain("callout-important")
    expect(html).toContain("A signed approval for A must not authorize <strong>B</strong>.")
    expect(html.indexOf('id="issue-1"')).toBeGreaterThan(html.indexOf('id="f1-new-20"'))
    expect(html.indexOf('id="issue-2"')).toBeGreaterThan(html.indexOf('id="general"'))
    expect(html).toContain("line not in the diff")
  })
  it("rejects incomplete and duplicate coverage", () => {
    expect(coverageProblems({ ...guide, unplacedFiles: ["a.ts"] }, patch, findings)).toHaveLength(1)
    expect(coverageProblems({ ...guide, sections: [] }, patch, findings)).toHaveLength(1)
  })
  it("distinguishes zero cost from missing data and retains estimation evidence", () => {
    const html = renderToStaticMarkup(
      <GuideUsage
        usage={[
          {
            label: "Review run",
            scope: "review",
            source: "Provider usage receipt",
            inputTokens: 1000,
            cachedInputTokens: 800,
            durationMs: 125000,
            cost: { amount: 0, currency: "USD", basis: "reported" }
          },
          {
            label: "Guide run",
            scope: "guide",
            source: "Session estimate",
            cost: { amount: 328.2407, currency: "USD", basis: "estimated" }
          }
        ]}
      />
    )
    expect(html).toContain("USD 0.00 · reported")
    expect(html).toContain("USD 328.24 · estimated")
    expect(html).not.toContain("328.2407")
    expect(html).toContain("2m 5s")
    expect(html).toContain("Not recorded")
    expect(html).toContain("Provider usage receipt")
    expect(renderToStaticMarkup(<GuideUsage usage={undefined} />)).toContain("were not recorded")
  })
  it("rejects negative, fractional token counters and invalid costs", () => {
    const base = { label: "Review", scope: "review", source: "receipt" }
    for (const extra of [
      { inputTokens: -1 },
      { outputTokens: 1.5 },
      { durationMs: -1 },
      { cost: { amount: -1, currency: "USD", basis: "reported" } }
    ])
      expect(Schema.is(Usage)({ ...base, ...extra })).toBe(false)
  })
})
