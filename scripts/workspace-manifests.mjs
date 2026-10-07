/**
 * Workspace package manifests, decoded at the file boundary, for the root packaging scripts:
 * `check-workspace-exports.mjs`, `require-built.mjs` and `test-workspace-bins.mjs`.
 *
 *   const packages = yield* workspacePackages // [{ directory, manifest }]
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { URL } from "node:url"

/** An `exports` value: a path, a fallback list, or conditions mapping to further values. */
export const ExportTarget = Schema.Union([
  Schema.String,
  Schema.Array(Schema.suspend(() => ExportTarget)),
  Schema.Record(
    Schema.String,
    Schema.suspend(() => ExportTarget)
  )
])

/** The fields of a `package.json` these scripts read; the rest are ignored. */
export const Manifest = Schema.Struct({
  name: Schema.String,
  private: Schema.optional(Schema.Boolean),
  bin: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
  main: Schema.optional(Schema.String),
  module: Schema.optional(Schema.String),
  exports: Schema.optional(ExportTarget),
  publishConfig: Schema.optional(Schema.Struct({ exports: Schema.optional(ExportTarget) }))
})

/** A workspace manifest that could not be read or does not have the expected shape. */
export class ManifestError extends Data.TaggedError("ManifestError") {}

const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(Manifest))

/** The repository's `packages/` directory. */
export const packagesRoot = Effect.gen(function* () {
  const path = yield* Path.Path
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url))
  return path.join(path.dirname(path.dirname(scriptPath)), "packages")
})

/** Every workspace package with its absolute directory and decoded manifest. */
export const workspacePackages = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* packagesRoot
  const directories = yield* fs.readDirectory(root)
  const manifests = yield* Effect.forEach(directories.toSorted(), (entry) => {
    const directory = path.join(root, entry)
    const manifestPath = path.join(directory, "package.json")
    // `packages/` also holds loose files; only a directory with a manifest is a package.
    return fs.stat(directory).pipe(
      Effect.flatMap((info) => (info.type === "Directory" ? fs.exists(manifestPath) : Effect.succeed(false))),
      Effect.flatMap((exists) =>
        exists
          ? fs.readFileString(manifestPath).pipe(
              Effect.flatMap(decodeManifest),
              Effect.map((manifest) => [{ directory, manifest }])
            )
          : Effect.succeed([])
      ),
      Effect.mapError((cause) => new ManifestError({ path: manifestPath, reason: cause.message }))
    )
  })
  return manifests.flat()
})

/**
 * The `[subpath, target]` pairs of an `exports` value. A map with no `./` keys is the root export's
 * conditions, as Node reads it.
 */
export const exportEntries = (exports) =>
  exports === undefined
    ? []
    : Predicate.isString(exports) || Array.isArray(exports)
      ? [[".", exports]]
      : Object.keys(exports).some((key) => key.startsWith("."))
        ? Object.entries(exports)
        : [[".", exports]]

/** Every runtime target an export target can resolve to, skipping the `types` condition. */
export const runtimeTargets = (target) =>
  Predicate.isString(target)
    ? [target]
    : Array.isArray(target)
      ? target.flatMap(runtimeTargets)
      : Object.entries(target).flatMap(([condition, nested]) => (condition === "types" ? [] : runtimeTargets(nested)))

/** The file Node loads for a bare `import "<name>"`: the root export, or `main` without exports. */
export const rootRuntimeFile = (manifest) => {
  const root = exportEntries(manifest.exports).find(([subpath]) => subpath === ".")
  return root === undefined ? (manifest.exports === undefined ? manifest.main : undefined) : runtimeTargets(root[1])[0]
}
