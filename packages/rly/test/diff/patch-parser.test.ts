import assert from "node:assert/strict"
import { test } from "vitest"
import { findFile, parsePatch, type Patch } from "../../src/diff/patch/parse.js"

/** Unwrap a patch these tests expect to be well formed. */
const parsed = (text: string): Patch => {
  const result = parsePatch(text)
  if (result._tag === "PatchInvalid") assert.fail(`unexpected invalid patch: ${result.reason}`)
  return result.patch
}

const modified = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a, b };
 // end
@@ -20,2 +21,2 @@ function tail() {
-  return 1;
+  return 2;
 }
\\ No newline at end of file
`

test("numbers both sides of a hunk and keeps the second hunk's own starts", () => {
  const patch = parsed(modified)
  assert.equal(patch.files.length, 1)
  const file = patch.files[0]!
  assert.equal(file.status, "modified")
  assert.equal(file.hunks.length, 2)
  const [first, second] = file.hunks
  assert.deepEqual(
    first!.lines.map((line) => [line.kind, line.oldNo, line.newNo]),
    [
      ["context", 1, 1],
      ["del", 2, undefined],
      ["add", undefined, 2],
      ["add", undefined, 3],
      ["context", 3, 4],
      ["context", 4, 5]
    ]
  )
  assert.equal(second!.header, "function tail() {")
  assert.deepEqual(
    second!.lines.map((line) => [line.kind, line.oldNo, line.newNo]),
    [
      ["del", 20, undefined],
      ["add", undefined, 21],
      ["context", 21, 22]
    ]
  )
})

test("added, deleted, renamed and binary files", () => {
  const patch = parsed(`diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index e69de29..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old/name.ts b/new/name.ts
similarity index 100%
rename from old/name.ts
rename to new/name.ts
diff --git a/pic.png b/pic.png
index 1111111..2222222 100644
Binary files a/pic.png and b/pic.png differ
`)
  assert.deepEqual(
    patch.files.map((file) => [file.path, file.status, file.binary, file.hunks.length]),
    [
      ["new.txt", "added", false, 1],
      ["gone.txt", "deleted", false, 1],
      ["new/name.ts", "renamed", false, 0],
      ["pic.png", "modified", true, 0]
    ]
  )
  assert.equal(findFile(patch, "old/name.ts")?.newPath, "new/name.ts")
  assert.equal(findFile(patch, "missing.ts"), undefined)
})

test("an empty input is an empty patch", () => {
  assert.deepEqual(parsed(""), { files: [] })
})
