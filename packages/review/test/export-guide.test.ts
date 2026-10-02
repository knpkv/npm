import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Window } from "happy-dom"
import { exportGuide } from "../dist/guide/export.js"
import { Findings, Guide } from "../src/guide/model.js"

const guide = {
  title: "Guard </script><script>alert(1)</script>",
  intent: "Require **signed evidence**.",
  sections: [{
    title: "Release gate",
    overview: "> [!IMPORTANT]\n> Check the revision.",
    diffs: [{ file: "release.ts", summary: "Require approval." }]
  }],
  unplacedFiles: [],
  review: { gitRef: "abc" }
}
const patch =
  "diff --git a/release.ts b/release.ts\n--- a/release.ts\n+++ b/release.ts\n@@ -1 +1 @@\n-ship()\n+if (approved) ship()\n"

it.effect("exports offline assets and escapes executable input", () =>
  Effect.gen(function*() {
    const page = yield* exportGuide({ guide, patch })
    expect(page.files).toBe(1)
    expect(page.html).toContain("data:font/woff2;base64,")
    expect(page.html).not.toMatch(/<script[^>]+src=/)
    expect(page.html).not.toContain("<script>alert(1)</script>")
    expect(page.html).toContain("\\u003c/script>")
    expect(page.html).toContain("data-rly-patch-diff")
  }))

it.effect("reports malformed input, coverage, and patch failures through the typed channel", () =>
  Effect.gen(function*() {
    const inputs = [
      { guide, patch, findings: null, stage: "input" },
      { guide: { ...guide, title: 42 }, patch, stage: "input" },
      { guide: { ...guide, source: { pr: { url: "javascript:alert(1)" } } }, patch, stage: "input" },
      { guide: { ...guide, sections: [] }, patch, stage: "coverage" },
      { guide, patch: patch.replace("--- a/release.ts\n+++ b/release.ts\n", ""), stage: "patch" },
      { guide, patch: patch.replace("+if (approved) ship()\n", ""), stage: "patch" },
      { guide, patch: patch.slice(0, -1), stage: "patch" },
      { guide, patch: patch.replace("@@ -1 +1 @@", "@@ -0 +1 @@"), stage: "patch" },
      { guide, patch: patch.replace("@@ -1 +1 @@", "@@ -1 +0 @@"), stage: "patch" }
    ]
    for (const input of inputs) {
      const error = yield* Effect.flip(exportGuide(input))
      expect(error._tag).toBe("GuideExportError")
      expect(error.stage).toBe(input.stage)
    }
  }))

it.effect("rejects invalid outer JavaScript input through the typed input error", () =>
  Effect.gen(function*() {
    for (const input of [null, undefined, 42, "invalid"]) {
      // @ts-expect-error Exercise the untyped JavaScript caller boundary.
      const error = yield* Effect.flip(exportGuide(input))
      expect(error._tag).toBe("GuideExportError")
      expect(error.stage).toBe("input")
    }
    expect((yield* exportGuide({ guide, patch })).files).toBe(1)
  }))

it.effect("rejects malformed JavaScript prefix options before parsing or serializing", () =>
  Effect.gen(function*() {
    for (const prefixes of [null, { source: "a/" }]) {
      // @ts-expect-error Exercise the untyped JavaScript caller boundary.
      const error = yield* Effect.flip(exportGuide({ guide, patch, prefixes }))
      expect(error._tag).toBe("GuideExportError")
      expect(error.stage).toBe("input")
    }
  }))

it.effect("rejects non-string JavaScript patches through the typed input error", () =>
  Effect.gen(function*() {
    for (const invalidPatch of [null, 42]) {
      // @ts-expect-error Exercise the untyped JavaScript caller boundary.
      const error = yield* Effect.flip(exportGuide({ guide, patch: invalidPatch }))
      expect(error._tag).toBe("GuideExportError")
      expect(error.stage).toBe("input")
    }
    expect((yield* exportGuide({ guide, patch })).files).toBe(1)
    const malformed = yield* Effect.flip(exportGuide({ guide, patch: patch.slice(0, -1) }))
    expect(malformed.stage).toBe("patch")
  }))

it.effect("retains explicit no-prefix mode in exported paths and hydration input", () =>
  Effect.gen(function*() {
    const prefixes = { source: "", destination: "" }
    const page = yield* exportGuide({
      guide: { ...guide, sections: [{ title: "Rename", overview: "", diffs: [{ file: "b/file.txt", summary: "" }] }] },
      patch: "diff --git a/file.txt b/file.txt\nrename from a/file.txt\nrename to b/file.txt\n",
      prefixes
    })
    expect(page.html).toContain("a/file.txt → b/file.txt</code>")
    expect(page.html).toContain("\"prefixes\":{\"source\":\"\",\"destination\":\"\"}")
  }))

it.effect("includes offline diagram support only for guides containing Mermaid", () =>
  Effect.gen(function*() {
    const plain = yield* exportGuide({ guide, patch })
    const diagram = yield* exportGuide({ guide: { ...guide, intent: "```mermaid\nflowchart LR\nA-->B\n```" }, patch })
    expect(diagram.html.length).toBeGreaterThan(plain.html.length)
    expect(diagram.html).toContain("class=\"mermaid\"")
    expect(diagram.html).not.toMatch(/<script[^>]+src=/)
  }))

it.effect("exports custom-prefix paths and retains options for hydration", () =>
  Effect.gen(function*() {
    const prefixes = { source: "old/tree/", destination: "new/tree/" }
    const page = yield* exportGuide({
      guide,
      patch: patch.replaceAll("a/release.ts", "old/tree/release.ts").replaceAll("b/release.ts", "new/tree/release.ts"),
      prefixes
    })
    expect(page.files).toBe(1)
    expect(page.html).toContain("\"prefixes\":{\"source\":\"old/tree/\",\"destination\":\"new/tree/\"}")
  }))

it.effect("rejects non-JSON-safe issue IDs before export and decodes accepted hydration data", () =>
  Effect.gen(function*() {
    const issue = { id: 1, severity: "P2", file: "release.ts", summary: "Check evidence" }
    for (const id of [NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const error = yield* Effect.flip(
        exportGuide({ guide, patch, findings: { checklist: [], issues: [{ ...issue, id }] } })
      )
      expect(error.stage).toBe("input")
    }
    const page = yield* exportGuide({ guide, patch, findings: { checklist: [], issues: [issue] } })
    const payload = page.html.match(/<script id="review-data" type="application\/json">(.*?)<\/script>/)?.[1]
    if (payload === undefined) throw new TypeError("Missing exported hydration data")
    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ findings: Findings })))(payload)
    expect(decoded.findings.issues[0]?.id).toBe(1)
  }))

it.effect("keeps the standalone export document reset", () =>
  Effect.gen(function*() {
    const exported = yield* exportGuide({ guide, patch })
    const page = new Window()
    try {
      const style = exported.html.match(/<style>(.*?)<\/style>/s)?.[1]
      if (style === undefined) throw new TypeError("Missing exported stylesheet")
      page.document.head.innerHTML = `<style>body { margin: 23px; }</style><style>${style}</style>`
      page.document.body.innerHTML = "<main class=\"review-guide\">Standalone guide</main>"
      expect(page.getComputedStyle(page.document.body).marginTop).toBe("0px")
    } finally {
      yield* Effect.promise(() => page.happyDOM.close())
    }
  }))

it.effect("rejects unsafe PR numbers and preserves provider-native identifiers through JSON hydration", () =>
  Effect.gen(function*() {
    for (const number of [NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const error = yield* Effect.flip(
        exportGuide({ guide: { ...guide, source: { pr: { url: "https://example.test/pr", number } } }, patch })
      )
      expect(error.stage).toBe("input")
    }
    for (const number of [1, Number.MAX_SAFE_INTEGER, "001", "team/repo!42", "change:α-7"]) {
      const page = yield* exportGuide({
        guide: { ...guide, source: { pr: { url: "https://example.test/pr", number } } },
        patch,
        findings: {
          checklist: [],
          issues: [{ id: 1, severity: "P2", file: "release.ts", line: 1, summary: "Evidence" }]
        }
      })
      const payload = page.html.match(/<script id="review-data" type="application\/json">(.*?)<\/script>/)?.[1]
      if (payload === undefined) throw new TypeError("Missing hydration data")
      const decoded = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ guide: Guide, findings: Findings }))
      )(payload)
      expect(decoded.guide.source?.pr?.number).toBe(number)
      expect(decoded.findings.issues[0]).toMatchObject({ id: 1, line: 1 })
    }
  }))

it("ships the documented embedded diagram initializer as a self-contained package export", async () => {
  const diagrams = await import("@knpkv/review/guide/diagrams")
  expect(diagrams.mountGuideDiagrams).toBeTypeOf("function")
})

it.effect("exports ordered-list starting numbers before client hydration", () =>
  Effect.gen(function*() {
    const page = yield* exportGuide({ guide: { ...guide, intent: "3. Deploy canary\n4. Expand rollout" }, patch })
    const window = new Window()
    try {
      window.document.body.innerHTML = page.html
      expect(window.document.querySelector(".review-prose ol")?.getAttribute("start")).toBe("3")
      expect([...window.document.querySelectorAll(".review-prose ol > li")].map((item) => item.textContent)).toEqual([
        "Deploy canary",
        "Expand rollout"
      ])
    } finally {
      window.close()
    }
  }))
