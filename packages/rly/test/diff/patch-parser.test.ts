import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { findFile, parsePatch, type Patch } from "../../src/diff/patch/parse.js"
import binarySummaries from "./git-binary-summaries.json" with { type: "json" }
import gitPatches from "./git-generated-patches.json" with { type: "json" }

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

test("accepts Git's marker-free default-prefix binary no-index comparison", () => {
  const directory = mkdtempSync(join(tmpdir(), "rly-no-index-binary-"))
  try {
    const bytes = Array.from({ length: 256 }, (_, index) => index)
    writeFileSync(join(directory, "old.bin"), Uint8Array.from(bytes))
    writeFileSync(join(directory, "new.bin"), Uint8Array.from(bytes.slice().reverse()))
    const git = spawnSync("git", ["diff", "--no-index", "--binary", "old.bin", "new.bin"], {
      cwd: directory,
      encoding: "utf8"
    })
    assert.equal(git.status, 1, git.stderr)
    assert.match(git.stdout, /^diff --git a\/old\.bin b\/new\.bin\n/)
    assert.match(git.stdout, /\nGIT binary patch\n/)
    assert.doesNotMatch(git.stdout, /\n--- |\n\+\+\+ |\n(?:rename|copy) (?:from|to) /)
    const result = parsePatch(git.stdout)
    assert.equal(result._tag, "Patch", result._tag === "PatchInvalid" ? result.reason : "")
    if (result._tag === "Patch") {
      assert.deepEqual(
        result.patch.files.map(({ binary, newPath, oldPath, path }) => ({
          oldPath,
          newPath,
          path,
          binary
        })),
        [{ oldPath: "old.bin", newPath: "new.bin", path: "new.bin", binary: true }]
      )
    }
    assert.equal(
      parsePatch(git.stdout.replace("a/old.bin b/new.bin", "left/old.bin right/new.bin"))._tag,
      "PatchInvalid"
    )
    assert.equal(parsePatch(git.stdout.replace("a/old.bin b/new.bin", "old.bin new.bin"))._tag, "PatchInvalid")
    const producers: ReadonlyArray<{
      readonly flags: ReadonlyArray<string>
      readonly source: string
      readonly destination: string
    }> = [
      { flags: ["--src-prefix=left/", "--dst-prefix=right/"], source: "left/", destination: "right/" },
      { flags: ["--no-prefix"], source: "", destination: "" }
    ]
    for (const { destination, flags, source } of producers) {
      const alternate = spawnSync("git", ["diff", "--no-index", "--binary", ...flags, "old.bin", "new.bin"], {
        cwd: directory,
        encoding: "utf8"
      })
      assert.equal(alternate.status, 1, alternate.stderr)
      assert.equal(parsePatch(alternate.stdout)._tag, "PatchInvalid")
      const explicit = parsePatch(alternate.stdout, { source, destination })
      assert.equal(explicit._tag, "Patch", explicit._tag === "PatchInvalid" ? explicit.reason : "")
      if (explicit._tag === "Patch") {
        assert.equal(explicit.patch.files[0]?.oldPath, "old.bin")
        assert.equal(explicit.patch.files[0]?.newPath, "new.bin")
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

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

/** Patch record terminators are required even when the source file itself has no final newline. */
test.each(["\n", "\r\n"])("requires a complete final patch record with %j endings", (ending) => {
  const header = "diff --git a/a b/a\n--- a/a\n+++ b/a\n"
  const complete = [
    header + "@@ -1 +1 @@\n-old\n+new\n",
    header + "@@ -1 +0,0 @@\n-old\n",
    header + "@@ -1,2 +1,2 @@\n-old\n+new\n tail\n",
    header + "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
    "diff --git a/a b/a\nold mode 100644\nnew mode 100755\n"
  ]
  for (const patch of complete) {
    const transported = patch.replaceAll("\n", ending)
    assert.deepEqual(parsePatch(transported), parsePatch(patch))
    assert.equal(parsePatch(transported)._tag, "Patch")
    expect.soft(parsePatch(transported.slice(0, -ending.length))._tag, patch).toBe("PatchInvalid")
    if (ending === "\r\n") expect.soft(parsePatch(transported.slice(0, -1))._tag, patch).toBe("PatchInvalid")
  }
  assert.deepEqual(parsed(""), { files: [] })
})

/** Only an empty side may use line zero; populated lines must retain positive coordinates. */
test("rejects nonempty zero-start ranges while retaining empty anchors on either side", () => {
  const header = "diff --git a/a b/a\n--- a/a\n+++ b/a\n"
  for (const range of ["-0 +1", "-1 +0", "-0,1 +1,1", "-1,1 +0,1", "-0,1 +0,1"]) {
    expect.soft(parsePatch(header + `@@ ${range} @@\n-old\n+new\n`)._tag, range).toBe("PatchInvalid")
  }
  for (const range of ["-0,2 +1,2", "-1,2 +0,2"]) {
    expect.soft(parsePatch(header + `@@ ${range} @@\n-old\n+new\n tail\n`)._tag, range).toBe("PatchInvalid")
  }
  for (const anchor of [0, 1]) {
    const insertion = parsed(header + `@@ -${anchor},0 +${anchor + 1} @@\n+new\n`)
    assert.deepEqual(insertion.files[0]?.hunks[0]?.lines, [{ kind: "add", text: "new", newNo: anchor + 1 }])
    const deletion = parsed(header + `@@ -${anchor + 1} +${anchor},0 @@\n-old\n`)
    assert.deepEqual(deletion.files[0]?.hunks[0]?.lines, [{ kind: "del", text: "old", oldNo: anchor + 1 }])
  }
  assert.equal(parsePatch(header + "@@ -1 +1 @@\n-old\n+new\n")._tag, "Patch")
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

test("explicit no-prefix mode retains paths that resemble default Git prefixes", () => {
  const rename =
    "diff --git a/file.txt b/file.txt\nsimilarity index 100%\nrename from a/file.txt\nrename to b/file.txt\n"
  const prefixes = { source: "", destination: "" }
  const result = parsePatch(rename, prefixes)
  assert.equal(result._tag, "Patch")
  if (result._tag !== "Patch") return
  assert.equal(result.patch.files[0]?.oldPath, "a/file.txt")
  assert.equal(result.patch.files[0]?.newPath, "b/file.txt")
  assert.equal(parsePatch(rename.replace("rename to b/file.txt", "rename to wrong.txt"), prefixes)._tag, "PatchInvalid")
  const text = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n"
  const explicit = parsePatch(text, prefixes)
  assert.equal(explicit._tag, "Patch")
  if (explicit._tag !== "Patch") return
  assert.equal(explicit.patch.files[0]?.oldPath, "a/file.txt")
  assert.equal(explicit.patch.files[0]?.newPath, "b/file.txt")
  assert.equal(parsed(text).files[0]?.path, "file.txt")
})

test("text hunks require both file markers while metadata-only records remain valid", () => {
  assert.equal(parsePatch("diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n")._tag, "PatchInvalid")
  assert.equal(parsePatch("diff --git a/a.txt b/a.txt\n@@ -0,0 +0,0 @@\n")._tag, "PatchInvalid")
  assert.equal(parsed(modified).files[0]?.hunks.length, 2)
  assert.equal(parsed("diff --git a/a.txt b/a.txt\nold mode 100644\nnew mode 100755\n").files[0]?.hunks.length, 0)
  assert.equal(parsed("diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n").files[0]?.status, "renamed")
  assert.equal(parsed("diff --git a/a.txt b/a.txt\nBinary files a/a.txt and b/a.txt differ\n").files[0]?.binary, true)
})

test.each([
  ["late markers", "@@ -1 +1 @@\n-old\n+new\n--- a/a.txt\n+++ b/a.txt\n"],
  ["missing source", "+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"],
  ["missing destination", "--- a/a.txt\n@@ -1 +1 @@\n-old\n+new\n"],
  ["conflicting source", "--- a/wrong.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"],
  ["conflicting destination", "+++ b/wrong.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"]
])("rejects %s instead of accepting repaired hunk headers", (_name, body) => {
  assert.equal(parsePatch(`diff --git a/a.txt b/a.txt\n${body}`)._tag, "PatchInvalid")
})

test("consistent repeated or reordered markers retain valid Git coordinates", () => {
  for (
    const markers of [
      "+++ b/a.txt\n--- a/a.txt\n",
      "--- a/a.txt\n+++ b/a.txt\n--- a/a.txt\n+++ b/a.txt\n"
    ]
  ) {
    const file = parsed(`diff --git a/a.txt b/a.txt\n${markers}@@ -1 +1 @@\n-old\n+new\n`).files[0]
    assert.equal(file?.path, "a.txt")
    assert.equal(file?.hunks[0]?.lines[1]?.newNo, 1)
  }
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

/** Git-generated fixtures cover -M/-C/--find-copies-harder, --binary, --no-renames and -B -M replacement output. */
test.each(gitPatches)("retains Git-generated $name changes", ({ diff, expected }) => {
  const files = parsed(diff).files
  assert.deepEqual(files.map(({ binary, path, status }) => [path, status, binary]), expected)
})

test("rejects duplicate canonical current paths, including differently quoted identities", () => {
  assert.equal(parsePatch(modified + modified)._tag, "PatchInvalid")
  const equivalent = modified.replaceAll("a/src/a.ts", "\"a/src/a.ts\"").replaceAll("b/src/a.ts", "\"b/src/a.ts\"")
  assert.equal(parsePatch(modified + equivalent)._tag, "PatchInvalid")
})

test.each([
  ["added with ordinary source", "new file mode 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"],
  [
    "deleted with ordinary destination",
    "deleted file mode 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"
  ],
  ["added then deleted", "new file mode 100644\ndeleted file mode 100644\n"],
  ["deleted then added", "deleted file mode 100644\nnew file mode 100644\n"],
  ["conflicting repeated mode", "new file mode 100644\nnew file mode 100755\n"],
  ["unpaired old mode", "old mode 100644\n"],
  ["unpaired new mode", "new mode 100755\n"],
  ["conflicting old mode", "old mode 100644\nold mode 100755\nnew mode 100755\n"],
  ["added with mode transition", "new file mode 100644\nold mode 100644\nnew mode 100755\n"],
  ["both sides null", "--- /dev/null\n+++ /dev/null\n@@ -0,0 +0,0 @@\n"],
  ["added with old-side lines", "new file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"],
  ["deleted with new-side lines", "deleted file mode 100644\n--- a/a.txt\n+++ /dev/null\n@@ -1 +1 @@\n-old\n+new\n"],
  ["header only", ""],
  ["index only", "index 1111111..2222222 100644\n"],
  ["markers without hunks", "--- a/a.txt\n+++ b/a.txt\n"],
  ["mode plus truncated text", "old mode 100644\nnew mode 100755\n--- a/a.txt\n+++ b/a.txt\n"]
])("rejects contradictory or truncated %s records", (_name, body) => {
  assert.equal(parsePatch(`diff --git a/a.txt b/a.txt\n${body}`)._tag, "PatchInvalid")
})

test.each(["Binary files a/a.txt and b/a.txt differ", "GIT binary patch"])(
  "rejects text mixed with %s in either order",
  (binary) => {
    const text = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n"
    for (const body of [binary + "\n" + text, text + binary + "\n", binary + "\n--- a/a.txt\n+++ b/a.txt\n"]) {
      assert.equal(parsePatch(`diff --git a/a.txt b/a.txt\n${body}`)._tag, "PatchInvalid")
    }
  }
)

/** Invalid patch evidence must fail without allocating from attacker-supplied counts. */
test("rejects zero-record and unsafe hunks but retains safe boundary and zero-context insertions", () => {
  const header = "diff --git a/a b/a\n--- a/a\n+++ b/a\n"
  const invalid = [
    "@@ -1,0 +1,0 @@\n",
    "@@ -9007199254740992 +1 @@\n-old\n+new\n",
    "@@ -1 +9007199254740993 @@\n-old\n+new\n",
    "@@ -1,9007199254740992 +1 @@\n-old\n+new\n",
    "@@ -1 +1,9007199254740993 @@\n-old\n+new\n",
    `@@ -${"9".repeat(310)} +1 @@\n-old\n+new\n`,
    "@@ -9007199254740991,2 +1,2 @@\n old\n next\n",
    "@@ -1,2 +9007199254740991,2 @@\n old\n next\n"
  ]
  for (const hunk of invalid) expect.soft(parsePatch(header + hunk)._tag, hunk).toBe("PatchInvalid")
  assert.equal(parsePatch(header + "@@ -1,0 +2 @@\n+inserted\n")._tag, "Patch")
  const boundary = parsed(header + "@@ -9007199254740991 +9007199254740991 @@\n-old\n+new\n")
  assert.equal(boundary.files[0]?.hunks[0]?.lines[1]?.newNo, Number.MAX_SAFE_INTEGER)
})

test.each(["rename", "copy"])("rejects conflicting repeated %s paths while matching repeats remain valid", (kind) => {
  const header = "diff --git a/old b/new\n"
  for (const side of ["from", "to"]) {
    const original = `${kind} from old\n${kind} to new\n`
    assert.equal(parsePatch(header + `${kind} ${side} other\n` + original)._tag, "PatchInvalid")
    assert.equal(parsePatch(header + original + `${kind} ${side} other\n`)._tag, "PatchInvalid")
    assert.equal(parsePatch(header + original + original)._tag, "Patch")
  }
})

test("requires complete binary chunks and their terminating blank records", () => {
  const header = "diff --git a/binary.dat b/binary.dat\nGIT binary patch\n"
  const chunk = "literal 10\nRcmc~xEoVr|%u6h)1OOB)1JD2f\n\n"
  for (
    const body of [
      "",
      "literal 10\n",
      chunk.trimEnd() + "\n",
      "literal 10\n\n",
      chunk + "literal 10\n",
      chunk + "literal\n",
      chunk + "delta\n",
      chunk + chunk.trimEnd() + "\n",
      chunk + chunk + chunk,
      chunk.replace("literal 10", "literal 9007199254740992"),
      chunk.replace("Rcmc~", "Rcm~"),
      chunk.replace("Rcmc~", "Rcmc:")
    ]
  ) {
    expect.soft(parsePatch(header + body)._tag, body).toBe("PatchInvalid")
  }
  assert.equal(parsePatch(header + chunk)._tag, "Patch")
  assert.equal(parsePatch(header + chunk + chunk)._tag, "Patch")
})

test("rejects incomplete or mismatched binary summaries", () => {
  const header = "diff --git a/a b/a\n"
  for (
    const summary of [
      "Binary files a/a and b/a diffe",
      "Binary files a/other and b/other differ",
      "Binary files a/a and b/a differ trailing",
      "Binary files /dev/null and /dev/null differ",
      "Binary files a/a and b/other differ"
    ]
  ) {
    expect.soft(parsePatch(header + summary + "\n")._tag, summary).toBe("PatchInvalid")
  }
})

test("retains EOF absence per side and leaves neighboring coordinates unchanged", () => {
  const result = parsed(
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -7,2 +9,2 @@\n-old\n+new\n tail\n\\ No newline at end of file\n"
  )
  expect(result.files[0]?.hunks[0]?.lines).toEqual([
    { kind: "del", text: "old", oldNo: 7 },
    { kind: "add", text: "new", newNo: 9 },
    { kind: "context", text: "tail", oldNo: 8, newNo: 10, noNewline: true }
  ])
})

test("accepts installed Git binary summaries with quoting, separator text, prefixes and null sides", () => {
  for (const fixture of binarySummaries) {
    const prefixes = fixture.prefix === "custom"
      ? { source: "old/", destination: "new/" }
      : fixture.prefix === "none"
      ? { source: "", destination: "" }
      : undefined
    const result = parsePatch(fixture.patch, prefixes)
    expect(result._tag, JSON.stringify(fixture)).toBe("Patch")
    if (result._tag !== "Patch") continue
    expect(result.patch.files[0]).toMatchObject({
      binary: true,
      status: fixture.kind,
      path: `${fixture.kind === "deleted" ? "left" : "right"}/${fixture.name}`
    })
  }
})

test("rejects split identities on marker-free binary additions and deletions", () => {
  const kinds: ReadonlyArray<"added" | "deleted"> = ["added", "deleted"]
  for (const kind of kinds) {
    const fixture = binarySummaries.find((entry) => entry.kind === kind && entry.prefix === "default")
    if (fixture === undefined) assert.fail(`Missing Git-generated ${kind} binary fixture`)
    expect(parsePatch(fixture.patch)._tag).toBe("Patch")
    const split = fixture.patch.replace(
      /^diff --git a\/([^ ]+) b\/\1/m,
      (_header, name: string) =>
        kind === "added"
          ? `diff --git a/other/${name} b/${name}`
          : `diff --git a/${name} b/other/${name}`
    )
    assert.notEqual(split, fixture.patch)
    expect(parsePatch(split)._tag, kind).toBe("PatchInvalid")
  }
})

test("rejects dangling quoted Git escapes without losing literal backslashes", () => {
  const valid = String.raw`"a/trailing\\" "b/trailing\\"`
  const invalid = String.raw`"a/trailing\" "b/trailing\"`
  const body = "--- " + String.raw`"a/trailing\\"` + "\n+++ " + String.raw`"b/trailing\\"` +
    "\n@@ -1 +1 @@\n-old\n+new\n"
  expect(parsePatch(`diff --git ${valid}\n${body}`)._tag).toBe("Patch")
  const headerError = parsePatch(`diff --git ${invalid}\n${body}`)
  expect(headerError._tag).toBe("PatchInvalid")
  const malformedBody = body.replaceAll("trailing\\\\", "trailing\\")
  expect(parsePatch(`diff --git ${valid}\n${malformedBody}`)._tag)
    .toBe("PatchInvalid")
  const literal = "trailing\\"
  expect(
    parsePatch(`diff --git a/${literal} b/${literal}\n--- a/${literal}\n+++ b/${literal}\n@@ -1 +1 @@\n-old\n+new\n`)
      ._tag
  )
    .toBe("Patch")
  const directory = mkdtempSync(join(tmpdir(), "rly-quoted-backslash-"))
  try {
    mkdirSync(join(directory, "old"))
    mkdirSync(join(directory, "new"))
    writeFileSync(join(directory, "old", literal), "old\n")
    writeFileSync(join(directory, "new", literal), "new\n")
    const git = spawnSync("git", ["diff", "--no-index", "--", `old/${literal}`, `new/${literal}`], {
      cwd: directory,
      encoding: "utf8"
    })
    assert.equal(git.status, 1, git.stderr)
    assert.match(git.stdout, /trailing\\\\"/)
    expect(parsePatch(git.stdout)._tag).toBe("Patch")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("rejects backslashes before line separators in quoted identities", () => {
  const diff = (name: string) =>
    `diff --git "a/${name}" "b/${name}"\n--- "a/${name}"\n+++ "b/${name}"\n@@ -1 +1 @@\n-old\n+new\n`
  for (const separator of ["\r", "\u2028", "\u2029"]) {
    expect(parsePatch(diff(`x\\${separator}y\\\\`))._tag, `backslash before ${JSON.stringify(separator)}`)
      .toBe("PatchInvalid")
  }
})

test("rejects raw interior quotes while retaining Git-escaped quotes", () => {
  const name = "foo\"bar"
  const malformed = `diff --git "a/${name}" "b/${name}"\n--- "a/${name}"\n+++ "b/${name}"\n@@ -1 +1 @@\n-old\n+new\n`
  expect(parsePatch(malformed)._tag).toBe("PatchInvalid")

  const directory = mkdtempSync(join(tmpdir(), "rly-quoted-path-"))
  try {
    mkdirSync(join(directory, "old"))
    mkdirSync(join(directory, "new"))
    writeFileSync(join(directory, "old", "quote\"here"), "old\n")
    writeFileSync(join(directory, "new", "quote\"here"), "new\n")
    const git = spawnSync("git", ["diff", "--no-index", "--", "old/quote\"here", "new/quote\"here"], {
      cwd: directory,
      encoding: "utf8"
    })
    assert.equal(git.status, 1, git.stderr)
    assert.match(git.stdout, /quote\\"here/)
    expect(parsePatch(git.stdout)._tag).toBe("Patch")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("rejects backward hunk ranges on either side, including empty anchors", () => {
  const header = "diff --git a/a b/a\n--- a/a\n+++ b/a\n"
  for (
    const hunks of [
      "@@ -3 +3 @@\n-three\n+THREE\n@@ -1 +1 @@\n-one\n+ONE\n",
      "@@ -3 +1 @@\n-three\n+ONE\n@@ -1 +3 @@\n-one\n+THREE\n",
      "@@ -1 +3 @@\n-one\n+THREE\n@@ -3 +1 @@\n-three\n+ONE\n",
      "@@ -3,0 +4 @@\n+insert\n@@ -2,0 +5 @@\n+next\n",
      "@@ -4 +3,0 @@\n-delete\n@@ -5 +2,0 @@\n-next\n",
      "@@ -2 +2 @@\n-two\n+TWO\n@@ -1,0 +3 @@\n+insert-before-consumed-old-line\n",
      "@@ -2 +2 @@\n-two\n+TWO\n@@ -3 +1,0 @@\n-delete-before-consumed-new-line\n"
    ]
  ) expect.soft(parsePatch(header + hunks)._tag, hunks).toBe("PatchInvalid")
})

test("accepts ascending hunks and exact zero-length boundaries on both sides", () => {
  const header = "diff --git a/a b/a\n--- a/a\n+++ b/a\n"
  for (
    const hunks of [
      "@@ -1 +1 @@\n-one\n+ONE\n@@ -3 +3 @@\n-three\n+THREE\n",
      "@@ -0,0 +1 @@\n+insert\n@@ -1 +2 @@\n-one\n+ONE\n",
      "@@ -1 +0,0 @@\n-one\n@@ -2 +1 @@\n-two\n+TWO\n",
      "@@ -1 +1 @@\n-one\n+ONE\n@@ -1,0 +2 @@\n+insert\n",
      "@@ -1 +1 @@\n-one\n+ONE\n@@ -2 +1,0 @@\n-two\n",
      "@@ -0,0 +1 @@\n+first\n@@ -0,0 +2 @@\n+second\n",
      "@@ -1 +0,0 @@\n-first\n@@ -2 +0,0 @@\n-second\n",
      "@@ -2,0 +3 @@\n+insert\n@@ -3 +4 @@\n-three\n+THREE\n",
      "@@ -3 +2,0 @@\n-three\n@@ -4 +3 @@\n-four\n+FOUR\n"
    ]
  ) expect(parsePatch(header + hunks)._tag, hunks).toBe("Patch")
})

test("accepts Git-generated zero-context insertion, deletion and mixed boundaries", () => {
  const controls = [
    "diff --git a/left/a b/right/a\nindex 814f4a4..af9184c 100644\n--- a/left/a\n+++ b/right/a\n@@ -0,0 +1 @@\n+zero\n",
    "diff --git a/left/a b/right/a\nindex af9184c..814f4a4 100644\n--- a/left/a\n+++ b/right/a\n@@ -1 +0,0 @@\n-zero\n",
    "diff --git a/left/a b/right/a\nindex f384549..b470cad 100644\n--- a/left/a\n+++ b/right/a\n@@ -0,0 +1 @@\n+ONE\n@@ -2,0 +4 @@ two\n+THREE\n",
    "diff --git a/left/a b/right/a\nindex f384549..8c05df4 100644\n--- a/left/a\n+++ b/right/a\n@@ -1 +0,0 @@\n-one\n@@ -3 +1,0 @@ two\n-three\n",
    "diff --git a/left/a b/right/a\nindex f384549..ae95719 100644\n--- a/left/a\n+++ b/right/a\n@@ -0,0 +1 @@\n+zero\n@@ -2 +3 @@ one\n-two\n+TWO\n@@ -4 +4,0 @@ three\n-four\n"
  ]
  for (const patch of controls) expect(parsePatch(patch)._tag).toBe("Patch")
})

test("EOF markers end only their own file sides across records and hunks", () => {
  const header = "diff --git a/a b/a\n--- a/a\n+++ b/a\n"
  for (
    const [name, hunks, valid] of [
      ["old-side-context", "@@ -1,2 +1,2 @@\n-old\n\\ No newline at end of file\n+new\n next\n", false],
      ["new-side-context", "@@ -1,2 +1,2 @@\n-old\n+new\n\\ No newline at end of file\n next\n", false],
      ["context-then-replacement", "@@ -1,2 +1,2 @@\n same\n\\ No newline at end of file\n-old\n+new\n", false],
      [
        "old-side-next-hunk",
        "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n@@ -3 +3 @@\n-last\n+LAST\n",
        false
      ],
      [
        "new-side-next-hunk",
        "@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n@@ -3 +3 @@\n-last\n+LAST\n",
        false
      ],
      ["context-next-hunk", "@@ -1 +1 @@\n same\n\\ No newline at end of file\n@@ -3 +3 @@\n-last\n+LAST\n", false],
      ["old-eof-replacement-additions", "@@ -1 +1,2 @@\n-old\n\\ No newline at end of file\n+new\n+extra\n", true],
      [
        "new-eof-replacement-deletions",
        "@@ -1,2 +1 @@\n+new\n\\ No newline at end of file\n-old\n-extra\n\\ No newline at end of file\n",
        true
      ],
      ["both-eof", "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n", true],
      ["context-final-eof", "@@ -1,2 +1,2 @@\n-old\n+new\n tail\n\\ No newline at end of file\n", true],
      [
        "old-eof-next-hunk-only-additions",
        "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n@@ -1,0 +2 @@\n+extra\n",
        true
      ],
      [
        "new-eof-next-hunk-only-deletions",
        "@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n@@ -2 +1,0 @@\n-extra\n",
        true
      ]
    ] satisfies ReadonlyArray<readonly [string, string, boolean]>
  ) {
    expect.soft(parsePatch(header + hunks)._tag, name).toBe(valid ? "Patch" : "PatchInvalid")
  }
})

test("EOF terminality resets at the next file", () => {
  const patch =
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n"
    + "diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-old\n+new\n"
  expect(parsePatch(patch)._tag).toBe("Patch")
})

test("NUL path identities fail closed while tabs UTF8 and literal backslashes remain valid", () => {
  for (const name of [String.raw`zero\000x`, "zero\u0000x"]) {
    const quoted = `"${name}"`
    const left = `"a/${name}"`
    const right = `"b/${name}"`
    for (
      const patch of [
        `diff --git ${left} ${right}\n--- ${left}\n+++ ${right}\n@@ -1 +1 @@\n-old\n+new\n`,
        `diff --git ${left} ${right}\nold mode 100644\nnew mode 100755\n`,
        `diff --git ${left} b/target\nrename from ${quoted}\nrename to target\n`,
        `diff --git ${left} b/target\ncopy from ${quoted}\ncopy to target\n`,
        `diff --git ${left} ${right}\nBinary files ${left} and ${right} differ\n`
      ]
    ) expect.soft(parsePatch(patch)._tag, patch).toBe("PatchInvalid")
  }
  const literal = "zero\u0000x"
  expect(
    parsePatch(`diff --git a/${literal} b/${literal}\n--- a/${literal}\n+++ b/${literal}\n@@ -1 +1 @@\n-old\n+new\n`)
      ._tag
  ).toBe("PatchInvalid")
  for (
    const [encoded, decoded] of [
      [String.raw`tab\tname`, "tab\tname"],
      [String.raw`\303\251`, "é"],
      [String.raw`slash\\000name`, String.raw`slash\000name`]
    ]
  ) {
    const patch = parsed(
      `diff --git "a/${encoded}" "b/${encoded}"\n--- "a/${encoded}"\n+++ "b/${encoded}"\n@@ -1 +1 @@\n-old\n+new\n`
    )
    expect(patch.files[0]?.path).toBe(decoded)
  }
})

test("accepts Git-generated EOF transitions and context records", () => {
  for (
    const patch of [
      "diff --git a/left/a b/right/a\nindex 489ce0f..3e75765 100644\n--- a/left/a\n+++ b/right/a\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n",
      "diff --git a/left/a b/right/a\nindex 3367afd..3e5126c 100644\n--- a/left/a\n+++ b/right/a\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n",
      "diff --git a/left/a b/right/a\nindex 489ce0f..3e5126c 100644\n--- a/left/a\n+++ b/right/a\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
      "diff --git a/left/a b/right/a\nindex 6944e85..03c6d8d 100644\n--- a/left/a\n+++ b/right/a\n@@ -1,2 +1,2 @@\n-old\n+new\n tail\n\\ No newline at end of file\n",
      "diff --git a/left/a b/right/a\nindex 489ce0f..f5162bb 100644\n--- a/left/a\n+++ b/right/a\n@@ -1 +1,2 @@\n-old\n\\ No newline at end of file\n+new\n+extra\n",
      "diff --git a/left/a b/right/a\nindex 1b2e365..3e5126c 100644\n--- a/left/a\n+++ b/right/a\n@@ -1,2 +1 @@\n-old\n-extra\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n"
    ]
  ) expect(parsePatch(patch)._tag).toBe("Patch")
})

test("unquoted backslash digits remain a literal path rather than an octal escape", () => {
  const name = String.raw`zero\000x`
  const file =
    parsed(`diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new\n`).files[0]
  expect(file?.path).toBe(name)
})

test("mode transitions require both text sides while creation and deletion modes remain valid", () => {
  const added = "--- /dev/null\n+++ b/a\n@@ -0,0 +1 @@\n+new\n"
  const deleted = "--- a/a\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n"
  const header = "diff --git a/a b/a\n"
  for (const body of [added, deleted]) {
    expect.soft(parsePatch(header + "old mode 100644\nnew mode 100755\n" + body)._tag).toBe("PatchInvalid")
  }
  assert.equal(parsed(header + "new file mode 100644\n" + added).files[0]?.status, "added")
  assert.equal(parsed(header + "deleted file mode 100644\n" + deleted).files[0]?.status, "deleted")
  for (const oldMode of ["100644", "120000"]) {
    const file =
      parsed(header + `old mode ${oldMode}\nnew mode 100755\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n`).files[0]
    assert.equal(file?.status, "modified")
    assert.equal(file?.oldMode, oldMode)
    assert.equal(file?.newMode, "100755")
  }
  assert.equal(parsed(header + "old mode 100644\nnew mode 100755\n").files[0]?.status, "modified")
  assert.equal(parsed(header + "new file mode 100644\n").files[0]?.status, "added")
})
