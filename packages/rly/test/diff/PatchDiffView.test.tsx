import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { type Patch, parsePatch, PatchDiffView } from "../../src/diff/patch/PatchDiffView.js"

const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -40,2 +70,2 @@ first
 keep
-old
+<new>
@@ -90 +120 @@ second
-gone
+added
`
/** Unwrap a patch these tests expect to be well formed. */
const parsed = (text: string): Patch => {
  const result = parsePatch(text)
  if (result._tag === "PatchInvalid") throw new Error(`unexpected invalid patch: ${result.reason}`)
  return result.patch
}

describe("PatchDiffView", () => {
  it("retains sparse source coordinates and side-specific annotations in both layouts", () => {
    const file = parsed(patch).files[0]
    expect(file).toBeDefined()
    if (file === undefined) return
    const modes: ReadonlyArray<"split" | "stacked"> = ["split", "stacked"]
    for (const mode of modes) {
      const html = renderToStaticMarkup(
        <PatchDiffView
          file={file}
          id="change"
          mode={mode}
          renderAnnotation={(side, line) => (side === "old" && line === 90 ? <aside>Deletion finding</aside> : null)}
        />
      )
      expect(html).toContain('id="change-new-120"')
      expect(html).toContain('id="change-old-90"')
      expect(html).toContain("&lt;new&gt;")
      expect(html.indexOf("Deletion finding")).toBeGreaterThan(html.indexOf('id="change-old-90"'))
      expect(html.match(/Deletion finding/g)).toHaveLength(1)
    }
  })
  it("rejects incomplete hunks instead of assigning findings to invented lines", () => {
    expect(parsePatch(patch.replace("+added\n", ""))._tag).toBe("PatchInvalid")
    expect(parsePatch("not a diff")._tag).toBe("PatchInvalid")
    expect(parsed("").files).toEqual([])
  })
  it("retains quoted paths, renames, deletions, and binary changes", () => {
    const quoted = parsed(`diff --git "a/space\\tname" "b/space\\tname"
deleted file mode 100644
--- "a/space\\tname"
+++ /dev/null
@@ -1 +0,0 @@
-old
diff --git a/old b/new
similarity index 100%
rename from old
rename to new
diff --git a/icon.png b/icon.png
Binary files a/icon.png and b/icon.png differ
`)
    expect(quoted.files.map((file) => [file.path, file.status, file.binary])).toEqual([
      ["space\tname", "deleted", false],
      ["new", "renamed", false],
      ["icon.png", "modified", true]
    ])
  })
})

it("shows newline absence on the affected sides without inventing source coordinates", () => {
  for (const body of [
    "-same\n\\ No newline at end of file\n+same\n",
    "-same\n+same\n\\ No newline at end of file\n",
    "-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
    " same\n\\ No newline at end of file\n"
  ]) {
    const file = parsed(`diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n${body}`).files[0]
    if (file === undefined) throw new TypeError("Missing fixture")
    for (const mode of ["split", "stacked"] satisfies ReadonlyArray<"split" | "stacked">) {
      const html = renderToStaticMarkup(<PatchDiffView file={file} id="eof" mode={mode} />)
      expect(html).toContain("No newline at end of file")
      expect(html).not.toContain('id="eof-old-2"')
      expect(html).not.toContain('id="eof-new-2"')
      const before = body.startsWith(" same") || body.includes("-same\n\\") || body.includes("-old\n\\")
      const after =
        body.startsWith(" same") ||
        body.endsWith("+same\n\\ No newline at end of file\n") ||
        body.endsWith("+new\n\\ No newline at end of file\n")
      expect(html.includes("Before: no newline")).toBe(before)
      expect(html.includes("After: no newline")).toBe(after)
    }
  }
  const file = parsed(patch).files[0]
  if (file === undefined) throw new TypeError("Missing fixture")
  expect(renderToStaticMarkup(<PatchDiffView file={file} id="normal" />)).not.toContain("No newline at end of file")
})

it("shows supplied file modes for mode-only, content, addition, and deletion changes", () => {
  for (const body of ["", "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n"]) {
    const file = parsed(`diff --git a/a b/a\nold mode 100644\nnew mode 100755\n${body}`).files[0]
    if (file === undefined) throw new TypeError("Missing fixture")
    expect(file).toMatchObject({ oldMode: "100644", newMode: "100755" })
    const html = renderToStaticMarkup(<PatchDiffView file={file} id="mode" />)
    expect(html).toContain("100644 → 100755")
  }
  for (const header of ["new file", "deleted file"]) {
    const file = parsed(`diff --git a/a b/a\n${header} mode 100755\n`).files[0]
    if (file === undefined) throw new TypeError("Missing fixture")
    expect(renderToStaticMarkup(<PatchDiffView file={file} id="mode" />)).toContain(
      header === "new file" ? "Mode added: 100755" : "Mode removed: 100755"
    )
  }
  const file = parsed(patch).files[0]
  if (file === undefined) throw new TypeError("Missing fixture")
  expect(file).not.toHaveProperty("oldMode")
  expect(file).not.toHaveProperty("newMode")
  expect(renderToStaticMarkup(<PatchDiffView file={file} id="normal" />)).not.toContain("Mode")
})
