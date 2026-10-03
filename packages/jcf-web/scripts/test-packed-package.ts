/** Strictly consume the published archive, not the workspace's TypeScript source exports. */
import { NodeHttpClient } from "@effect/platform-node"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Config, Console, Effect, FileSystem, Option, Path, Predicate, Schema, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { createServer } from "node:net"
import { admitExternalDependency } from "./packedDependencyAdmission.js"

class PackedConsumerError extends Schema.TaggedError<PackedConsumerError>()("PackedConsumerError", {
  message: Schema.String
}) {}

const PackageJson = Schema.fromJsonString(Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String))
}))

const PackedPackageJson = Schema.fromJsonString(Schema.Struct({
  bin: Schema.Record(Schema.String, Schema.String)
}))

/** Release the probe before spawning the archive's listener; the child alone owns the selected port. */
const availableLoopbackPort = Effect.tryPromise({
  try: () =>
    new Promise<number>((resolve, reject) => {
      const probe = createServer()
      probe.once("error", reject)
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address()
        if (address === null || Predicate.isString(address)) {
          probe.close()
          reject(new PackedConsumerError({ message: "Port probe had no internet address" }))
          return
        }
        probe.close((error) => error === undefined ? resolve(address.port) : reject(error))
      })
    }),
  catch: () => new PackedConsumerError({ message: "Could not reserve an isolated loopback port" })
})

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

    const consumer = path.join(temporary, "consumer")
    const packageJson = yield* fs.readFileString(path.join(packageRoot, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PackageJson)),
      Effect.mapError(() => new PackedConsumerError({ message: "Could not decode jcf-web package identity" }))
    )
    const workspaceRoot = path.resolve(packageRoot, "../..")
    const frozenLockSource = yield* fs.readFileString(path.join(workspaceRoot, "pnpm-lock.yaml")).pipe(
      Effect.mapError(() => new PackedConsumerError({ message: "Could not read the frozen dependency lock" }))
    )
    const installedLockSource = yield* fs.readFileString(
      path.join(workspaceRoot, "node_modules", ".pnpm", "lock.yaml")
    ).pipe(
      Effect.mapError(() => new PackedConsumerError({ message: "Could not read the installed dependency lock" }))
    )
    const pending = [packageRoot]
    const packedRoots = new Map<string, string>()
    const archives = new Map<string, string>()
    const external = new Map<string, string>()
    for (let index = 0; index < pending.length; index++) {
      const sourceRoot = pending[index]
      if (sourceRoot === undefined) continue
      const sourceManifest = yield* fs.readFileString(path.join(sourceRoot, "package.json")).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(PackageJson)),
        Effect.mapError(() => new PackedConsumerError({ message: "Could not decode a production package identity" }))
      )
      const previous = packedRoots.get(sourceManifest.name)
      if (previous !== undefined) {
        if (previous !== sourceRoot) {
          return yield* new PackedConsumerError({ message: "Conflicting workspace package roots" })
        }
        continue
      }
      packedRoots.set(sourceManifest.name, sourceRoot)
      yield* run("pnpm", ["pack", "--pack-destination", temporary], sourceRoot)
      const packageArchive = path.join(
        temporary,
        `${sourceManifest.name.replace("@", "").replace("/", "-")}-${sourceManifest.version}.tgz`
      )
      archives.set(sourceManifest.name, packageArchive)
      const installedPackage = path.join(consumer, "node_modules", sourceManifest.name)
      yield* fs.makeDirectory(installedPackage, { recursive: true })
      yield* run("tar", ["-xzf", packageArchive, "--strip-components=1", "-C", installedPackage], temporary)
      for (const [dependency, version] of Object.entries(sourceManifest.dependencies ?? {})) {
        const installedDependency = path.join(sourceRoot, "node_modules", dependency)
        if (version.startsWith("workspace:")) {
          const dependencyRoot = yield* fs.realPath(installedDependency)
          const relative = path.relative(workspaceRoot, dependencyRoot)
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            return yield* new PackedConsumerError({ message: "Workspace dependency resolves outside this repository" })
          }
          const dependencyManifest = yield* fs.readFileString(path.join(dependencyRoot, "package.json")).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(PackageJson)),
            Effect.mapError(() => new PackedConsumerError({ message: "Could not decode a workspace dependency" }))
          )
          if (dependencyManifest.name !== dependency) {
            return yield* new PackedConsumerError({
              message: "Workspace dependency identity differs from its manifest"
            })
          }
          pending.push(dependencyRoot)
          continue
        }
        const resolved = yield* fs.realPath(installedDependency)
        const previousExternal = external.get(dependency)
        const installedManifestSource = yield* fs.readFileString(path.join(resolved, "package.json")).pipe(
          Effect.mapError(() => new PackedConsumerError({ message: "Could not read an installed dependency identity" }))
        )
        const importer = path.relative(workspaceRoot, sourceRoot).split(path.sep).join("/")
        yield* admitExternalDependency(
          {
            dependency,
            frozenLockSource,
            importer,
            installedLockSource,
            installedManifestSource,
            previousResolvedPath: previousExternal,
            requestedSpecifier: version,
            resolvedPath: resolved
          },
          ({ resolvedPath }) =>
            Effect.gen(function*() {
              external.set(dependency, resolvedPath)
              const link = path.join(consumer, "node_modules", dependency)
              yield* fs.makeDirectory(path.dirname(link), { recursive: true })
              yield* fs.symlink(resolvedPath, link)
            })
        ).pipe(
          Effect.mapError(() =>
            new PackedConsumerError({
              message: "Installed production dependency identity does not match the frozen lock"
            })
          )
        )
      }
    }
    for (const dependency of ["@types/node", "@types/react", "@types/react-dom"]) {
      const source = yield* fs.realPath(path.join(
        dependency === "@types/node" ? workspaceRoot : packageRoot,
        "node_modules",
        dependency
      ))
      const link = path.join(consumer, "node_modules", dependency)
      yield* fs.makeDirectory(path.dirname(link), { recursive: true })
      yield* fs.symlink(source, link)
    }
    const installed = path.join(consumer, "node_modules", "@knpkv", "jcf-web")
    const archive = path.join(
      temporary,
      `${packageJson.name.replace("@", "").replace("/", "-")}-${packageJson.version}.tgz`
    )

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
import { Time } from "@knpkv/jira-clockify"
import { makeFakeHeadless } from "@knpkv/jira-clockify/testing.js"
import type { Source } from "@knpkv/jira-clockify/agent/sourceConsumption.js"

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
const provider: Source = "clockify"
// @ts-expect-error The engine wildcard declaration must reject unknown providers.
const invalidProvider: Source = "other"
// @ts-expect-error The engine root export must retain its concrete functions.
const invalidTime = Time.notAnExport
// @ts-expect-error The testing seam must retain its concrete factory signature.
const invalidFake: number = makeFakeHeadless
void [request, result, invalidSeconds, invalidRoot, provider, invalidProvider, invalidTime, invalidFake]
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
    const engineArchive = archives.get("@knpkv/jira-clockify")
    if (engineArchive === undefined) {
      return yield* new PackedConsumerError({ message: "Production graph omitted the packed engine" })
    }
    const engineListing = yield* spawner.string(ChildProcess.make("tar", ["-tf", engineArchive], {
      cwd: temporary
    })).pipe(Effect.mapError(() => new PackedConsumerError({ message: "Could not inspect packed engine archive" })))
    const engineFiles = new Set(engineListing.split("\n"))
    for (
      const file of [
        "package/dist/src/index.d.ts",
        "package/dist/src/testing/fakeHeadless.d.ts",
        "package/dist/src/agent/sourceConsumption.d.ts"
      ]
    ) {
      if (!engineFiles.has(file)) {
        return yield* new PackedConsumerError({ message: "Packed engine declaration is missing" })
      }
    }
    const packed = yield* fs.readFileString(path.join(installed, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PackedPackageJson)),
      Effect.mapError(() => new PackedConsumerError({ message: "Packed executable mapping is missing" }))
    )
    const executable = packed.bin["jcf-web"]
    if (executable !== "dist/main.js" || !files.has(`package/${executable}`)) {
      return yield* new PackedConsumerError({ message: "Packed executable is not built into the archive" })
    }

    const port = yield* availableLoopbackPort
    const home = path.join(temporary, "isolated-home")
    yield* fs.makeDirectory(home, { recursive: true })
    const pathVariable = yield* Config.string("PATH")
    const child = yield* Effect.acquireRelease(
      spawner.spawn(ChildProcess.make("node", [path.join(installed, executable)], {
        cwd: consumer,
        env: { HOME: home, XDG_CONFIG_HOME: home, PATH: pathVariable, PORT: String(port) },
        extendEnv: false,
        stdout: "pipe",
        stderr: "inherit"
      })),
      (handle) => handle.kill().pipe(Effect.ignore)
    )
    const advertisedLine = yield* Stream.decodeText(child.stdout).pipe(
      Stream.splitLines,
      Stream.filter((line) => line.startsWith("jcf week view: ")),
      Stream.runHead,
      Effect.timeout("15 seconds")
    )
    if (Option.isNone(advertisedLine)) {
      return yield* new PackedConsumerError({
        message: "Packed executable closed stdout before advertising its listener"
      })
    }
    const advertised = new URL(advertisedLine.value.slice("jcf week view: ".length))
    if (advertised.origin !== `http://127.0.0.1:${port}` || advertised.hash === "") {
      return yield* new PackedConsumerError({ message: "Packed executable advertised an unexpected origin" })
    }
    const response = yield* HttpClient.get(advertised.origin)
    const html = yield* response.text
    const asset = /src="([^"]+\.js)"/u.exec(html)?.[1]
    if (response.status !== 200 || !html.includes("id=\"root\"") || asset === undefined) {
      return yield* new PackedConsumerError({ message: "Packed executable did not serve its built client" })
    }
    const assetResponse = yield* HttpClient.get(new URL(asset, advertised.origin).href)
    if (assetResponse.status !== 200 || !(assetResponse.headers["content-type"]?.includes("javascript") ?? false)) {
      return yield* new PackedConsumerError({ message: "Packed executable did not serve its client asset" })
    }
    yield* Console.log("jcf-web packed strict consumer verified declarations, executable, and built client")
  }).pipe(
    // This packed-consumer executable is the Node service entry point.
    Effect.provide([NodeServices.layer, NodeHttpClient.layerFetch])
  )
)

NodeRuntime.runMain(program)
