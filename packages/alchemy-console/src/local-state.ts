import { Effect, FileSystem, Path } from "effect"
import { entries, exists, readText, stat, withinRoot } from "./internal/files.js"
import { type StackState, StateReadError } from "./schema.js"
import { decodeResource } from "./state.js"

/** Reads .alchemy/state/<app>/<stage>/<encoded-fqn>.json. Missing state is distinct from an empty stage. */
export const readLocalState = Effect.fn("AlchemyConsole.readLocalState")(function*(
  directory: string,
  alchemyVersion: string | null
) {
  if (alchemyVersion !== "2.0.0-beta.74" && alchemyVersion !== "2.0.0-beta.77") {
    return yield* new StateReadError({ reason: "unsupported-version" })
  }
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.realPath(directory).pipe(Effect.mapError(() => new StateReadError({ reason: "io" })))
  const candidate = path.join(root, ".alchemy", "state")
  if (!(yield* exists(candidate))) return { available: false, stacks: [] }
  const stateRoot = yield* withinRoot(root, candidate)
  const stacks: Array<StackState> = []
  for (const app of yield* entries(stateRoot)) {
    const appDir = yield* withinRoot(stateRoot, path.join(stateRoot, app))
    if ((yield* stat(appDir)).type !== "Directory") continue
    for (const stage of yield* entries(appDir)) {
      const stageDir = yield* withinRoot(appDir, path.join(appDir, stage))
      if ((yield* stat(stageDir)).type !== "Directory") continue
      const resources = []
      for (const name of yield* entries(stageDir)) {
        if (!name.endsWith(".json") || name === "__stack_output__.json") continue
        const file = yield* withinRoot(stageDir, path.join(stageDir, name))
        if ((yield* stat(file)).type !== "File") return yield* new StateReadError({ reason: "invalid-state" })
        const resource = yield* decodeResource(yield* readText(file))
        if (resource === null) continue
        if (name !== `${resource.fqn.replaceAll("/", "__")}.json`) {
          return yield* new StateReadError({ reason: "invalid-state" })
        }
        resources.push(resource)
      }
      stacks.push({
        app,
        stage,
        backend: "local",
        alchemyVersion,
        lastDeploy: null,
        resources: resources.sort((a, b) => a.fqn.localeCompare(b.fqn))
      })
    }
  }
  return { available: true, stacks }
})
