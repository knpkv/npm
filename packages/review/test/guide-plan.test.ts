import { parsePatch, type Patch } from "@knpkv/rly/diff/patch"
import assert from "node:assert/strict"
import { test } from "vitest"
import type { Guide, Issue } from "../src/guide/model.js"
import { anchor, coverageProblems, sectionSeverity } from "../src/guide/plan.js"

/** Unwrap a patch these tests expect to be well formed. */
const parsed = (text: string): Patch => {
  const result = parsePatch(text)
  if (result._tag === "PatchInvalid") throw new Error(`unexpected invalid patch: ${result.reason}`)
  return result.patch
}

const patch = parsed(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,3 @@
 keep
-old
+new
 keep
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-x
+y
`)

const guide = (sections: Guide["sections"], unplaced: Array<string> = []): Guide => ({
  title: "t",
  intent: "i",
  sections,
  unplacedFiles: unplaced,
  review: { gitRef: "HEAD" }
})

const issue = (over: Partial<Issue>): Issue => ({
  id: 1,
  severity: "P2",
  file: "src/a.ts",
  summary: "s",
  ...over
})

test("coverage: every file once, no unknown files, unique issue ids", () => {
  const ok = guide([{ title: "A", overview: "", diffs: [{ file: "src/a.ts", summary: "" }] }], [
    "src/b.ts"
  ])
  assert.deepEqual(coverageProblems(ok, patch, { checklist: [], issues: [] }), [])

  const bad = guide([
    { title: "A", overview: "", diffs: [{ file: "src/a.ts", summary: "" }, { file: "src/c.ts", summary: "" }] },
    { title: "B", overview: "", diffs: [{ file: "src/a.ts", summary: "" }] }
  ])
  const problems = coverageProblems(bad, patch, {
    checklist: [],
    issues: [issue({ id: 1 }), issue({ id: 1 })]
  })
  assert.deepEqual(problems, [
    "\"src/c.ts\" (section 1 \"A\") is not in the patch",
    "\"src/a.ts\" is placed more than once: section 1 \"A\", section 2 \"B\"",
    "\"src/b.ts\" is in the patch but in no section",
    "Issue 1 appears twice in findings"
  ])
})

test("anchor: new side by default, old side on request, general otherwise", () => {
  assert.equal(anchor(patch, issue({ line: 11 })).kind, "anchored")
  const oldSide = anchor(patch, issue({ line: 11, side: "old" }))
  assert.equal(oldSide.kind, "anchored")
  assert.equal(oldSide.kind === "anchored" && oldSide.side, "old")
  assert.deepEqual(anchor(patch, issue({ line: 99 })), {
    kind: "general",
    issue: issue({ line: 99 }),
    reason: "outside-hunks"
  })
  const noLine = anchor(patch, issue({}))
  assert.equal(noLine.kind === "general" ? noLine.reason : noLine.kind, "no-line")
  assert.equal(anchor(patch, issue({ file: "nope.ts", line: 1 })).kind === "general", true)
})

test("section badge is the worst anchored severity among its files", () => {
  const section = { title: "A", overview: "", diffs: [{ file: "src/a.ts", summary: "" }] }
  const placed = [
    anchor(patch, issue({ id: 1, line: 11, severity: "P3" })),
    anchor(patch, issue({ id: 2, line: 12, severity: "P1" })),
    anchor(patch, issue({ id: 3, line: 99, severity: "P1" })), // general, does not count
    anchor(patch, issue({ id: 4, file: "src/b.ts", line: 1, severity: "P1" })) // other file
  ]
  assert.equal(sectionSeverity(section, placed, patch), "P1")
  assert.equal(sectionSeverity(section, [placed[0]!], patch), "P3")
  assert.equal(sectionSeverity(section, [placed[2]!], patch), undefined)
})
