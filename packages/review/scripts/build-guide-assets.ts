import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { build, type BuildOptions } from "esbuild"

class GuideAssetError extends Schema.TaggedError<GuideAssetError>()("GuideAssetError", { cause: Schema.Defect() }) {}

const bundle = Effect.fn("Review.bundleAsset")(function*(entry: string, options: BuildOptions) {
  const result = yield* Effect.tryPromise({
    try: () =>
      build({ entryPoints: [entry], bundle: true, write: false, minify: true, legalComments: "inline", ...options }),
    catch: (cause) => new GuideAssetError({ cause })
  })
  const file = result.outputFiles[0]
  if (file === undefined) return yield* new GuideAssetError({ cause: `No output for ${entry}` })
  return file.text
})

NodeRuntime.runMain(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const css = yield* bundle("src/guide/style.css", { loader: { ".woff2": "dataurl" } })
    const client = yield* bundle("src/guide/client.tsx", {
      platform: "browser",
      format: "iife",
      define: { "process.env.NODE_ENV": "\"production\"" }
    })
    const diagrams = yield* bundle("src/guide/diagrams.ts", { platform: "browser", format: "iife" })
    yield* fs.writeFileString(
      "dist/guide/assets.js",
      `export const css = ${JSON.stringify(css)};\nexport const client = ${
        JSON.stringify(client)
      };\nexport const diagrams = ${JSON.stringify(diagrams)};\n`
    )
    yield* fs.copyFile("src/guide/style.css", "dist/guide/style.css")
  }).pipe(Effect.provide(NodeServices.layer))
)
