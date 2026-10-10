import { collectBoundedText } from "@knpkv/bounded-io"
import { Effect, FileSystem, Path } from "effect"
import { StateReadError } from "../schema.js"

export const readText = Effect.fn("AlchemyConsole.readText")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* collectBoundedText(fs.stream(file), 8 * 1024 * 1024).pipe(
    Effect.mapError((error) => new StateReadError({ reason: error._tag === "ByteLimitExceeded" ? "limit" : "io" }))
  )
})

export const entries = Effect.fn("AlchemyConsole.entries")(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const names = yield* fs.readDirectory(directory).pipe(
    Effect.mapError(() => new StateReadError({ reason: "io" }))
  )
  if (names.length > 50_000) return yield* new StateReadError({ reason: "limit" })
  return names.sort()
})

/** Resolve before inspecting a candidate; symlinks may not escape the caller's explicit root. */
export const withinRoot = Effect.fn("AlchemyConsole.withinRoot")(function*(root: string, candidate: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const real = yield* fs.realPath(candidate).pipe(Effect.mapError(() => new StateReadError({ reason: "io" })))
  const relative = path.relative(root, real)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return yield* new StateReadError({ reason: "outside-root" })
  }
  return real
})

export const exists = Effect.fn("AlchemyConsole.exists")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.exists(file).pipe(Effect.mapError(() => new StateReadError({ reason: "io" })))
})

export const stat = Effect.fn("AlchemyConsole.stat")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.stat(file).pipe(Effect.mapError(() => new StateReadError({ reason: "io" })))
})
