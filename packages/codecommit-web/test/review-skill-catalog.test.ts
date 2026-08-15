import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { discoverReviewSkillsFromRoots, selectedReviewSkillPrompt } from "../src/server/review/ReviewSkillCatalog.js"

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
      expect(selectedReviewSkillPrompt(skills, ["env:test:reviewer", "env:test:../../external"]))
        .toContain("Review typed failures.")
      expect(selectedReviewSkillPrompt(skills, ["env:test:../../external"])).toBe("")
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
})
