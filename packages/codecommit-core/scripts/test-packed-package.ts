import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { ChildProcessSpawner } from "effect/unstable/process"
import { PackedPackageError, runCheckedCommand } from "./checked-command.js"

const PackageJson = Schema.fromJsonString(Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  dependencies: Schema.Struct({ "@distilled.cloud/aws": Schema.Literal("0.29.1") })
}))

const runtimeDependencies: ReadonlyArray<string> = [
  "@aws-sdk/credential-providers",
  "@distilled.cloud/aws",
  "@effect/sql-libsql",
  "@libsql/client",
  "effect"
]

const program = Effect.scoped(
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
    const temporary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-core-packed-consumer-" })

    const packageJson = yield* fileSystem.readFileString(path.join(packageRoot, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PackageJson)),
      Effect.mapError(() => new PackedPackageError({ reason: "Could not decode package identity" }))
    )
    yield* runCheckedCommand(spawner, "pnpm", ["pack", "--pack-destination", temporary], packageRoot)

    const archiveName = `${packageJson.name.replace("@", "").replace("/", "-")}-${packageJson.version}.tgz`
    const archive = path.join(temporary, archiveName)
    const consumer = path.join(temporary, "consumer")
    const installedPackage = path.join(consumer, "node_modules", "@knpkv", "codecommit-core")
    yield* fileSystem.makeDirectory(installedPackage, { recursive: true })
    yield* runCheckedCommand(
      spawner,
      "tar",
      ["-xzf", archive, "--strip-components=1", "-C", installedPackage],
      packageRoot
    )
    yield* Effect.forEach(
      runtimeDependencies,
      (dependency) => {
        const link = path.join(consumer, "node_modules", dependency)
        return fileSystem.makeDirectory(path.dirname(link), { recursive: true }).pipe(
          Effect.andThen(fileSystem.symlink(path.join(packageRoot, "node_modules", dependency), link))
        )
      },
      { discard: true }
    )
    yield* fileSystem.writeFileString(
      path.join(consumer, "verify.mjs"),
      `import "@knpkv/codecommit-core/ReadClient.js"
import * as ReviewClient from "@knpkv/codecommit-core/ReviewClient.js"
import * as AwsRetry from "@distilled.cloud/aws/Retry"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"

if (ReviewClient.CodeCommitReviewClient === undefined) {
  throw new Error("CodeCommit review client public export is missing")
}
const lastError = await Effect.runPromise(Ref.make(undefined))
const policy = AwsRetry.makeDefault(lastError)
if (policy.schedule === undefined) throw new Error("Distilled AWS retry policy was not constructed")
`
    )

    yield* runCheckedCommand(spawner, "node", ["verify.mjs"], consumer)
    yield* Console.log("codecommit-core packed consumer verified public clients and the Distilled AWS runtime")
  }).pipe(Effect.provide(NodeServices.layer))
)

NodeRuntime.runMain(program)
