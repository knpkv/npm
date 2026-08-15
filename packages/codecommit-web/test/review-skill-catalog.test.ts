import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
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
})
