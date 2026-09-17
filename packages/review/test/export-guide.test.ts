import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { exportGuide } from "../dist/guide/export.js"

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
      { guide, patch: patch.replace("+if (approved) ship()\n", ""), stage: "patch" }
    ]
    for (const input of inputs) {
      const error = yield* Effect.flip(exportGuide(input))
      expect(error._tag).toBe("GuideExportError")
      expect(error.stage).toBe(input.stage)
    }
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
