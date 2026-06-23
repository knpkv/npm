import * as Glob from "glob"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"

const dirs = [".", ...Glob.sync("packages/*/", ...Glob.sync("packages/ai/*/"))]

const remove = (path) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(path, { recursive: true }).pipe(Effect.catchCause(() => Effect.void))
  })

const program = Effect.gen(function* () {
  yield* Effect.forEach(
    dirs,
    (pkg) => {
      const files = [".tsbuildinfo", "docs", "build", "dist", "coverage"]

      return Effect.forEach(files, (file) => {
        if (pkg === "." && file === "docs") {
          return Effect.void
        }

        return remove(`${pkg}/${file}`)
      })
    },
    { concurrency: "unbounded" }
  )

  yield* Effect.forEach(Glob.sync("docs/*/"), remove, { concurrency: "unbounded" })
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeFileSystem.layer)))
