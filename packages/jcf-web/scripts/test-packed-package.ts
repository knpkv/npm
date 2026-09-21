/** Strictly consume the published archive, not the workspace's TypeScript source exports. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Console, Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

class PackedConsumerError extends Schema.TaggedError<PackedConsumerError>()("PackedConsumerError", {
  message: Schema.String
}) {}

const PackageJson = Schema.fromJsonString(Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  dependencies: Schema.Record(Schema.String, Schema.String)
}))

const program = Effect.scoped(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "jcf-web-packed-consumer-" })

    const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
      Effect.gen(function*() {
        const exitCode = yield* spawner.exitCode(ChildProcess.make(command, args, {
          cwd,
          stdout: "inherit",
          stderr: "inherit"
        })).pipe(Effect.mapError(() => new PackedConsumerError({ message: `${command} could not run` })))
        if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
          return yield* new PackedConsumerError({ message: `${command} failed with exit code ${exitCode}` })
        }
      })

    const packageJson = yield* fs.readFileString(path.join(packageRoot, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PackageJson)),
      Effect.mapError(() => new PackedConsumerError({ message: "Could not decode jcf-web package identity" }))
    )
    yield* run("pnpm", ["pack", "--pack-destination", temporary], packageRoot)

    const archiveName = `${packageJson.name.replace("@", "").replace("/", "-")}-${packageJson.version}.tgz`
    const archive = path.join(temporary, archiveName)
    const consumer = path.join(temporary, "consumer")
    const installed = path.join(consumer, "node_modules", "@knpkv", "jcf-web")
    yield* fs.makeDirectory(installed, { recursive: true })
    yield* run("tar", ["-xzf", archive, "--strip-components=1", "-C", installed], temporary)

    for (
      const dependency of [...Object.keys(packageJson.dependencies), "@types/node", "@types/react", "@types/react-dom"]
    ) {
      const link = path.join(consumer, "node_modules", dependency)
      const source = dependency === "@types/node"
        ? path.join(packageRoot, "..", "..", "node_modules", dependency)
        : path.join(packageRoot, "node_modules", dependency)
      yield* fs.makeDirectory(path.dirname(link), { recursive: true })
      yield* fs.symlink(source, link)
    }

    yield* fs.writeFileString(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }))
    yield* fs.writeFileString(
      path.join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          strict: true,
          target: "ES2022",
          types: ["node"]
        },
        include: ["verify.ts"]
      })
    )
    yield* fs.writeFileString(
      path.join(consumer, "verify.ts"),
      `import { Api, WeekPlans } from "@knpkv/jcf-web"
import type { ManualRequest } from "@knpkv/jcf-web/server/Confirm.js"

const request: ManualRequest = {
  day: "2026-07-01",
  ticketKey: "PROJ-42",
  seconds: 1800,
  startClock: "10:00",
  note: undefined,
  targets: { clockify: true, jira: false }
}
const result: Api.WriteResultResponse = {
  clockify: { _tag: "Skipped" },
  jira: { _tag: "Skipped" },
  description: "",
  lines: []
}
// @ts-expect-error Public seconds remain numeric, not an implicit-any export.
const invalidSeconds: ManualRequest["seconds"] = "1800"
// @ts-expect-error The root namespace must also retain its concrete exports.
const invalidRoot = WeekPlans.notAnExport
void [request, result, invalidSeconds, invalidRoot]
`
    )
    yield* run(path.join(packageRoot, "..", "..", "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], consumer)

    const listing = yield* spawner.string(ChildProcess.make("tar", ["-tf", archive], { cwd: temporary })).pipe(
      Effect.mapError(() => new PackedConsumerError({ message: "Could not inspect packed jcf-web archive" }))
    )
    const files = new Set(listing.split("\n"))
    if (!files.has("package/dist/index.d.ts") || !files.has("package/dist/server/Confirm.d.ts")) {
      return yield* new PackedConsumerError({ message: "Packed root or server declaration is missing" })
    }
    if ([...files].some((file) => file.startsWith("package/src/"))) {
      return yield* new PackedConsumerError({ message: "Packed archive exposes source files" })
    }
    yield* Console.log("jcf-web packed strict consumer verified root and server types")
  }).pipe(
    // This packed-consumer executable is the Node service entry point.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(NodeServices.layer)
  )
)

NodeRuntime.runMain(program)
