import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

/** Populate a caller-owned root, or create a temporary root cleaned up by the current scope. */
export const makeStaticFixture = Effect.fn("ControlCenterTest.makeStaticFixture")(function*(root?: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const staticRoot = root ?? (yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-runtime-static-" }))
  yield* fileSystem.makeDirectory(path.join(staticRoot, ".vite"), { recursive: true })
  yield* fileSystem.makeDirectory(path.join(staticRoot, "assets"))
  yield* fileSystem.writeFileString(path.join(staticRoot, "index.html"), "<main>Runtime fixture</main>")
  yield* fileSystem.writeFileString(path.join(staticRoot, "assets", "app.js"), "export const ready = true")
  yield* fileSystem.writeFileString(
    path.join(staticRoot, ".vite", "manifest.json"),
    JSON.stringify({ "src/client/main.tsx": { file: "assets/app.js", isEntry: true } })
  )
  return staticRoot
})
