import { Effect, FileSystem, Path, Schema } from "effect"
import { entries, stat, withinRoot } from "./internal/files.js"
import { StateReadError } from "./schema.js"

/** Server-private paths. Retain only in memory; never emit to HTTP, browser storage, logs, or telemetry. */
export const Project = Schema.Struct({ directory: Schema.String, entrypoint: Schema.String })
export interface Project extends Schema.Schema.Type<typeof Project> {}

const excluded = new Set([".git", "node_modules", ".alchemy", ".direnv", ".cache", "dist"])

/** Read directory metadata only. No stack imports, evaluation, subprocesses, or credential reads. */
export const discoverProjects = Effect.fn("AlchemyConsole.discoverProjects")(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.realPath(directory).pipe(Effect.mapError(() => new StateReadError({ reason: "io" })))
  const pending = [root]
  const visited = new Set<string>()
  const projects: Array<Project> = []
  while (pending.length > 0) {
    const candidate = pending.pop()
    if (candidate === undefined) break
    const current = yield* withinRoot(root, candidate)
    if (visited.has(current)) continue
    visited.add(current)
    if (visited.size > 50_000) return yield* new StateReadError({ reason: "limit" })
    for (const name of yield* entries(current)) {
      if (excluded.has(name)) continue
      const file = yield* withinRoot(root, path.join(current, name))
      const info = yield* stat(file)
      if (info.type === "Directory") pending.push(file)
      else if (name === "alchemy.run.ts" && info.type === "File") {
        projects.push(Project.make({ directory: current, entrypoint: file }))
      }
    }
  }
  return projects.sort((a, b) => a.directory.localeCompare(b.directory))
})
