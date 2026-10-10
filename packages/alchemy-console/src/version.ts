import { Effect, FileSystem, Path, Schema } from "effect"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { parse as parseYaml } from "yaml"
import { exists, readText, withinRoot } from "./internal/files.js"
import { StateReadError } from "./schema.js"

const Dependency = Schema.Struct({ version: Schema.String })
const Importer = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Dependency)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Dependency))
})
const PnpmLock = Schema.Struct({ importers: Schema.Record(Schema.String, Importer) })
const BunLock = Schema.Struct({ packages: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)) })
const exactVersion = /^(?:alchemy@)?(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\(.*\))?$/u

const decodeVersion = (resolved: string | undefined): string | null =>
  resolved === undefined ? null : exactVersion.exec(resolved)?.[1] ?? null

const pnpmVersion = Effect.fn("AlchemyConsole.pnpmVersion")(function*(text: string, importer: string) {
  const raw: unknown = yield* Effect.try({
    try: () => parseYaml(text, { maxAliasCount: 0 }),
    catch: () => new StateReadError({ reason: "invalid-lockfile" })
  })
  const lock = yield* Schema.decodeUnknownEffect(PnpmLock)(raw).pipe(
    Effect.mapError(() => new StateReadError({ reason: "invalid-lockfile" }))
  )
  const entry = lock.importers[importer]
  return decodeVersion(entry?.dependencies?.alchemy?.version ?? entry?.devDependencies?.alchemy?.version)
})

const bunVersion = Effect.fn("AlchemyConsole.bunVersion")(function*(text: string) {
  const errors: Array<ParseError> = []
  const raw: unknown = yield* Effect.try({
    try: () => parseJsonc(text, errors, { allowTrailingComma: true }),
    catch: () => new StateReadError({ reason: "invalid-lockfile" })
  })
  if (errors.length > 0) return yield* new StateReadError({ reason: "invalid-lockfile" })
  const lock = yield* Schema.decodeUnknownEffect(BunLock)(raw).pipe(
    Effect.mapError(() => new StateReadError({ reason: "invalid-lockfile" }))
  )
  const resolved = lock.packages.alchemy?.[0]
  if (resolved === undefined) return null
  const version = yield* Schema.decodeUnknownEffect(Schema.String)(resolved).pipe(
    Effect.mapError(() => new StateReadError({ reason: "invalid-lockfile" }))
  )
  return decodeVersion(version)
})

/** Read the nearest pnpm or Bun text lockfile within an explicit server-private search root. */
export const readAlchemyVersion = Effect.fn("AlchemyConsole.readAlchemyVersion")(function*(
  projectDirectory: string,
  searchRoot: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.realPath(searchRoot).pipe(Effect.mapError(() => new StateReadError({ reason: "io" })))
  const project = yield* withinRoot(root, projectDirectory)
  let directory = project
  while (true) {
    for (const name of ["pnpm-lock.yaml", "bun.lock"]) {
      const candidate = path.join(directory, name)
      if (!(yield* exists(candidate))) continue
      const file = yield* withinRoot(root, candidate)
      const text = yield* readText(file)
      const importer = path.relative(directory, project).split(path.sep).join("/") || "."
      return yield* name === "bun.lock" ? bunVersion(text) : pnpmVersion(text, importer)
    }
    if (directory === root) return null
    directory = path.dirname(directory)
  }
})
