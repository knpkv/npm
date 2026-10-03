/**
 * Copy the patched effect-qb runtime into `dist/vendor/effect-qb` and point the compiled modules at it.
 * Runs after `tsc` as part of `build`; see `vendored-effect-qb.ts` for why and when to remove it.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { unpatchedReason, vendorDirectory, VendoredEffectQbError, vendoredEntries } from "./vendored-effect-qb.js"

const program = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const dist = path.join(packageRoot, "dist")
  const source = yield* fileSystem.realPath(path.join(packageRoot, "node_modules", "effect-qb", "dist")).pipe(
    Effect.mapError((cause) => new VendoredEffectQbError({ cause, reason: "effect-qb is not installed" }))
  )
  const target = path.join(dist, vendorDirectory)
  yield* fileSystem.makeDirectory(target, { recursive: true })

  for (const { file } of vendoredEntries) {
    const contents = yield* fileSystem.readFileString(path.join(source, file))
    const reason = unpatchedReason(file, contents)
    if (reason !== undefined) return yield* new VendoredEffectQbError({ reason })
    yield* fileSystem.writeFileString(path.join(target, file), contents)
  }

  // effect-qb is MIT-licensed; its manifest carries the license, author, and repository with the copy.
  yield* fileSystem.copyFile(path.join(source, "..", "package.json"), path.join(target, "package.json"))

  const compiled = (yield* fileSystem.readDirectory(dist)).filter((file) => file.endsWith(".js"))
  for (const file of compiled) {
    const modulePath = path.join(dist, file)
    const original = yield* fileSystem.readFileString(modulePath)
    const rewritten = vendoredEntries.reduce(
      (text, { file: vendored, specifier }) =>
        text.replaceAll(`from "${specifier}"`, `from "./${vendorDirectory}/${vendored}"`),
      original
    )
    if (rewritten.includes("from \"effect-qb")) {
      return yield* new VendoredEffectQbError({ reason: `${file} imports an effect-qb entry that is not vendored` })
    }
    if (rewritten !== original) yield* fileSystem.writeFileString(modulePath, rewritten)
  }
  yield* Console.log(`vendored patched effect-qb into dist/${vendorDirectory}`)
}).pipe(
  // The build script is the executable boundary for Node services.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(NodeServices.layer)
)

NodeRuntime.runMain(program)
