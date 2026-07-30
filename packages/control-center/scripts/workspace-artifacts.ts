import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as TypeScript from "typescript"

export class WorkspaceArtifactError extends Data.TaggedError("WorkspaceArtifactError")<{
  readonly reason: string
}> {}

export type PublishedPackageManifest = {
  readonly bin?: unknown
  readonly exports?: unknown
  readonly main?: unknown
  readonly name: string
  readonly types?: unknown
}

const collectArtifactPaths = (value: unknown, paths: Set<string>): void => {
  if (Predicate.isString(value)) {
    if (value.startsWith("./") && !value.includes("*")) paths.add(value.slice(2))
    return
  }
  if (Array.isArray(value)) {
    for (const member of value) collectArtifactPaths(member, paths)
    return
  }
  if (Predicate.isObject(value)) {
    for (const member of Object.values(value)) collectArtifactPaths(member, paths)
  }
}

/** Return concrete files advertised by a workspace package's public manifest. */
export const publishedArtifactPaths = (manifest: PublishedPackageManifest): ReadonlyArray<string> => {
  const paths = new Set<string>()
  collectArtifactPaths(manifest.main, paths)
  collectArtifactPaths(manifest.types, paths)
  collectArtifactPaths(manifest.bin, paths)
  collectArtifactPaths(manifest.exports, paths)
  return Array.from(paths).sort()
}

export type WorkspaceArtifactContract = {
  readonly artifactPaths: ReadonlyArray<string>
  readonly fingerprintPath: string
  readonly inputFingerprint: string
  readonly name: string
  readonly packageRoot: string
}

export type WorkspaceArtifactBuilder = (
  packages: ReadonlyArray<string>
) => Effect.Effect<void, WorkspaceArtifactError>

/** Remove stale TypeScript state before repairing manifest-declared package output. */
export const clearWorkspaceIncrementalBuildState = Effect.fn(
  "controlCenter.clearWorkspaceIncrementalBuildState"
)(function*(packageRoots: ReadonlyArray<string>) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  for (const packageRoot of packageRoots) {
    yield* fileSystem.remove(path.join(packageRoot, "tsconfig.tsbuildinfo"), { force: true }).pipe(
      Effect.mapError(
        () => new WorkspaceArtifactError({ reason: `could not clear build state for ${packageRoot}` })
      )
    )
    yield* fileSystem.remove(path.join(packageRoot, "node_modules", ".cache"), {
      force: true,
      recursive: true
    }).pipe(
      Effect.mapError(
        () => new WorkspaceArtifactError({ reason: `could not clear build state for ${packageRoot}` })
      )
    )
  }
})

/** Select packages with at least one missing declared entry artifact. */
export const packagesMissingPublishedArtifacts = (
  contracts: ReadonlyArray<WorkspaceArtifactContract>,
  exists: (path: string) => boolean,
  join: (root: string, artifact: string) => string
): ReadonlyArray<string> =>
  contracts
    .filter(({ artifactPaths, packageRoot }) =>
      artifactPaths.length > 0 && artifactPaths.some((artifact) => !exists(join(packageRoot, artifact)))
    )
    .map(({ name }) => name)
    .sort()

/** Select stale packages even when their old manifest-declared output still exists. */
export const packagesRequiringPublishedArtifactBuild = (
  contracts: ReadonlyArray<WorkspaceArtifactContract>,
  exists: (path: string) => boolean,
  readFingerprint: (path: string) => string | undefined,
  join: (root: string, artifact: string) => string
): ReadonlyArray<string> =>
  contracts
    .filter(
      ({ artifactPaths, fingerprintPath, inputFingerprint, packageRoot }) =>
        artifactPaths.length > 0 &&
        (artifactPaths.some((artifact) => !exists(join(packageRoot, artifact))) ||
          readFingerprint(fingerprintPath) !== inputFingerprint)
    )
    .map(({ name }) => name)
    .sort()

const workspaceArtifactInputDirectories = new Set(["scripts", "src"])
const workspaceArtifactInputRootFiles =
  /^(?:component-manifest\.ts|package\.json|tsconfig(?:\.[^.]+)*\.jsonc?|vite\.config\.[cm]?[jt]s)$/u
const workspaceArtifactTsconfig = /^tsconfig(?:\.[^.]+)*\.jsonc?$/u

const isExcludedExternalBuildInput = (candidate: string): boolean =>
  candidate.split(/[\\/]/u).some((segment) => segment === "node_modules" || segment === "repos" || segment === "vendor")

/** Hash package source and build configuration, excluding tests, generated output, and vendor trees. */
export const workspaceArtifactInputFingerprint = Effect.fn(
  "controlCenter.workspaceArtifactInputFingerprint"
)(function*(packageRoot: string) {
  const cryptoService = yield* Crypto.Crypto
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const inputPaths = new Set<string>()
  const enumerateFailure = (): WorkspaceArtifactError =>
    new WorkspaceArtifactError({ reason: `could not enumerate build inputs for ${packageRoot}` })

  for (const entry of (yield* fileSystem.readDirectory(packageRoot).pipe(Effect.mapError(enumerateFailure))).sort()) {
    const absolutePath = path.join(packageRoot, entry)
    const info = yield* fileSystem.stat(absolutePath).pipe(Effect.mapError(enumerateFailure))
    if (info.type === "Directory" && workspaceArtifactInputDirectories.has(entry)) {
      const directories = [absolutePath]
      while (directories.length > 0) {
        const directory = directories.pop()
        if (directory === undefined) break
        for (
          const child of (yield* fileSystem.readDirectory(directory).pipe(Effect.mapError(enumerateFailure))).sort()
        ) {
          const childPath = path.join(directory, child)
          const childInfo = yield* fileSystem.stat(childPath).pipe(Effect.mapError(enumerateFailure))
          if (childInfo.type === "Directory") directories.push(childPath)
          else if (childInfo.type === "File") inputPaths.add(childPath)
        }
      }
    } else if (info.type === "File" && workspaceArtifactInputRootFiles.test(entry)) {
      inputPaths.add(absolutePath)
    }
  }

  const configQueue = Array.from(inputPaths).filter((inputPath) =>
    workspaceArtifactTsconfig.test(path.basename(inputPath))
  )
  const visitedConfigs = new Set<string>()
  while (configQueue.length > 0) {
    const configPath = configQueue.pop()
    if (configPath === undefined || visitedConfigs.has(configPath)) continue
    visitedConfigs.add(configPath)
    const configSource = yield* fileSystem.readFileString(configPath).pipe(
      Effect.mapError(
        () =>
          new WorkspaceArtifactError({ reason: `could not read build input ${path.relative(packageRoot, configPath)}` })
      )
    )
    const parsed = TypeScript.parseConfigFileTextToJson(configPath, configSource)
    const parsedConfig: unknown = parsed.config
    if (parsed.error !== undefined || !Predicate.isObject(parsedConfig)) {
      return yield* new WorkspaceArtifactError({
        reason: `could not parse build configuration ${path.relative(packageRoot, configPath)}`
      })
    }
    const extendsValue = parsedConfig["extends"]
    const extendedConfigs = Predicate.isString(extendsValue)
      ? [extendsValue]
      : Array.isArray(extendsValue) && extendsValue.every(Predicate.isString)
      ? extendsValue
      : []
    for (const extendedConfig of extendedConfigs) {
      if (!extendedConfig.startsWith(".") && !extendedConfig.startsWith("/")) continue
      const unresolved = path.resolve(path.dirname(configPath), extendedConfig)
      const candidates = /\.jsonc?$/u.test(unresolved)
        ? [unresolved]
        : [unresolved, `${unresolved}.json`, `${unresolved}.jsonc`, path.join(unresolved, "tsconfig.json")]
      let resolved: string | undefined
      for (const candidate of candidates) {
        if (isExcludedExternalBuildInput(candidate) || !(yield* fileSystem.exists(candidate))) continue
        const info = yield* fileSystem.stat(candidate).pipe(Effect.mapError(enumerateFailure))
        if (info.type === "File") {
          resolved = candidate
          break
        }
      }
      if (resolved === undefined || inputPaths.has(resolved)) continue
      inputPaths.add(resolved)
      configQueue.push(resolved)
    }
  }

  const encodedInputs: Array<string> = []
  for (const inputPath of Array.from(inputPaths).sort()) {
    const relativePath = path.relative(packageRoot, inputPath)
    const source = yield* fileSystem.readFileString(inputPath).pipe(
      Effect.mapError(
        () => new WorkspaceArtifactError({ reason: `could not read build input ${relativePath}` })
      )
    )
    encodedInputs.push(`${relativePath.length}:${relativePath}${source.length}:${source}`)
  }
  const digest = yield* cryptoService.digest("SHA-256", new TextEncoder().encode(encodedInputs.join(""))).pipe(
    Effect.mapError(
      () => new WorkspaceArtifactError({ reason: `could not fingerprint build inputs for ${packageRoot}` })
    )
  )
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
})

const findPackagesMissingPublishedArtifacts = Effect.fn(
  "controlCenter.findPackagesMissingPublishedArtifacts"
)(function*(contracts: ReadonlyArray<WorkspaceArtifactContract>) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const existingArtifacts = new Set<string>()

  for (const contract of contracts) {
    for (const artifact of contract.artifactPaths) {
      const absolutePath = path.join(contract.packageRoot, artifact)
      if (yield* fileSystem.exists(absolutePath)) existingArtifacts.add(absolutePath)
    }
  }

  return packagesMissingPublishedArtifacts(
    contracts,
    (artifact) => existingArtifacts.has(artifact),
    (root, artifact) => path.join(root, artifact)
  )
})

const findPackagesRequiringPublishedArtifactBuild = Effect.fn(
  "controlCenter.findPackagesRequiringPublishedArtifactBuild"
)(function*(contracts: ReadonlyArray<WorkspaceArtifactContract>) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const existingPaths = new Set<string>()
  const fingerprints = new Map<string, string>()

  for (const contract of contracts) {
    for (const artifact of contract.artifactPaths) {
      const absolutePath = path.join(contract.packageRoot, artifact)
      if (yield* fileSystem.exists(absolutePath)) existingPaths.add(absolutePath)
    }
    if (yield* fileSystem.exists(contract.fingerprintPath)) {
      fingerprints.set(contract.fingerprintPath, yield* fileSystem.readFileString(contract.fingerprintPath))
    }
  }

  return packagesRequiringPublishedArtifactBuild(
    contracts,
    (candidate) => existingPaths.has(candidate),
    (candidate) => fingerprints.get(candidate),
    (root, artifact) => path.join(root, artifact)
  )
})

/** Build missing package artifacts once, then verify every advertised artifact exists. */
export const ensureWorkspaceArtifactContracts = Effect.fn(
  "controlCenter.ensureWorkspaceArtifactContracts"
)(function*(contracts: ReadonlyArray<WorkspaceArtifactContract>, buildMissing: WorkspaceArtifactBuilder) {
  const packagesToBuild = yield* findPackagesRequiringPublishedArtifactBuild(contracts)
  if (packagesToBuild.length === 0) return packagesToBuild

  yield* buildMissing(packagesToBuild)

  const remainingPackages = yield* findPackagesMissingPublishedArtifacts(contracts)
  if (remainingPackages.length > 0) {
    return yield* new WorkspaceArtifactError({
      reason: "dependency build completed successfully but advertised artifacts are still missing for: " +
        remainingPackages.join(", ")
    })
  }

  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const builtPackageNames = new Set(packagesToBuild)
  for (const contract of contracts) {
    if (!builtPackageNames.has(contract.name)) continue
    yield* fileSystem.makeDirectory(path.dirname(contract.fingerprintPath), { recursive: true })
    yield* fileSystem.writeFileString(contract.fingerprintPath, contract.inputFingerprint)
  }

  return packagesToBuild
})
