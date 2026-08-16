import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { MAXIMUM_RELAY_SKILL_PROMPT_BYTES } from "../src/server/review/ReviewPromptBudget.js"
import {
  discoverReviewSkillsFromRoots,
  MAXIMUM_REVIEW_SKILL_DESCRIPTION_BYTES,
  MAXIMUM_REVIEW_SKILL_NAME_BYTES,
  MAXIMUM_SKILL_INSPECTED_ENTRIES,
  type ReviewSkillDefinition,
  selectedReviewSkillPrompt
} from "../src/server/review/ReviewSkillCatalog.js"

describe("Relay review skill catalog", () => {
  it.effect("discovers only bounded SKILL.md files inside trusted roots", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const temporary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "review-skills-" })
      const trusted = path.join(temporary, "trusted")
      const external = path.join(temporary, "external")
      yield* fileSystem.makeDirectory(path.join(trusted, "reviewer"), { recursive: true })
      yield* fileSystem.makeDirectory(external, { recursive: true })
      yield* fileSystem.writeFileString(
        path.join(trusted, "reviewer", "SKILL.md"),
        [
          "---",
          "name: Strict reviewer",
          "description: Trace typed error paths.",
          "---",
          "Review typed failures."
        ].join("\n")
      )
      yield* fileSystem.writeFileString(path.join(external, "SKILL.md"), "Never inject this.")
      yield* fileSystem.symlink(path.join(external, "SKILL.md"), path.join(trusted, "escaped", "SKILL.md")).pipe(
        Effect.catch(() =>
          fileSystem.makeDirectory(path.join(trusted, "escaped"), { recursive: true }).pipe(
            Effect.andThen(
              fileSystem.symlink(path.join(external, "SKILL.md"), path.join(trusted, "escaped", "SKILL.md"))
            )
          )
        )
      )

      const skills = yield* discoverReviewSkillsFromRoots([{ label: "test", path: trusted }])
      const local = skills.find(({ id }) => id === "env:test:reviewer")
      expect(local).toMatchObject({ name: "Strict reviewer", description: "Trace typed error paths." })
      expect(skills.some(({ id }) => id.includes("escaped"))).toBe(false)
      expect(yield* selectedReviewSkillPrompt(skills, ["env:test:reviewer", "env:test:../../external"]))
        .toContain("Review typed failures.")
      expect(yield* selectedReviewSkillPrompt(skills, ["env:test:../../external"])).toBe("")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("bounds client-visible skill metadata by UTF-8 bytes", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const temporary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "review-skill-metadata-" })
      const root = path.join(temporary, "root")
      const oversized = path.join(root, "oversized")
      const ordinary = path.join(root, "ordinary")
      yield* fileSystem.makeDirectory(oversized, { recursive: true })
      yield* fileSystem.makeDirectory(ordinary, { recursive: true })
      yield* fileSystem.writeFileString(
        path.join(oversized, "SKILL.md"),
        [
          "---",
          `name: ${"é".repeat(10_000)}`,
          `description: ${"界".repeat(12_000)}`,
          "---",
          "Large metadata must not reach the client unchanged."
        ].join("\n")
      )
      yield* fileSystem.writeFileString(
        path.join(ordinary, "SKILL.md"),
        ["---", "name: Strict reviewer", "description: Trace typed error paths.", "---", "Ordinary skill."].join(
          "\n"
        )
      )

      const skills = yield* discoverReviewSkillsFromRoots([{ label: "test", path: root }])
      const large = skills.find(({ id }) => id === "env:test:oversized")
      const normal = skills.find(({ id }) => id === "env:test:ordinary")
      const encoder = new TextEncoder()
      expect(large).not.toBeUndefined()
      if (large === undefined) return
      expect(encoder.encode(large.name).byteLength).toBeLessThanOrEqual(MAXIMUM_REVIEW_SKILL_NAME_BYTES)
      expect(encoder.encode(large.description).byteLength).toBeLessThanOrEqual(
        MAXIMUM_REVIEW_SKILL_DESCRIPTION_BYTES
      )
      expect(large.name.endsWith("…")).toBe(true)
      expect(large.description.endsWith("…")).toBe(true)
      expect(normal).toMatchObject({ name: "Strict reviewer", description: "Trace typed error paths." })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("stops directory traversal at the file and depth bounds", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const temporary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "review-skill-bounds-" })
      const wide = path.join(temporary, "wide")
      yield* fileSystem.makeDirectory(wide, { recursive: true })
      yield* Effect.forEach(
        Array.from({ length: 300 }, (_, index) => `skill-${String(index).padStart(3, "0")}`),
        (directory) => {
          const skillDirectory = path.join(wide, directory)
          return fileSystem.makeDirectory(skillDirectory, { recursive: true }).pipe(
            Effect.andThen(fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), directory))
          )
        },
        { concurrency: 16 }
      )
      const deep = path.join(temporary, "deep")
      const tooDeep = Array.from({ length: 8 }, (_, index) => `level-${String(index + 1)}`)
        .reduce((directory, segment) => path.join(directory, segment), deep)
      yield* fileSystem.makeDirectory(tooDeep, { recursive: true })
      yield* fileSystem.writeFileString(path.join(tooDeep, "SKILL.md"), "Too deep.")

      const reads = yield* Ref.make<ReadonlyArray<{ readonly directory: string; readonly recursive: boolean }>>([])
      const recording = FileSystem.make({
        ...fileSystem,
        readDirectory: (directory, options) =>
          Ref.update(reads, (current) => [
            ...current,
            { directory, recursive: options?.recursive === true }
          ]).pipe(Effect.andThen(fileSystem.readDirectory(directory, options)))
      })
      const wideSkills = yield* discoverReviewSkillsFromRoots([{ label: "wide", path: wide }]).pipe(
        Effect.provideService(FileSystem.FileSystem, recording)
      )
      const wideReads = yield* Ref.get(reads)
      expect(wideSkills.filter(({ id }) => id.startsWith("env:wide:"))).toHaveLength(256)
      expect(wideReads).toHaveLength(257)
      expect(wideReads.every(({ recursive }) => !recursive)).toBe(true)

      const readsBeforeDeep = wideReads.length
      const deepSkills = yield* discoverReviewSkillsFromRoots([{ label: "deep", path: deep }]).pipe(
        Effect.provideService(FileSystem.FileSystem, recording)
      )
      expect(deepSkills.some(({ id }) => id.startsWith("env:deep:"))).toBe(false)
      const deepReads = (yield* Ref.get(reads)).slice(readsBeforeDeep)
      expect(deepReads).toHaveLength(8)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("bounds inspected entries across a dense skill root", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const temporary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "review-skill-entry-bounds-" })
      const dense = path.join(temporary, "dense")
      yield* fileSystem.makeDirectory(dense, { recursive: true })
      const canonicalDense = yield* fileSystem.realPath(dense)
      const entries = Array.from(
        { length: MAXIMUM_SKILL_INSPECTED_ENTRIES + 64 },
        (_, index) => `ordinary-${String(index).padStart(5, "0")}`
      )
      entries.push("zz-skill")
      const realPaths = yield* Ref.make(0)
      const stats = yield* Ref.make(0)
      const recording = FileSystem.make({
        ...fileSystem,
        readDirectory: (directory, options) =>
          directory === canonicalDense ? Effect.succeed(entries) : fileSystem.readDirectory(directory, options),
        realPath: (candidate) =>
          candidate === dense || candidate === canonicalDense
            ? fileSystem.realPath(candidate)
            : Ref.update(realPaths, (count) => count + 1).pipe(Effect.andThen(Effect.succeed(candidate))),
        stat: (candidate) => Ref.update(stats, (count) => count + 1).pipe(Effect.andThen(fileSystem.stat(candidate)))
      })

      const skills = yield* discoverReviewSkillsFromRoots([{ label: "dense", path: dense }]).pipe(
        Effect.provideService(FileSystem.FileSystem, recording)
      )
      expect(skills.some(({ id }) => id.startsWith("env:dense:"))).toBe(false)
      expect(yield* Ref.get(realPaths)).toBe(MAXIMUM_SKILL_INSPECTED_ENTRIES)
      expect(yield* Ref.get(stats)).toBe(MAXIMUM_SKILL_INSPECTED_ENTRIES)

      const valid = path.join(temporary, "valid")
      yield* fileSystem.makeDirectory(path.join(valid, "one"), { recursive: true })
      yield* fileSystem.makeDirectory(path.join(valid, "two", "nested"), { recursive: true })
      yield* fileSystem.writeFileString(path.join(valid, "one", "SKILL.md"), "First.")
      yield* fileSystem.writeFileString(path.join(valid, "two", "nested", "SKILL.md"), "Second.")
      const validSkills = yield* discoverReviewSkillsFromRoots([{ label: "valid", path: valid }])
      expect(validSkills.filter(({ id }) => id.startsWith("env:valid:"))).toHaveLength(2)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("selects the same bounded skill prefix across directory permutations", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const temporary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "review-skill-order-" })
      const root = path.join(temporary, "root")
      yield* fileSystem.makeDirectory(root, { recursive: true })
      yield* fileSystem.writeFileString(path.join(root, "SKILL.md"), "Deterministic skill.")
      const canonicalRoot = yield* fileSystem.realPath(root)
      const ordinary = Array.from(
        { length: MAXIMUM_SKILL_INSPECTED_ENTRIES },
        (_, index) => `ordinary-${String(index).padStart(5, "0")}`
      )
      const discoverWith = (entries: ReadonlyArray<string>) =>
        discoverReviewSkillsFromRoots([{ label: "order", path: root }]).pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.make({
              ...fileSystem,
              readDirectory: (directory, options) =>
                directory === canonicalRoot
                  ? Effect.succeed([...entries])
                  : fileSystem.readDirectory(directory, options)
            })
          )
        )

      const first = yield* discoverWith(["SKILL.md", ...ordinary])
      const second = yield* discoverWith([...ordinary.toReversed(), "SKILL.md"])
      expect(first.find(({ id }) => id === "env:order:.")?.prompt).toBe("Deterministic skill.")
      expect(second.find(({ id }) => id === "env:order:.")?.prompt).toBe("Deterministic skill.")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("exposes only environment skill ids accepted by review profiles", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const temporary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "review-skill-id-" })
      const root = path.join(temporary, "root")
      const first = "a".repeat(120)
      const boundary = path.join(first, "b".repeat(124))
      const overlong = path.join(first, "c".repeat(125))
      yield* fileSystem.makeDirectory(path.join(root, boundary), { recursive: true })
      yield* fileSystem.makeDirectory(path.join(root, overlong), { recursive: true })
      yield* fileSystem.writeFileString(path.join(root, boundary, "SKILL.md"), "Boundary skill.")
      yield* fileSystem.writeFileString(path.join(root, overlong, "SKILL.md"), "Overlong skill.")

      const skills = yield* discoverReviewSkillsFromRoots([{ label: "length", path: root }])
      const boundaryId = `env:length:${boundary.split(path.sep).join("/")}`
      expect(boundaryId).toHaveLength(256)
      expect(skills.find(({ id }) => id === boundaryId)?.prompt).toBe("Boundary skill.")
      expect(skills.some(({ prompt }) => prompt === "Overlong skill.")).toBe(false)
      expect(skills.every(({ id }) => id.length <= 256)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("rejects selected skill prompts above the aggregate UTF-8 budget", () =>
    Effect.gen(function*() {
      const skills: ReadonlyArray<ReviewSkillDefinition> = Array.from({ length: 16 }, (_, index) => ({
        id: `env:test:${String(index)}`,
        name: `Skill ${String(index)}`,
        description: "Large fixture.",
        source: "test",
        prompt: "x".repeat(64 * 1024)
      }))
      const failure = yield* selectedReviewSkillPrompt(skills, skills.map(({ id }) => id)).pipe(Effect.flip)
      expect(failure._tag).toBe("ReviewSkillSelectionError")
      expect(failure.message).toContain(String(MAXIMUM_RELAY_SKILL_PROMPT_BYTES))

      const utf8Prompt = "é".repeat(MAXIMUM_RELAY_SKILL_PROMPT_BYTES / 2)
      const valid: ReadonlyArray<ReviewSkillDefinition> = [{
        id: "env:test:utf8",
        name: "UTF-8 fixture",
        description: "Counts encoded bytes.",
        source: "test",
        prompt: utf8Prompt
      }]
      const selected = yield* selectedReviewSkillPrompt(valid, ["env:test:utf8"])
      expect(new TextEncoder().encode(selected).byteLength).toBe(MAXIMUM_RELAY_SKILL_PROMPT_BYTES)
    }))
})
