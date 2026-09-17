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

test("rejects non-UTF-8 path identities while preserving valid octal UTF-8", () => {
  const file = (name: string) =>
    `diff --git "a/${name}" "b/${name}"\n--- "a/${name}"\n+++ "b/${name}"\n@@ -1 +1 @@\n-old\n+new\n`
  assert.equal(parsePatch(file("\\376") + file("\\377"))._tag, "PatchInvalid")
  assert.equal(parsed(file("\\303\\251.ts")).files[0]?.path, "é.ts")
  const moved = parsed(
    "diff --git \"a/\\357\\273\\277source\" b/destination\nsimilarity index 100%\nrename from \"\\357\\273\\277source\"\nrename to destination\n"
  )
  assert.equal(moved.files[0]?.oldPath, "\uFEFFsource")
})

test("rejects surplus body records and misplaced no-newline markers", () => {
  const header = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n"
  for (
    const body of [
      "-old\n+new\n hidden\n",
      "\\ No newline at end of file\n-old\n+new\n",
      "-old\n\\ arbitrary text\n+new\n",
      "-old\n+new\n\\ arbitrary text\n",
      "-old\n+new\n\\ No newline at end of file\n\\ No newline at end of file\n"
    ]
  ) assert.equal(parsePatch(header + body)._tag, "PatchInvalid", body)
  assert.equal(
    parsePatch(header + "-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n")._tag,
    "Patch"
  )
  assert.equal(parsePatch("Subject: ordinary pre-diff metadata\n\n" + modified)._tag, "Patch")
})

test("rejects repeated coordinates on either side while allowing disjoint hunks", () => {
  const first = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n"
  for (const second of ["@@ -1 +2 @@", "@@ -2 +1 @@", "@@ -1 +1 @@"]) {
    assert.equal(parsePatch(first + second + "\n-old\n+new\n")._tag, "PatchInvalid")
  }
  assert.equal(parsePatch(first + "@@ -2 +2 @@\n-old\n+new\n")._tag, "Patch")
  assert.equal(parsePatch(first + "@@ -1,0 +2 @@\n+inserted\n")._tag, "Patch")
})

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

test("Git's tab terminator is not part of a path containing spaces", () => {
  const patch = parsed(`diff --git a/a b.txt b/a b.txt
--- a/a b.txt\t
+++ b/a b.txt\t
@@ -1 +1 @@
-old
+new
`)
  assert.equal(patch.files[0]?.path, "a b.txt")
  assert.equal(findFile(patch, "a b.txt")?.oldPath, "a b.txt")
})

test("quoted tabs in filenames remain part of the path", () => {
  const patch = parsed(`diff --git "a/a\\tb.txt" "b/a\\tb.txt"
--- "a/a\\tb.txt"
+++ "b/a\\tb.txt"
@@ -1 +1 @@
-old
+new
`)
  assert.equal(patch.files[0]?.path, "a\tb.txt")
})

test("a current path takes precedence over another file's rename alias", () => {
  const patch = parsed(`diff --git a/a.txt b/b.txt
similarity index 100%
rename from a.txt
rename to b.txt
diff --git a/a.txt b/a.txt
new file mode 100644
--- /dev/null
+++ b/a.txt
@@ -0,0 +1 @@
+replacement
`)
  assert.equal(findFile(patch, "a.txt")?.status, "added")
  assert.equal(findFile(patch, "b.txt")?.status, "renamed")
})

test("accepts no-prefix and explicit custom-prefix patches without changing canonical paths", () => {
  assert.deepEqual(
    parsed(modified.replaceAll("a/src/a.ts", "src/a.ts").replaceAll("b/src/a.ts", "src/a.ts")),
    parsed(modified)
  )
  const custom = modified.replaceAll("a/src/a.ts", "before/tree/src/a.ts").replaceAll(
    "b/src/a.ts",
    "after/tree/src/a.ts"
  )
  assert.deepEqual(parsePatch(custom, { source: "before/tree/", destination: "after/tree/" }), parsePatch(modified))
  assert.equal(parsePatch(modified.replace("+++ b/src/a.ts", "+++ b/wrong.ts"))._tag, "PatchInvalid")
  assert.equal(parsePatch("diff --git missing\n")._tag, "PatchInvalid")
})

test("normalizes CRLF patch records and still rejects incomplete hunks", () => {
  assert.deepEqual(parsePatch(modified.replaceAll("\n", "\r\n")), parsePatch(modified))
  assert.equal(parsePatch("diff --git a/a b/a\r\n--- a/a\r\n+++ b/a\r\n@@ -1 +1 @@\r\n-old\r\n")._tag, "PatchInvalid")
})

test("copies retain their source identity without treating it as a changed alias", () => {
  const copy = `diff --git a/source.txt b/copy.txt
similarity index 100%
copy from source.txt
copy to copy.txt
`
  const patch = parsed(copy)
  assert.equal(patch.files[0]?.status, "copied")
  assert.equal(patch.files[0]?.oldPath, "source.txt")
  assert.equal(findFile(patch, "copy.txt")?.path, "copy.txt")
  assert.equal(findFile(patch, "source.txt"), undefined)
  assert.equal(parsePatch(copy.replace("copy to copy.txt\n", ""))._tag, "PatchInvalid")
  const edited = parsed(copy + "--- a/source.txt\n+++ b/copy.txt\n@@ -1 +1 @@\n-old\n+new\n")
  assert.equal(edited.files[0]?.hunks.length, 1)
  assert.equal(parsed(copy + "Binary files a/source.txt and b/copy.txt differ\n").files[0]?.binary, true)
})

test("no-prefix names with spaces remain exact, including directories named a", () => {
  const patch = parsed(
    "diff --git a/my file.ts a/my file.ts\n--- a/my file.ts\t\n+++ a/my file.ts\t\n@@ -1 +1 @@\n-old\n+new\n"
  )
  assert.equal(patch.files[0]?.path, "a/my file.ts")
})

test("CR in source content survives an LF-encoded patch", () => {
  const patch = parsed("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\r\n+new\r\n")
  assert.equal(patch.files[0]?.hunks[0]?.lines[0]?.text, "old\r")
  assert.equal(patch.files[0]?.hunks[0]?.lines[1]?.text, "new\r")
})

test("paired markers identify different files in no-index patches", () => {
  const patch = parsed(
    "diff --git a/first.txt b/second.txt\n--- a/first.txt\n+++ b/second.txt\n@@ -1 +1 @@\n-old\n+new\n"
  )
  assert.equal(patch.files[0]?.oldPath, "first.txt")
  assert.equal(patch.files[0]?.newPath, "second.txt")
})
