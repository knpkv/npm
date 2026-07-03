import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Stdio from "effect/Stdio"

class SyncSkillsError extends Data.TaggedError("SyncSkillsError") {
  get message() {
    return this.reason
  }
}

const roots = [
  ["codecommit", "packages/codecommit/skills/codecommit"],
  ["confluence", "packages/confluence-to-markdown/skills/confluence"],
  ["jcf", "packages/jira-clockify/skills/jcf"],
  ["jira", "packages/jira-cli/skills/jira"]
]

const validModes = new Set(["check", "write"])

const collectFiles = (dir, prefix = "") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const entries = yield* fs.readDirectory(dir)
    const files = []
    for (const entry of entries) {
      const relative = prefix === "" ? entry : `${prefix}/${entry}`
      const absolute = path.join(dir, entry)
      const stat = yield* fs.stat(absolute)
      if (stat.type === "Directory") {
        files.push(...(yield* collectFiles(absolute, relative)))
      } else if (stat.type === "File") {
        files.push(relative)
      }
    }
    return files.sort()
  })

const sameTree = (source, destination) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const destinationExists = yield* fs.exists(destination)
    if (!destinationExists) return false
    const [sourceFiles, destinationFiles] = yield* Effect.all([collectFiles(source), collectFiles(destination)])
    if (JSON.stringify(sourceFiles) !== JSON.stringify(destinationFiles)) return false

    for (const relative of sourceFiles) {
      const [sourceContent, destinationContent] = yield* Effect.all([
        fs.readFileString(path.join(source, relative)),
        fs.readFileString(path.join(destination, relative))
      ])
      if (sourceContent !== destinationContent) return false
    }

    return true
  })

const copySkill = (source, destination) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(destination, { force: true, recursive: true })
    yield* fs.copy(source, destination, { overwrite: true })
  })

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  const mode = args[0] ?? "check"

  if (!validModes.has(mode)) {
    return yield* Effect.fail(new SyncSkillsError({ reason: "Usage: node scripts/sync-skills.mjs [check|write]" }))
  }

  const outOfSync = []

  for (const [skill, destination] of roots) {
    const source = `packages/agent-skills/skills/${skill}`
    if (mode === "write") {
      yield* copySkill(source, destination)
      yield* Console.log(`synced ${skill}: ${source} -> ${destination}`)
    } else if (!(yield* sameTree(source, destination))) {
      outOfSync.push(`${skill}: ${destination}`)
    }
  }

  if (outOfSync.length > 0) {
    yield* Console.error("Product-local skills are out of sync with packages/agent-skills/skills:")
    for (const line of outOfSync) yield* Console.error(`  ${line}`)
    yield* Console.error("Run: pnpm skills:sync")
    return yield* Effect.fail(new SyncSkillsError({ reason: "Product-local skills are out of sync" }))
  }
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)), { disableErrorReporting: true })
