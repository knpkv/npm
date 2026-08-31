import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const pnpmVersion = "11.21.0"
const pnpmExecutable = "corepack"
const pnpmInvocation = [`pnpm@${pnpmVersion}`]

class PackError extends Data.TaggedError("PackError") {
  get message() {
    return this.reason
  }
}

const JsonObject = Schema.Record(Schema.String, Schema.Json)
const JsonObjectString = Schema.fromJsonString(JsonObject)
const CanonicalJsonObjectString = Schema.fromJsonString(JsonObject, { space: 2 })
const PackageIdentity = Schema.Struct({
  files: Schema.Array(Schema.String),
  name: Schema.String,
  version: Schema.String
})
const PackageCandidate = Schema.Struct({
  name: Schema.String,
  version: Schema.optionalKey(Schema.String)
})
const WorkspaceIdentity = Schema.Struct({ packageManager: Schema.String })
const Dependencies = Schema.Record(Schema.String, Schema.String)

const mapPackError = (reason) => (cause) => new PackError({ cause, reason })

const readJson = Effect.fn("HerdrPack.readJson")(function* (fileSystem, file) {
  const contents = yield* fileSystem.readFileString(file).pipe(Effect.mapError(mapPackError(`Could not read ${file}`)))
  return yield* Schema.decodeUnknownEffect(JsonObjectString)(contents).pipe(
    Effect.mapError(mapPackError(`Could not decode ${file}`))
  )
})

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical)
  if (!Schema.is(JsonObject)(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)])
  )
}

const collectVersions = Effect.fn("HerdrPack.collectVersions")(function* (fileSystem, path, workspaceRoot) {
  const versions = new Map()
  const packagesRoot = path.join(workspaceRoot, "packages")
  for (const directory of yield* fileSystem
    .readDirectory(packagesRoot)
    .pipe(Effect.mapError(mapPackError("Could not list workspace packages")))) {
    const candidateRoot = path.join(packagesRoot, directory)
    const info = yield* fileSystem
      .stat(candidateRoot)
      .pipe(Effect.mapError(mapPackError(`Could not inspect ${candidateRoot}`)))
    if (info.type !== "Directory") continue
    const candidate = yield* readJson(fileSystem, path.join(candidateRoot, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PackageCandidate)),
      Effect.mapError(mapPackError(`Could not decode ${directory} package identity`))
    )
    if (candidate.version !== undefined) {
      versions.set(candidate.name, candidate.version)
    }
  }
  return versions
})

const rewriteDependency = Effect.fn("HerdrPack.rewriteDependency")(function* (versions, name, range) {
  if (!range.startsWith("workspace:")) return [name, range]
  const version = versions.get(name)
  if (version === undefined) {
    return yield* new PackError({ reason: `Missing workspace package ${name}` })
  }
  const protocol = range.slice("workspace:".length)
  if (protocol === "^") return [name, `^${version}`]
  if (protocol === "~") return [name, `~${version}`]
  if (protocol === "*") return [name, version]
  return [name, protocol]
})

const publishDependencies = Effect.fn("HerdrPack.publishDependencies")(function* (versions, dependencies) {
  const decoded = yield* Schema.decodeUnknownEffect(Dependencies)(dependencies).pipe(
    Effect.mapError(mapPackError("Could not decode package dependencies"))
  )
  const rewritten = yield* Effect.forEach(Object.entries(decoded), ([name, range]) =>
    rewriteDependency(versions, name, range)
  )
  return Object.fromEntries(rewritten)
})

const runCommand = Effect.fn("HerdrPack.runCommand")(function* (spawner, stdio, executable, args, cwd, disableScripts) {
  const options = disableScripts
    ? {
        cwd,
        env: { npm_config_ignore_scripts: "true" },
        extendEnv: true,
        stderr: "pipe",
        stdout: "pipe"
      }
    : { cwd, stderr: "pipe", stdout: "pipe" }
  const handle = yield* spawner
    .spawn(ChildProcess.make(executable, args, options))
    .pipe(Effect.mapError(mapPackError(`Could not run ${executable} ${args.join(" ")}`)))
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.decodeText(handle.stdout).pipe(Stream.mkString),
      Stream.decodeText(handle.stderr).pipe(Stream.mkString),
      handle.exitCode
    ],
    { concurrency: "unbounded" }
  )
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    yield* Stream.make(stdout, stderr).pipe(Stream.run(stdio.stderr()))
    return yield* new PackError({
      reason: `${executable} ${args.join(" ")} exited with code ${exitCode}`
    })
  }
  return stdout
})

const program = Effect.scoped(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const stdio = yield* Stdio.Stdio
    const args = (yield* stdio.args).filter((value) => value !== "--")
    if (args.length < 1 || args.length > 2) {
      return yield* new PackError({
        reason: "Usage: pack-herdr.mjs <package-root> [destination]"
      })
    }
    const packageRoot = path.resolve(args[0])
    const destination = path.resolve(args[1] ?? packageRoot)
    const workspaceRoot = path.resolve(packageRoot, "../..")
    const manifest = yield* readJson(fileSystem, path.join(packageRoot, "package.json"))
    const identity = yield* Schema.decodeUnknownEffect(PackageIdentity)(manifest).pipe(
      Effect.mapError(mapPackError("Could not decode package identity"))
    )
    const versions = yield* collectVersions(fileSystem, path, workspaceRoot)
    const publishableManifest = Object.fromEntries(
      Object.entries(manifest).filter(([key]) => key !== "devDependencies" && key !== "pnpm")
    )
    const dependencyEntries = []
    for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      if (manifest[key] !== undefined) {
        dependencyEntries.push([key, yield* publishDependencies(versions, manifest[key])])
      }
    }
    const publishManifest = canonical({
      ...publishableManifest,
      ...Object.fromEntries(dependencyEntries)
    })
    const staging = yield* fileSystem
      .makeTempDirectoryScoped({
        prefix: `pack-${path.basename(packageRoot)}-`
      })
      .pipe(Effect.mapError(mapPackError("Could not create pack staging directory")))
    for (const entry of identity.files) {
      const target = path.join(staging, entry)
      yield* fileSystem
        .makeDirectory(path.dirname(target), {
          recursive: true
        })
        .pipe(Effect.mapError(mapPackError(`Could not create ${target}`)))
      yield* fileSystem
        .copy(path.join(packageRoot, entry), target, {
          overwrite: true
        })
        .pipe(Effect.mapError(mapPackError(`Could not stage ${entry}`)))
    }
    yield* fileSystem
      .copyFile(path.join(workspaceRoot, "LICENSE"), path.join(staging, "LICENSE"))
      .pipe(Effect.mapError(mapPackError("Could not stage LICENSE")))
    const manifestText = yield* Schema.encodeUnknownEffect(CanonicalJsonObjectString)(publishManifest).pipe(
      Effect.mapError(mapPackError("Could not encode publish manifest"))
    )
    yield* fileSystem
      .writeFileString(path.join(staging, "package.json"), `${manifestText}\n`)
      .pipe(Effect.mapError(mapPackError("Could not stage package.json")))
    yield* fileSystem
      .makeDirectory(destination, { recursive: true })
      .pipe(Effect.mapError(mapPackError(`Could not create ${destination}`)))
    const workspaceManifest = yield* readJson(fileSystem, path.join(workspaceRoot, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(WorkspaceIdentity)),
      Effect.mapError(mapPackError("Could not decode workspace package manager"))
    )
    if (workspaceManifest.packageManager !== `pnpm@${pnpmVersion}`) {
      return yield* new PackError({
        reason: `Expected workspace pnpm@${pnpmVersion}, got ${workspaceManifest.packageManager}`
      })
    }
    const actualVersion = (yield* runCommand(
      spawner,
      stdio,
      pnpmExecutable,
      [...pnpmInvocation, "--version"],
      staging,
      false
    )).trim()
    if (actualVersion !== pnpmVersion) {
      return yield* new PackError({
        reason: `Expected pnpm ${pnpmVersion}, got ${actualVersion}`
      })
    }
    const output = yield* runCommand(
      spawner,
      stdio,
      pnpmExecutable,
      [...pnpmInvocation, "pack", "--pack-destination", destination],
      staging,
      true
    )
    yield* Stream.make(output).pipe(Stream.run(stdio.stdout()))
  })
)

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) =>
      Effect.gen(function* () {
        const stdio = yield* Stdio.Stdio
        yield* Stream.make(`${error.message}\n`).pipe(Stream.run(stdio.stderr()))
      })
    ),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
