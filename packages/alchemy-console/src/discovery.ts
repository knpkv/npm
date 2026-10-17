import { Effect, FileSystem, Path, Result, Schema } from "effect"
import { entries, stat, withinRoot } from "./internal/files.js"
import { StateReadError } from "./schema.js"

/** Server-private paths. Retain only in memory; never emit to HTTP, browser storage, logs, or telemetry. */
export const Project = Schema.Struct({ directory: Schema.String, entrypoint: Schema.String })
export interface Project extends Schema.Schema.Type<typeof Project> {}

const excluded = new Set([".git", "node_modules", ".alchemy", ".direnv", ".cache", "dist"])

/** Projects found, and how many entries below the root couldn't be read (the walk went on without them). */
export interface DiscoveredProjects {
  readonly projects: ReadonlyArray<Project>
  readonly unreadable: number
}

/**
 * Read directory metadata only. No stack imports, evaluation, subprocesses, or credential reads.
 * Symlinks that leave the root are never followed and dangling ones lead nowhere, so both are skipped;
 * any other entry that can't be read is counted and skipped. Only an unreadable root fails.
 */
export const discoverProjects = Effect.fn("AlchemyConsole.discoverProjects")(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.realPath(directory).pipe(Effect.mapError(() => new StateReadError({ reason: "io" })))
  const pending = [root]
  const visited = new Set<string>()
  const projects: Array<Project> = []
  let unreadable = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    if (visited.has(current)) continue
    visited.add(current)
    if (visited.size > 50_000) return yield* new StateReadError({ reason: "limit" })
    const names = yield* Effect.result(entries(current))
    if (Result.isFailure(names)) {
      if (names.failure.reason === "limit" || current === root) return yield* names.failure
      unreadable += 1
      continue
    }
    for (const name of names.success) {
      if (excluded.has(name)) continue
      const link = path.join(current, name)
      const resolved = yield* Effect.result(withinRoot(root, link))
      if (Result.isFailure(resolved)) {
        // Not followed (outside the root): nothing to discover there.
        if (resolved.failure.reason === "outside-root") continue
        // Nowhere to follow (dangling); an entry that can't even be checked counts as unreadable.
        const present = yield* Effect.result(fs.exists(link))
        if (Result.isSuccess(present) && !present.success) continue
        unreadable += 1
        continue
      }
      const info = yield* Effect.result(stat(resolved.success))
      if (Result.isFailure(info)) {
        unreadable += 1
        continue
      }
      if (info.success.type === "Directory") pending.push(resolved.success)
      else if (name === "alchemy.run.ts" && info.success.type === "File") {
        projects.push(Project.make({ directory: current, entrypoint: resolved.success }))
      }
    }
  }
  return {
    projects: projects.sort((a, b) => a.directory.localeCompare(b.directory)),
    unreadable
  } satisfies DiscoveredProjects
})
