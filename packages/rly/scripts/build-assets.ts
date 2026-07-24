import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { componentManifest } from "../component-manifest.js"
import { componentStyleSources } from "./contract.js"

class BuildAssetError extends Data.TaggedError("BuildAssetError")<{
  readonly reason: string
}> {
  override get message(): string {
    return this.reason
  }
}

const FONT_FILES: ReadonlyArray<{
  readonly dependency: string
  readonly file: string
  readonly license: string
}> = [
  {
    dependency: "geist",
    file: "geist-latin-wght-normal.woff2",
    license: "OFL-Geist.txt"
  },
  {
    dependency: "geist-mono",
    file: "geist-mono-latin-wght-normal.woff2",
    license: "OFL-Geist-Mono.txt"
  }
]

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const styles = componentManifest.assets.find(({ id }) => id === "styles")
  if (styles === undefined) return yield* Effect.fail(new BuildAssetError({ reason: "Styles asset is missing" }))

  const sourceDirectory = path.dirname(path.join(packageRoot, styles.source))
  const outputDirectory = path.dirname(path.join(packageRoot, styles.output))
  const fontOutput = path.join(outputDirectory, "fonts")
  const componentStylesPath = path.join(outputDirectory, "components.css")
  const boundedStylesPath = path.join(outputDirectory, "diff", "bounded", "index.css")
  const hasComponentStyles = componentStyleSources(componentManifest).length > 0
  yield* fs.makeDirectory(outputDirectory, { recursive: true })
  yield* fs.makeDirectory(fontOutput, { recursive: true })

  if (hasComponentStyles && !(yield* fs.exists(componentStylesPath))) {
    return yield* Effect.fail(new BuildAssetError({ reason: "Vite did not emit manifest-owned component CSS" }))
  }
  if (yield* fs.exists(boundedStylesPath)) {
    const [componentStyles, boundedStyles] = yield* Effect.all([
      fs.readFileString(componentStylesPath),
      fs.readFileString(boundedStylesPath)
    ])
    yield* fs.writeFileString(
      componentStylesPath,
      `${componentStyles.trimEnd()}\n${boundedStyles.trim()}\n`
    )
    yield* fs.remove(boundedStylesPath)
  }

  for (const file of ["styles.css", "generated-tokens.css", "base.css", "fonts.css"]) {
    const source = yield* fs.readFileString(path.join(sourceDirectory, file))
    const published = file === "fonts.css"
      ? source.replaceAll(/@fontsource-variable\/(?:geist|geist-mono)\/files\//g, "./fonts/")
      : file === "styles.css" && hasComponentStyles
      ? `${source.trimEnd()}\n@import "./components.css";\n`
      : source
    yield* fs.writeFileString(path.join(outputDirectory, file), published)
  }

  for (const font of FONT_FILES) {
    const dependencyRoot = path.join(packageRoot, "node_modules", "@fontsource-variable", font.dependency)
    const bytes = yield* fs.readFile(path.join(dependencyRoot, "files", font.file))
    yield* fs.writeFile(path.join(fontOutput, font.file), bytes)
    const license = yield* fs.readFileString(path.join(dependencyRoot, "LICENSE"))
    yield* fs.writeFileString(path.join(fontOutput, font.license), license)
  }

  yield* Console.log("built rly CSS and two self-hosted Geist font assets")
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error.message)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
