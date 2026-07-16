import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { componentManifest } from "../component-manifest.js"
import { componentStyleSources, entryOutputStem, renderPackageExports } from "./contract.js"

class DistValidationError extends Data.TaggedError("DistValidationError")<{
  readonly reason: string
}> {}

const PackageJson = Schema.fromJsonString(
  Schema.Struct({
    files: Schema.Array(Schema.String),
    main: Schema.String,
    sideEffects: Schema.Array(Schema.String),
    types: Schema.String
  })
)

const listFiles: (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> = Effect.fn("rly.listDistFiles")(
  function*(fs, path, directory) {
    const files: Array<string> = []
    for (const entry of yield* fs.readDirectory(directory)) {
      const absolute = path.join(directory, entry)
      const info = yield* fs.stat(absolute)
      if (info.type === "Directory") {
        for (const file of yield* listFiles(fs, path, absolute)) files.push(file)
      } else if (info.type === "File") {
        files.push(absolute)
      }
    }
    return files
  }
)

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const failures: Array<string> = []
  const hasComponentStyles = componentStyleSources(componentManifest).length > 0

  for (const entry of componentManifest.entries) {
    const stem = entryOutputStem(entry)
    const artifacts = [`dist/${stem}.js`, `dist/${stem}.js.map`, `dist/dts/${stem}.d.ts`, `dist/dts/${stem}.d.ts.map`]
    for (const artifact of artifacts) {
      const target = path.join(packageRoot, artifact)
      if (!(yield* fs.exists(target))) {
        failures.push(`missing ${artifact}`)
        continue
      }
      const info = yield* fs.stat(target)
      if (info.type !== "File") failures.push(`not a file ${artifact}`)
    }
  }
  for (const asset of componentManifest.assets) {
    const target = path.join(packageRoot, asset.output)
    if (!(yield* fs.exists(target))) failures.push(`missing ${asset.output}`)
    else if ((yield* fs.stat(target)).type !== "File") failures.push(`not a file ${asset.output}`)
  }
  for (const component of componentManifest.components) {
    const declaration = component.source.replace(/^src\//, "dist/dts/").replace(/\.tsx?$/, ".d.ts")
    const target = path.join(packageRoot, declaration)
    if (!(yield* fs.exists(target))) {
      failures.push(`missing ${declaration}`)
      continue
    }
    const source = yield* fs.readFileString(target)
    if (/from ["'](?:lucide-react|radix-ui)["']/.test(source)) {
      failures.push(`implementation type leaked through ${declaration}`)
    }
  }
  const distDirectory = path.join(packageRoot, "dist")
  if (yield* fs.exists(distDirectory)) {
    for (const file of yield* listFiles(fs, path, distDirectory)) {
      if (!file.endsWith(".js")) continue
      const source = yield* fs.readFileString(file)
      if (/['"][^'"]+\.css(?:\?[^'"]*)?['"]/.test(source)) {
        failures.push(`runtime CSS import leaked through ${path.relative(packageRoot, file)}`)
      }
    }
  }
  for (
    const artifact of [
      "dist/base.css",
      "dist/fonts.css",
      "dist/generated-tokens.css",
      ...(hasComponentStyles ? ["dist/components.css"] : []),
      "dist/fonts/geist-latin-wght-normal.woff2",
      "dist/fonts/geist-mono-latin-wght-normal.woff2",
      "dist/fonts/OFL-Geist.txt",
      "dist/fonts/OFL-Geist-Mono.txt"
    ]
  ) {
    const target = path.join(packageRoot, artifact)
    if (!(yield* fs.exists(target))) failures.push(`missing ${artifact}`)
    else if ((yield* fs.stat(target)).type !== "File") failures.push(`not a file ${artifact}`)
  }
  const componentStylesPath = path.join(packageRoot, "dist/components.css")
  const publishedStylesPath = path.join(packageRoot, "dist/styles.css")
  const componentImport = "@import \"./components.css\";"
  if (yield* fs.exists(publishedStylesPath)) {
    const publishedStyles = yield* fs.readFileString(publishedStylesPath)
    const importCount = publishedStyles.split(componentImport).length - 1
    if (hasComponentStyles && importCount !== 1) {
      failures.push("published styles must import component CSS exactly once")
    } else if (!hasComponentStyles && importCount !== 0) {
      failures.push("published styles import component CSS without manifest styles")
    }
  }
  if (hasComponentStyles && (yield* fs.exists(componentStylesPath))) {
    const componentStyles = yield* fs.readFileString(componentStylesPath)
    if (componentStyles.trim().length === 0) failures.push("published component CSS is empty")
  } else if (!hasComponentStyles && (yield* fs.exists(componentStylesPath))) {
    failures.push("component CSS exists without manifest styles")
  }
  const publishedFontsPath = path.join(packageRoot, "dist/fonts.css")
  if (yield* fs.exists(publishedFontsPath)) {
    const publishedFonts = yield* fs.readFileString(publishedFontsPath)
    if (publishedFonts.includes("@fontsource-variable")) failures.push("published font CSS has a bare dependency URL")
    for (const font of ["geist-latin-wght-normal.woff2", "geist-mono-latin-wght-normal.woff2"]) {
      if (!publishedFonts.includes(`./fonts/${font}`)) failures.push(`published font CSS does not reference ${font}`)
    }
  }
  for (
    const privateArtifact of [
      "dist/dts/tokens/colors.d.ts",
      "dist/dts/tokens/model.d.ts",
      "dist/dts/tokens/motion.d.ts",
      "dist/dts/tokens/shape.d.ts",
      "dist/dts/tokens/space.d.ts",
      "dist/dts/tokens/typography.d.ts"
    ]
  ) {
    if (yield* fs.exists(path.join(packageRoot, privateArtifact))) {
      failures.push(`private token source leaked as ${privateArtifact}`)
    }
  }

  const packageSource = yield* fs.readFileString(path.join(packageRoot, "package.json"))
  const packageJson = yield* Schema.decodeUnknownEffect(PackageJson)(packageSource).pipe(
    Effect.mapError(() => new DistValidationError({ reason: "package.json publication fields are invalid" }))
  )
  const exports = renderPackageExports(componentManifest)
  const root = exports["."]
  if (root === undefined || typeof root === "string") failures.push("root module export is missing")
  else {
    if (packageJson.main !== root.import) failures.push("main does not match root import")
    if (packageJson.types !== root.types) failures.push("types does not match root types")
  }
  if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist", "registry", "README.md"])) {
    failures.push("package files must contain only dist, registry, and README.md")
  }
  if (JSON.stringify(packageJson.sideEffects) !== JSON.stringify(["*.css", "**/*.css"])) {
    failures.push("only CSS may be declared side-effectful")
  }

  if (failures.length > 0) {
    return yield* Effect.fail(new DistValidationError({ reason: failures.join(", ") }))
  }
  yield* Console.log(
    `validated ${componentManifest.entries.length} modules and ${componentManifest.assets.length} assets`
  )
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error)),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
