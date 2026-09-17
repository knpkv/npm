import * as Schema from "effect/Schema"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { type Patch, parsePatch } from "@knpkv/rly/diff/patch"
import type { Findings, Guide } from "../src/guide/model.js"
import { Issue, Usage } from "../src/guide/model.js"
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
  it("retains the source and destination of copies and renames", () => {
    for (const status of ["copy", "rename"]) {
      const moved = parsed(
        `diff --git a/source.txt b/copy.txt\nsimilarity index 100%\n${status} from source.txt\n${status} to copy.txt\n`
      )
      const html = renderToStaticMarkup(
        <GuidePage
          guide={{ ...guide, sections: [{ title: "Moved", overview: "", diffs: [{ file: "copy.txt", summary: "" }] }] }}
          patch={moved}
          findings={{ checklist: [], issues: [] }}
        />
      )
      expect(html).toContain("source.txt → copy.txt</code>")
    }
    const html = renderToStaticMarkup(<GuidePage guide={guide} patch={patch} findings={findings} />)
    expect(html).toContain(">a.ts</code>")
    expect(html).not.toContain("a.ts → a.ts")
  })
  it("preserves supplied cost precision without confusing a small charge with zero", () => {
    for (const [currency, amount, displayed] of [
      ["USD", 0, "USD 0"],
      ["USD", 0.001, "USD 0.001"],
      ["USD", 0.12, "USD 0.12"],
      ["KWD", 1.234, "KWD 1.234"],
      ["USD", 1e-25, "USD 1e-25"]
    ] satisfies Array<[string, number, string]>) {
      const html = renderToStaticMarkup(
        <GuideUsage
          usage={[
            { label: "Recorded run", scope: "review", source: "receipt", cost: { currency, amount, basis: "reported" } }
          ]}
        />
      )
      expect(html).toContain(`${displayed} · reported`)
    }
  })
  it("keeps pre-existing context and open questions in separately labelled groups", () => {
    const render = (context: Pick<Findings, "preExisting" | "openQuestions">) =>
      renderToStaticMarkup(<GuidePage guide={guide} patch={patch} findings={{ ...findings, ...context }} />)
    const html = render({ preExisting: ["Existing constraint"], openQuestions: ["Unresolved question?"] })
    const existing = html.split('aria-labelledby="pre-existing"')[1]?.split("</section>")[0]
    const questions = html.split('aria-labelledby="open-questions"')[1]?.split("</section>")[0]
    expect(existing).toContain("Existing constraint")
    expect(existing).not.toContain("Unresolved question?")
    expect(questions).toContain("Unresolved question?")
    expect(questions).not.toContain("Existing constraint")
    expect(render({ preExisting: ["Existing constraint"] })).not.toContain('id="open-questions"')
    expect(render({ openQuestions: ["Unresolved question?"] })).not.toContain('id="pre-existing"')
  })
  it("identifies source pull requests with their supplied title or number", () => {
    const render = (source: Guide["source"]) =>
      renderToStaticMarkup(<GuidePage guide={{ ...guide, source }} patch={patch} findings={findings} />)
    const pr = { url: "https://example.invalid/pull/7", title: "Signed release approval" }
    expect(render({ pr })).toContain(">Signed release approval</a>")
    expect(render({ pr: { ...pr, number: 7 } })).toContain("PR 7")
    expect(render({ pr: { url: pr.url } })).toContain(">Source pull request</a>")
    expect(render({ pr: { ...pr, title: "  " } })).toContain(">Source pull request</a>")
    expect(render(undefined)).not.toContain(pr.url)
  })
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
    expect(html).toContain("USD 0 · reported")
    expect(html).toContain("USD 328.2407 · estimated")
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

it("rejects impossible cached counts while allowing unknown totals", () => {
  const base = { label: "Review", scope: "review", source: "receipt" }
  expect(Schema.is(Usage)({ ...base, inputTokens: 1000, cachedInputTokens: 1001 })).toBe(false)
  expect(Schema.is(Usage)({ ...base, inputTokens: 1000, cachedInputTokens: 800 })).toBe(true)
  expect(Schema.is(Usage)({ ...base, cachedInputTokens: 1001 })).toBe(true)
})

it("requires positive integral source coordinates, including lines outside the hunks", () => {
  const base = { id: 1, severity: "P2", file: "a.ts", summary: "Check signature" }
  for (const line of [0, -1, 1.5]) expect(Schema.is(Issue)({ ...base, line })).toBe(false)
  for (const line of [1, 99]) expect(Schema.is(Issue)({ ...base, line })).toBe(true)
  expect(placeAll(patch, findings)[1]).toMatchObject({ kind: "general", reason: "outside-hunks" })
})

it("status replaces obsolete fix instructions, while unresolved findings retain them", () => {
  const issue = {
    id: 1,
    severity: "P2",
    file: "a.ts",
    summary: "Check signature",
    recommendation: "Compare both revisions."
  } satisfies Issue
  const render = (finding: Issue) =>
    renderToStaticMarkup(<GuidePage guide={guide} patch={patch} findings={{ checklist: [], issues: [finding] }} />)
  expect(render(issue)).toContain("Compare both revisions.")
  expect(render({ ...issue, status: "Resolved" })).toContain("Resolved")
  expect(render({ ...issue, status: "Resolved" })).not.toContain("Compare both revisions.")
  expect(render({ ...issue, status: "Resolved" })).not.toContain(">Fix<")
})
