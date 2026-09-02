import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

class HerdrPackContractError extends Data.TaggedError("HerdrPackContractError")<{
  readonly cause?: unknown
  readonly reason: string
}> {}

const PackageSideEffects = Schema.Array(Schema.String)
const HerdrPackFailure = Schema.TaggedStruct("HerdrPackContractError", {
  reason: Schema.String
})
const PackageManifest = Schema.fromJsonString(Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  exports: Schema.optionalKey(Schema.Json),
  files: Schema.Array(Schema.String),
  name: Schema.String,
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  sideEffects: Schema.optionalKey(Schema.Union([Schema.Literal(false), PackageSideEffects])),
  version: Schema.String
}))

const herdrPackages = [
  "herdr-tailscale",
  "herdr-fleet",
  "herdr-connect",
  "herdr-coordinator",
  "herdr-work",
  "herdr-approvals"
]

const reactSurfacePeers = new Map<string, ReadonlyArray<string>>([
  ["@knpkv/herdr-connect", ["react", "react-dom"]],
  ["@knpkv/herdr-work", ["react"]],
  ["@knpkv/herdr-approvals", ["react", "react-dom"]]
])

const commandError = (command: string, args: ReadonlyArray<string>, cause?: unknown) =>
  new HerdrPackContractError({ cause, reason: `${command} ${args.join(" ")} failed` })

const run = Effect.fn("HerdrPackContract.run")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  cwd: string
) {
  const handle = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd, stderr: "pipe", stdout: "pipe" })
  ).pipe(Effect.mapError((cause) => commandError(command, args, cause)))
  const [stdout, stderr, exitCode] = yield* Effect.all([
    Stream.decodeText(handle.stdout).pipe(Stream.mkString),
    Stream.decodeText(handle.stderr).pipe(Stream.mkString),
    handle.exitCode
  ], { concurrency: "unbounded" })
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new HerdrPackContractError({
      reason: `${command} ${args.join(" ")} exited with code ${exitCode}: ${stderr.trim()}`
    })
  }
  return stdout
})

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])

const archiveNameFor = (name: string, version: string): string =>
  `${name.replace("@", "").replace("/", "-")}-${version}.tgz`

const expectedFiles = Effect.fn("HerdrPackContract.expectedFiles")(function*(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  packageRoot: string,
  entries: ReadonlyArray<string>
) {
  const expected = ["package/LICENSE", "package/package.json"]
  for (const entry of entries) {
    const source = path.join(packageRoot, entry)
    const info = yield* fileSystem.stat(source).pipe(
      Effect.mapError((cause) => new HerdrPackContractError({ cause, reason: `Could not inspect ${source}` }))
    )
    if (info.type === "File") {
      expected.push(`package/${entry}`)
      continue
    }
    if (info.type !== "Directory") {
      return yield* new HerdrPackContractError({ reason: `Packed entry is not a file or directory: ${entry}` })
    }
    const children = yield* fileSystem.readDirectory(source, { recursive: true }).pipe(
      Effect.mapError((cause) => new HerdrPackContractError({ cause, reason: `Could not list ${source}` }))
    )
    for (const child of children) {
      const childInfo = yield* fileSystem.stat(path.join(source, child)).pipe(
        Effect.mapError((cause) => new HerdrPackContractError({ cause, reason: `Could not inspect ${child}` }))
      )
      if (childInfo.type === "File") expected.push(`package/${entry}/${child}`)
    }
  }
  return expected.sort()
})

const assertManifestDependencies = (name: string, manifest: typeof PackageManifest.Type) => {
  const groups = [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]
  for (const dependencies of groups) {
    if (dependencies === undefined) continue
    for (const [dependency, range] of Object.entries(dependencies)) {
      if (
        range.startsWith("workspace:") ||
        range.startsWith("link:") ||
        range.startsWith("file:") ||
        range.startsWith("/")
      ) {
        return Effect.fail(
          new HerdrPackContractError({
            reason: `${name} packed dependency ${dependency} has a local range: ${range}`
          })
        )
      }
    }
  }
  return manifest.devDependencies === undefined
    ? Effect.void
    : Effect.fail(new HerdrPackContractError({ reason: `${name} packed devDependencies` }))
}

const assertReactSurfaceManifest = (
  name: string,
  manifest: typeof PackageManifest.Type,
  requireDevelopmentRuntime: boolean
) => {
  const peers = reactSurfacePeers.get(name)
  if (peers === undefined) return Effect.void
  for (const peer of peers) {
    if (manifest.dependencies?.[peer] !== undefined) {
      return Effect.fail(new HerdrPackContractError({ reason: `${name} owns runtime dependency ${peer}` }))
    }
    if (manifest.peerDependencies?.[peer] === undefined) {
      return Effect.fail(new HerdrPackContractError({ reason: `${name} does not require React peer ${peer}` }))
    }
    if (requireDevelopmentRuntime && manifest.devDependencies?.[peer] === undefined) {
      return Effect.fail(new HerdrPackContractError({ reason: `${name} cannot build against React peer ${peer}` }))
    }
  }
  return Effect.void
}

const program = Effect.scoped(
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const script = yield* path.fromFileUrl(new URL(import.meta.url))
    const packageRoot = path.dirname(path.dirname(script))
    const workspaceRoot = path.dirname(path.dirname(packageRoot))
    const first = yield* fileSystem.makeTempDirectoryScoped({ prefix: "herdr-pack-first-" })
    const second = yield* fileSystem.makeTempDirectoryScoped({ prefix: "herdr-pack-second-" })
    const archives = new Map<string, string>()

    const stagedPnpmVersion = (yield* run(spawner, "corepack", ["pnpm@11.21.0", "--version"], first)).trim()
    if (stagedPnpmVersion !== "11.21.0") {
      return yield* new HerdrPackContractError({
        reason: `Staging did not resolve pnpm@11.21.0: ${stagedPnpmVersion}`
      })
    }

    const cleanWorkspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "herdr-pack-clean-" })
    const cleanPackage = path.join(cleanWorkspace, "packages", "sample")
    yield* fileSystem.makeDirectory(cleanPackage, { recursive: true })
    yield* fileSystem.writeFileString(
      path.join(cleanWorkspace, "package.json"),
      "{\"packageManager\":\"pnpm@11.21.0\"}\n"
    )
    yield* fileSystem.writeFileString(path.join(cleanWorkspace, "LICENSE"), "license\n")
    yield* fileSystem.writeFileString(
      path.join(cleanPackage, "package.json"),
      `${
        JSON.stringify({
          dependencies: { "@test/not-installed": "99.99.99" },
          files: ["README.md", "prepack-marker"],
          name: "@test/sample",
          scripts: {
            prepack: "node -e \"require('node:fs').writeFileSync('prepack-marker', 'ran')\""
          },
          version: "1.0.0"
        })
      }\n`
    )
    yield* fileSystem.writeFileString(path.join(cleanPackage, "README.md"), "fixture\n")
    yield* fileSystem.writeFileString(path.join(cleanPackage, "prepack-marker"), "source")
    const cleanArchive = path.join(first, "test-sample-1.0.0.tgz")
    yield* run(
      spawner,
      "node",
      [path.join(workspaceRoot, "scripts", "pack-herdr.mjs"), cleanPackage, first],
      cleanWorkspace
    )
    const cleanListing = (yield* run(spawner, "tar", ["-tzf", cleanArchive], cleanWorkspace))
      .split("\n")
      .filter((entry) => entry !== "")
      .sort()
    const cleanExpected = yield* expectedFiles(fileSystem, path, cleanPackage, ["README.md", "prepack-marker"])
    if (JSON.stringify(cleanListing) !== JSON.stringify(cleanExpected)) {
      return yield* new HerdrPackContractError({
        reason: `Clean staged manifest packed unexpected files: ${JSON.stringify({ cleanExpected, cleanListing })}`
      })
    }
    const cleanManifest = yield* Schema.decodeUnknownEffect(PackageManifest)(
      yield* run(spawner, "tar", ["-xOf", cleanArchive, "package/package.json"], cleanWorkspace)
    ).pipe(
      Effect.mapError((cause) =>
        new HerdrPackContractError({ cause, reason: "Could not decode clean packed manifest" })
      )
    )
    if (
      cleanManifest.dependencies?.["@test/not-installed"] !== "99.99.99" || cleanManifest.devDependencies !== undefined
    ) {
      return yield* new HerdrPackContractError({
        reason: "Clean staged manifest did not pack without installing dependencies"
      })
    }
    const cleanPrepackMarker = yield* run(
      spawner,
      "tar",
      ["-xOf", cleanArchive, "package/prepack-marker"],
      cleanWorkspace
    )
    if (cleanPrepackMarker !== "source") {
      return yield* new HerdrPackContractError({
        reason: `Clean staged pack ran prepack scripts: ${JSON.stringify(cleanPrepackMarker)}`
      })
    }

    if (archiveNameFor("@knpkv/herdr-approvals", "0.2.0") !== "knpkv-herdr-approvals-0.2.0.tgz") {
      return yield* new HerdrPackContractError({ reason: "Archive naming does not preserve package versions" })
    }

    const invalidWorkspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "herdr-pack-invalid-" })
    const invalidPackage = path.join(invalidWorkspace, "packages", "sample")
    yield* fileSystem.makeDirectory(invalidPackage, { recursive: true })
    for (const generatedDirectory of ["relay-product", "review"]) {
      yield* fileSystem.makeDirectory(path.join(invalidWorkspace, "packages", generatedDirectory), {
        recursive: true
      })
    }
    yield* fileSystem.writeFileString(
      path.join(invalidPackage, "package.json"),
      `${
        JSON.stringify({
          dependencies: { "@test/missing": "workspace:^" },
          files: ["README.md"],
          name: "@test/sample",
          version: "1.0.0"
        })
      }\n`
    )
    yield* fileSystem.writeFileString(path.join(invalidPackage, "README.md"), "fixture\n")
    const missingWorkspace = yield* Effect.result(run(
      spawner,
      "node",
      [path.join(workspaceRoot, "scripts", "pack-herdr.mjs"), invalidPackage],
      workspaceRoot
    ))
    if (Result.isSuccess(missingWorkspace)) {
      return yield* new HerdrPackContractError({
        reason: "Missing workspace dependencies do not fail through the named pack error channel"
      })
    }
    const missingWorkspaceFailure = Schema.decodeUnknownResult(HerdrPackFailure)(missingWorkspace.failure)
    if (
      Result.isFailure(missingWorkspaceFailure) ||
      missingWorkspaceFailure.success.reason.includes("Missing workspace package @test/missing") === false
    ) {
      return yield* new HerdrPackContractError({
        reason: "Missing workspace dependencies do not fail through the named pack error channel"
      })
    }

    for (const directory of herdrPackages) {
      const sourceRoot = path.join(workspaceRoot, "packages", directory)
      const sourceManifest = yield* fileSystem.readFileString(path.join(sourceRoot, "package.json")).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(PackageManifest)),
        Effect.mapError((cause) => new HerdrPackContractError({ cause, reason: `Could not decode ${directory}` }))
      )
      yield* assertReactSurfaceManifest(sourceManifest.name, sourceManifest, true)
      yield* run(
        spawner,
        "pnpm",
        ["--filter", sourceManifest.name, "run", "pack:deterministic", "--", first],
        workspaceRoot
      )
      yield* run(
        spawner,
        "pnpm",
        ["--filter", sourceManifest.name, "run", "pack:deterministic", "--", second],
        workspaceRoot
      )
      const archiveName = archiveNameFor(sourceManifest.name, sourceManifest.version)
      const firstArchive = path.join(first, archiveName)
      archives.set(sourceManifest.name, firstArchive)
      const secondArchive = path.join(second, archiveName)
      const [firstBytes, secondBytes] = yield* Effect.all([
        fileSystem.readFile(firstArchive),
        fileSystem.readFile(secondArchive)
      ]).pipe(
        Effect.mapError((cause) => new HerdrPackContractError({ cause, reason: `Could not read ${archiveName}` }))
      )
      if (!sameBytes(firstBytes, secondBytes)) {
        return yield* new HerdrPackContractError({ reason: `${sourceManifest.name} packs are not byte-identical` })
      }
      const listing = (yield* run(spawner, "tar", ["-tzf", firstArchive], workspaceRoot))
        .split("\n")
        .filter((entry) => entry !== "")
        .sort()
      const expected = yield* expectedFiles(fileSystem, path, sourceRoot, sourceManifest.files)
      if (JSON.stringify(listing) !== JSON.stringify(expected)) {
        return yield* new HerdrPackContractError({
          reason: `${sourceManifest.name} packed files differ: ${JSON.stringify({ expected, listing })}`
        })
      }
      const packedManifestText = yield* run(
        spawner,
        "tar",
        ["-xOf", firstArchive, "package/package.json"],
        workspaceRoot
      )
      const packedManifest = yield* Schema.decodeUnknownEffect(PackageManifest)(packedManifestText).pipe(
        Effect.mapError((cause) =>
          new HerdrPackContractError({
            cause,
            reason: `Could not decode packed ${sourceManifest.name} manifest`
          })
        )
      )
      yield* assertManifestDependencies(sourceManifest.name, packedManifest)
      yield* assertReactSurfaceManifest(sourceManifest.name, packedManifest, false)
      if (
        sourceManifest.name === "@knpkv/herdr-approvals" &&
        (!Schema.is(PackageSideEffects)(packedManifest.sideEffects) ||
          !packedManifest.sideEffects.includes("./dist/bin.js") ||
          !packedManifest.sideEffects.includes("./dist/fleetctl.js"))
      ) {
        return yield* new HerdrPackContractError({
          reason: "Approval runtime exports are missing from packed sideEffects"
        })
      }
    }

    const approvalsArchive = archives.get("@knpkv/herdr-approvals")
    if (approvalsArchive === undefined) {
      return yield* new HerdrPackContractError({ reason: "Approval archive was not packed" })
    }
    const consumer = path.join(first, "consumer")
    const installed = path.join(consumer, "node_modules", "@knpkv", "herdr-approvals")
    yield* fileSystem.makeDirectory(installed, { recursive: true })
    yield* run(
      spawner,
      "tar",
      ["-xzf", approvalsArchive, "--strip-components=1", "-C", installed],
      workspaceRoot
    )
    const resolution = yield* run(
      spawner,
      "node",
      [
        "--input-type=module",
        "--eval",
        "console.log(import.meta.resolve('@knpkv/herdr-approvals/hostd')); console.log(import.meta.resolve('@knpkv/herdr-approvals/fleetctl'))"
      ],
      consumer
    )
    const resolved = resolution.trim().split("\n")
    const hostdResolution = resolved[0]
    const fleetctlResolution = resolved[1]
    if (
      resolved.length !== 2 ||
      hostdResolution === undefined ||
      fleetctlResolution === undefined ||
      hostdResolution.endsWith("/dist/bin.js") === false ||
      fleetctlResolution.endsWith("/dist/fleetctl.js") === false
    ) {
      return yield* new HerdrPackContractError({ reason: `Approval runtime subpaths do not resolve: ${resolution}` })
    }

    yield* Console.log("six Herdr pnpm packs are reproducible, exact, dependency-clean, and export both runtimes")
  }).pipe(
    // The packed-package verifier owns one Node runtime for the complete check.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(NodeServices.layer)
  )
)

NodeRuntime.runMain(program)
