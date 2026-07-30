import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  clearWorkspaceIncrementalBuildState,
  ensureWorkspaceArtifactContracts,
  publishedArtifactPaths,
  resolveWorkspaceArtifactFingerprints,
  type WorkspaceArtifactContract,
  WorkspaceArtifactError,
  workspaceArtifactInputFingerprint
} from "./workspace-artifacts.js"

const PackageManifestSchema = Schema.Struct({
  bin: Schema.optional(Schema.Unknown),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  exports: Schema.optional(Schema.Unknown),
  main: Schema.optional(Schema.Unknown),
  name: Schema.String,
  types: Schema.optional(Schema.Unknown)
})

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url))
  const controlCenterRoot = path.dirname(path.dirname(scriptPath))
  const packagesRoot = path.dirname(controlCenterRoot)
  const workspaceRoot = path.dirname(packagesRoot)

  const readManifest = Effect.fn("controlCenter.readPackageManifest")(function*(packageRoot: string) {
    const source = yield* fs.readFileString(path.join(packageRoot, "package.json"))
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifestSchema))(source).pipe(
      Effect.mapError(() => new WorkspaceArtifactError({ reason: `invalid package manifest at ${packageRoot}` }))
    )
  })

  const controlCenterManifest = yield* readManifest(controlCenterRoot)
  const directWorkspaceDependencies = new Set(
    Object.entries(controlCenterManifest.dependencies ?? {})
      .filter(([, version]) => version.startsWith("workspace:"))
      .map(([name]) => name)
  )
  const workspacePackages = new Map<
    string,
    {
      readonly manifest: typeof controlCenterManifest
      readonly packageRoot: string
      readonly workspaceDependencies: ReadonlyArray<string>
    }
  >()

  for (const entry of yield* fs.readDirectory(packagesRoot)) {
    const packageRoot = path.join(packagesRoot, entry)
    const packageInfo = yield* fs.stat(packageRoot)
    if (packageInfo.type !== "Directory") continue
    if (!(yield* fs.exists(path.join(packageRoot, "package.json")))) continue
    const manifest = yield* readManifest(packageRoot)
    workspacePackages.set(manifest.name, {
      manifest,
      packageRoot,
      workspaceDependencies: Object.entries(manifest.dependencies ?? {})
        .filter(([, version]) => version.startsWith("workspace:"))
        .map(([name]) => name)
        .sort()
    })
  }

  const dependencyClosure = new Set<string>()
  const dependencyQueue = Array.from(directWorkspaceDependencies)
  while (dependencyQueue.length > 0) {
    const name = dependencyQueue.pop()
    if (name === undefined || dependencyClosure.has(name)) continue
    const workspacePackage = workspacePackages.get(name)
    if (workspacePackage === undefined) {
      return yield* new WorkspaceArtifactError({ reason: `could not locate workspace package ${name}` })
    }
    dependencyClosure.add(name)
    for (const dependency of workspacePackage.workspaceDependencies) dependencyQueue.push(dependency)
  }

  const fingerprintNodes = yield* Effect.forEach(
    Array.from(dependencyClosure).sort(),
    Effect.fn("controlCenter.fingerprintWorkspaceDependency")(function*(name) {
      const workspacePackage = workspacePackages.get(name)
      if (workspacePackage === undefined) {
        return yield* new WorkspaceArtifactError({ reason: `could not locate workspace package ${name}` })
      }
      return {
        name,
        ownFingerprint: yield* workspaceArtifactInputFingerprint(workspacePackage.packageRoot).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path)
        ),
        workspaceDependencies: workspacePackage.workspaceDependencies
      }
    }),
    { concurrency: "unbounded" }
  )
  const effectiveFingerprints = yield* resolveWorkspaceArtifactFingerprints(fingerprintNodes)
  const contracts: Array<WorkspaceArtifactContract> = []
  for (const name of Array.from(dependencyClosure).sort()) {
    const workspacePackage = workspacePackages.get(name)
    const inputFingerprint = effectiveFingerprints.get(name)
    if (workspacePackage === undefined || inputFingerprint === undefined) {
      return yield* new WorkspaceArtifactError({ reason: `could not fingerprint workspace package ${name}` })
    }
    const fingerprintPath = path.join(
      workspacePackage.packageRoot,
      "node_modules",
      ".cache",
      "control-center-workspace-artifact.sha256"
    )
    contracts.push({
      artifactPaths: publishedArtifactPaths(workspacePackage.manifest),
      fingerprintPath,
      inputFingerprint,
      name,
      packageRoot: workspacePackage.packageRoot
    })
  }

  const buildMissing = Effect.fn("controlCenter.buildMissingDependencyArtifacts")(function*(
    missingPackages: ReadonlyArray<string>
  ) {
    yield* Console.log(
      `[control-center dependencies] building missing or stale artifacts: ${missingPackages.join(", ")}`
    )
    const rootsByName = new Map(contracts.map(({ name, packageRoot }) => [name, packageRoot]))
    const missingRoots = missingPackages.flatMap((name) => {
      const packageRoot = rootsByName.get(name)
      return packageRoot === undefined ? [] : [packageRoot]
    })
    if (missingRoots.length !== missingPackages.length) {
      return yield* new WorkspaceArtifactError({ reason: "could not locate a missing workspace package" })
    }
    yield* clearWorkspaceIncrementalBuildState(missingRoots).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path)
    )
    const filterArguments = missingPackages.flatMap((name) => ["--filter", name])
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make("pnpm", [...filterArguments, "--if-present", "run", "build"], {
        cwd: workspaceRoot,
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit"
      })
    ).pipe(
      Effect.mapError(
        () => new WorkspaceArtifactError({ reason: "could not build missing dependency artifacts" })
      )
    )
    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* new WorkspaceArtifactError({
        reason: `dependency build failed with exit code ${exitCode}`
      })
    }
  })

  yield* ensureWorkspaceArtifactContracts(contracts, buildMissing)
  yield* Console.log("[control-center dependencies] workspace artifacts are ready")
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) =>
      Console.error(
        `[control-center dependencies] ${error._tag === "WorkspaceArtifactError" ? error.reason : String(error)}`
      )
    ),
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
