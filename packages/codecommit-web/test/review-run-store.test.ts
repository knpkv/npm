import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { type ReviewRun } from "@knpkv/review"
import { Effect, FileSystem, Path } from "effect"
import { makeReviewRunReader } from "../src/server/review/ReviewRunReader.js"
import { makeReviewRunStore } from "../src/server/review/ReviewRunStore.js"

const run: ReviewRun = {
  id: "run-1",
  identity: {
    namespace: "codecommit",
    subjectId: "pr-35",
    revisionId: "revision-1",
    baseRevision: "base-1",
    headRevision: "head-1"
  },
  profile: null,
  kind: "review",
  completedAt: 100,
  summary: "No blocking findings",
  explanation: null,
  risks: [],
  focus: null,
  rules: [],
  threads: []
}

it.layer(NodeServices.layer)("completed review persistence", (it) => {
  it.effect("refuses symlinked or permissive history directories without reading or writing records", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const target = path.join(root, "private")
      const link = path.join(root, "linked")
      yield* fs.makeDirectory(target, { mode: 0o700 })
      yield* fs.symlink(target, link)
      const linked = yield* makeReviewRunStore(link)
      const linkedWrite = yield* Effect.result(linked.save(run))
      expect(linkedWrite._tag).toBe("Failure")
      if (linkedWrite._tag === "Failure") expect(linkedWrite.failure.reason).toBe("private_path")
      expect(yield* fs.readDirectory(target)).toEqual([])
      yield* fs.chmod(target, 0o755)
      const permissive = yield* makeReviewRunStore(target)
      const permissiveWrite = yield* Effect.result(permissive.save(run))
      expect(permissiveWrite._tag).toBe("Failure")
      if (permissiveWrite._tag === "Failure") expect(permissiveWrite.failure.reason).toBe("private_path")
      const read = yield* Effect.result(permissive.read(run.identity))
      expect(read._tag).toBe("Failure")
      if (read._tag === "Failure") expect(read.failure.reason).toBe("private_path")
      expect(yield* fs.readDirectory(target)).toEqual([])
    }))

  it.effect("refuses symlinked or non-private history files", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const reader = yield* makeReviewRunReader(root)
      const file = yield* reader.filename(run.identity)
      const other = path.join(root, "other.json")
      yield* fs.writeFileString(other, JSON.stringify({ version: 1, run }), { mode: 0o600 })
      yield* fs.symlink(other, file)
      const linked = yield* Effect.result(reader.read(run.identity))
      expect(linked._tag).toBe("Failure")
      if (linked._tag === "Failure") expect(linked.failure.reason).toBe("private_path")
      yield* fs.remove(file)
      yield* fs.writeFileString(file, JSON.stringify({ version: 1, run }), { mode: 0o644 })
      const permissive = yield* Effect.result(reader.read(run.identity))
      expect(permissive._tag).toBe("Failure")
      if (permissive._tag === "Failure") expect(permissive.failure.reason).toBe("private_path")
    }))

  it.effect("a missing store is absent without creating directories", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const directory = path.join(root, "missing")
      const reader = yield* makeReviewRunReader(directory)
      expect(yield* reader.read(run.identity)).toBeNull()
      expect(yield* fs.exists(directory)).toBe(false)
    }))

  it.effect("survives a new store instance and head movement without cross-PR leakage", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const store = yield* makeReviewRunStore(root)
      expect((yield* store.save(run))._tag).toBe("Saved")
      const reader = yield* makeReviewRunReader(root)
      expect(yield* reader.read({ ...run.identity, headRevision: "head-2" })).toEqual(run)
      expect(yield* reader.read({ ...run.identity, subjectId: "pr-36" })).toBeNull()
      expect((yield* fs.readDirectory(root)).every((name) => /^[a-f0-9]{64}\.json$/u.test(name))).toBe(true)
    }))

  it.effect("a late result explicitly retains the newer completed run", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const store = yield* makeReviewRunStore(root)
      yield* store.save({ ...run, id: "newer", completedAt: 200 })
      const late = yield* store.save(run)
      expect(late._tag).toBe("NewerRetained")
      expect(late.run.id).toBe("newer")
      expect((yield* store.read(run.identity))?.id).toBe("newer")
    }))

  it.effect("corrupt or credential-bearing records fail instead of becoming empty", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const reader = yield* makeReviewRunReader(root)
      const file = yield* reader.filename(run.identity)
      for (
        const text of ["{", JSON.stringify({ version: 1, run, token: "secret" }), JSON.stringify({ version: 2, run })]
      ) {
        yield* fs.writeFileString(file, text, { mode: 0o600 })
        const result = yield* Effect.result(reader.read(run.identity))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure.reason).toBe("invalid")
      }
    }))

  it.effect("rejects oversized reads but replaces a corrupt or oversized record with a completed review", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const store = yield* makeReviewRunStore(root)
      const reader = yield* makeReviewRunReader(root)
      const file = yield* reader.filename(run.identity)
      yield* fs.writeFileString(file, "x".repeat(1_048_577), { mode: 0o600 })
      const read = yield* Effect.result(reader.read(run.identity))
      expect(read._tag).toBe("Failure")
      if (read._tag === "Failure") expect(read.failure.reason).toBe("oversized")
      for (const text of ["{", "x".repeat(1_048_577)]) {
        yield* fs.writeFileString(file, text)
        expect((yield* store.save(run))._tag).toBe("Saved")
        expect(yield* reader.read(run.identity)).toEqual(run)
      }
    }))
})
