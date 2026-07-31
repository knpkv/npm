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

const PackageJson = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    version: Schema.String
  })
)

const runChecked = Effect.fn("controlCenter.runPackedCommand")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  cwd: string
) {
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make(command, args, {
        cwd,
        stderr: "inherit",
        stdout: "inherit"
      })
    )
    .pipe(Effect.mapError(() => new PackedPackageError({ reason: `${command} ${args.join(" ")} could not run` })))
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new PackedPackageError({
      reason: `${command} ${args.join(" ")} exited with code ${exitCode}`
    })
  }
})

const program = Effect.scoped(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
    const temporary = yield* fs.makeTempDirectoryScoped({
      prefix: "control-center-packed-consumer-"
    })
    const packageSource = yield* fs.readFileString(path.join(packageRoot, "package.json"))
    const packageJson = yield* Schema.decodeUnknownEffect(PackageJson)(packageSource).pipe(
      Effect.mapError(() => new PackedPackageError({ reason: "Could not decode Control Center package identity" }))
    )

    yield* runChecked(spawner, "npm", ["pack", "--silent", "--pack-destination", temporary], packageRoot)
    const archiveName = `${packageJson.name.replace("@", "").replace("/", "-")}-${packageJson.version}.tgz`
    const archive = path.join(temporary, archiveName)
    const consumer = path.join(temporary, "consumer")
    const installScope = path.join(consumer, "node_modules", "@knpkv")
    const installedPackage = path.join(installScope, "control-center")
    const effectPackage = yield* fs.realPath(path.join(packageRoot, "..", "..", "node_modules", "effect"))
    yield* fs.makeDirectory(installScope, { recursive: true })
    yield* fs.writeFileString(
      path.join(consumer, "package.json"),
      `${
        JSON.stringify(
          {
            private: true,
            type: "module"
          },
          null,
          2
        )
      }\n`
    )
    yield* runChecked(spawner, "tar", ["-xzf", archive, "-C", installScope], consumer)
    yield* fs.rename(path.join(installScope, "package"), installedPackage)
    yield* fs.symlink(effectPackage, path.join(consumer, "node_modules", "effect"))

    yield* fs.writeFileString(
      path.join(consumer, "verify.mjs"),
      `import * as Effect from "effect/Effect"
import { decodeCodePipelineStateProviderOutput } from "./node_modules/@knpkv/control-center/dist/server/server/internal/codepipeline-state-probe.js"

const state = (currentRevision) => ({
  pipelineName: "release",
  pipelineVersion: 7,
  stageStates: [{
    stageName: "Source",
    actionStates: [{
      actionName: "Checkout",
      currentRevision
    }]
  }]
})

const revisionOnly = await Effect.runPromise(
  decodeCodePipelineStateProviderOutput(state({ revisionId: "fixture-commit" }))
)
if (revisionOnly.stageStates?.[0]?.actionStates?.[0]?.currentRevision?.revisionId !== "fixture-commit") {
  throw new Error("Packed decoder rejected or changed a revisionId-only state")
}

await Effect.runPromise(
  decodeCodePipelineStateProviderOutput(state({
    revisionId: "fixture-commit",
    revisionChangeId: "fixture-change",
    created: new Date("2026-07-31T09:00:00.000Z")
  }))
)

let rejectedMissingRevisionId = false
try {
  await Effect.runPromise(
    decodeCodePipelineStateProviderOutput(state({ revisionChangeId: "fixture-change" }))
  )
} catch {
  rejectedMissingRevisionId = true
}
if (!rejectedMissingRevisionId) {
  throw new Error("Packed decoder accepted a current revision without revisionId")
}
`
    )
    yield* runChecked(spawner, "node", ["verify.mjs"], consumer)
    yield* Console.log("control-center packed consumer verified shipped CodePipeline state decoding")
  }).pipe(Effect.provide(NodeServices.layer))
)

NodeRuntime.runMain(program)
