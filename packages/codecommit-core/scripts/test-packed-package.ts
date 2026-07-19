import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

class PackedPackageError extends Data.TaggedError("PackedPackageError")<{
  readonly reason: string
}> {}

const PackageJson = Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String }))

const program = Effect.scoped(
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
    const temporary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-core-packed-consumer-" })

    const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
      spawner.string(ChildProcess.make(command, args, { cwd })).pipe(
        Effect.mapError(() => new PackedPackageError({ reason: `${command} ${args.join(" ")} failed` }))
      )

    const packageJson = yield* fileSystem.readFileString(path.join(packageRoot, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PackageJson)),
      Effect.mapError(() => new PackedPackageError({ reason: "Could not decode package identity" }))
    )
    yield* run("pnpm", ["pack", "--pack-destination", temporary], packageRoot)

    const archiveName = `${packageJson.name.replace("@", "").replace("/", "-")}-${packageJson.version}.tgz`
    const archive = path.join(temporary, archiveName)
    const consumer = path.join(temporary, "consumer")
    yield* fileSystem.makeDirectory(consumer, { recursive: true })
    yield* fileSystem.writeFileString(
      path.join(consumer, "package.json"),
      `${
        JSON.stringify(
          {
            private: true,
            type: "module",
            dependencies: { "@knpkv/codecommit-core": `file:${archive}` }
          },
          null,
          2
        )
      }\n`
    )
    yield* fileSystem.writeFileString(
      path.join(consumer, "verify.mjs"),
      `import "@knpkv/codecommit-core/ReadClient.js"
import * as AwsRetry from "@distilled.cloud/aws/Retry"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"

const lastError = await Effect.runPromise(Ref.make(undefined))
const policy = AwsRetry.makeDefault(lastError)
if (policy.schedule === undefined) throw new Error("Distilled AWS retry policy was not constructed")
`
    )

    yield* run("pnpm", ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], consumer)
    yield* run("node", ["verify.mjs"], consumer)
    yield* Console.log("codecommit-core packed consumer verified the published Distilled AWS runtime")
  }).pipe(Effect.provide(NodeServices.layer))
)

NodeRuntime.runMain(program)
