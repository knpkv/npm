/**
 * Install the packed tarball into a clean consumer that has Effect 4.0.0 but no effect-qb, then render
 * a query through the public API. Passing proves the shipped effect-qb copy is the patched one.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Schema from "effect/Schema"
import { unpatchedReason, vendorDirectory, VendoredEffectQbError, vendoredEntries } from "./vendored-effect-qb.js"

const PackageJson = Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String }))

// The packed manifest decides what the consumer gets, so a dependency missing from it fails the run.
const PackedManifest = Schema.fromJsonString(Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
}))

const run = Effect.fn("controlCenterSql.runPackedCommand")(function*(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const invocation = `${command} ${args.join(" ")}`
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(command, args, { cwd, stderr: "inherit", stdout: "inherit" })
  ).pipe(Effect.mapError((cause) => new VendoredEffectQbError({ cause, reason: `${invocation} could not run` })))
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new VendoredEffectQbError({ reason: `${invocation} exited with code ${exitCode}` })
  }
})

const program = Effect.scoped(
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
    const temporary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-sql-packed-consumer-" })
    const packageJson = yield* fileSystem.readFileString(path.join(packageRoot, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PackageJson)),
      Effect.mapError((cause) => new VendoredEffectQbError({ cause, reason: "Could not decode package identity" }))
    )
    yield* run("pnpm", ["pack", "--pack-destination", temporary], packageRoot)

    const archive = path.join(
      temporary,
      `${packageJson.name.replace("@", "").replace("/", "-")}-${packageJson.version}.tgz`
    )
    const consumer = path.join(temporary, "consumer")
    const installed = path.join(consumer, "node_modules", "@knpkv", "control-center-sql")
    yield* fileSystem.makeDirectory(installed, { recursive: true })
    yield* run("tar", ["-xzf", archive, "--strip-components=1", "-C", installed], packageRoot)

    for (const { file } of vendoredEntries) {
      const shipped = yield* fileSystem.readFileString(path.join(installed, "dist", vendorDirectory, file))
      const reason = unpatchedReason(`packed ${file}`, shipped)
      if (reason !== undefined) return yield* new VendoredEffectQbError({ reason })
    }

    const manifest = yield* fileSystem.readFileString(path.join(installed, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PackedManifest)),
      Effect.mapError((cause) => new VendoredEffectQbError({ cause, reason: "Could not decode the packed manifest" }))
    )
    const runtimeDependencies = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {})
    ]
    if (runtimeDependencies.includes("effect-qb")) {
      return yield* new VendoredEffectQbError({ reason: "the packed manifest still depends on effect-qb" })
    }
    for (const dependency of runtimeDependencies) {
      const link = path.join(consumer, "node_modules", dependency)
      yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true })
      yield* fileSystem.symlink(yield* fileSystem.realPath(path.join(packageRoot, "node_modules", dependency)), link)
    }
    yield* fileSystem.writeFileString(path.join(consumer, "package.json"), "{\"private\":true,\"type\":\"module\"}\n")
    yield* fileSystem.writeFileString(
      path.join(consumer, "verify.mjs"),
      `import { existsSync } from "node:fs"
import { renderCurrentReleaseReadinessQuery } from "@knpkv/control-center-sql"

if (existsSync("node_modules/effect-qb")) throw new Error("consumer unexpectedly has effect-qb installed")
const rendered = renderCurrentReleaseReadinessQuery({ workspaceId: "workspace", releaseIds: ["release-1", "release-2"] })
if (!rendered.sql.includes('from "readiness_release_heads"')) throw new Error("packed query did not render")
if ((rendered.sql.match(/\\?/gu) ?? []).length !== rendered.params.length) throw new Error("packed query parameters drifted")
`
    )
    yield* run("node", ["verify.mjs"], consumer)
    yield* Console.log("control-center-sql packed consumer rendered SQL through the vendored patched effect-qb")
  }).pipe(
    // The packed-consumer script is the executable boundary for Node services.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(NodeServices.layer)
  )
)

NodeRuntime.runMain(program)
