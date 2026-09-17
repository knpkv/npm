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
