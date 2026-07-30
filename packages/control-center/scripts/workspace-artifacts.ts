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

export interface WorkspaceArtifactFingerprintNode {
  readonly name: string
  readonly ownFingerprint: string
  readonly workspaceDependencies: ReadonlyArray<string>
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
  /^(?:component-manifest\.ts|package\.json|tsconfig(?:\.[^.]+)*\.jsonc?|vite(?:\.[^.]+)*\.config\.[cm]?[jt]s)$/u
const workspaceArtifactTsconfig = /^tsconfig(?:\.[^.]+)*\.jsonc?$/u
const workspaceArtifactSourceModule = /\.[cm]?[jt]sx?$/u
const workspaceArtifactSourceExtensions: ReadonlyArray<string> = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs"
]

const isExcludedExternalBuildInput = (candidate: string): boolean =>
  candidate.split(/[\\/]/u).some((segment) => segment === "node_modules" || segment === "repos" || segment === "vendor")

/** Bind each package's own inputs to the complete emitted-artifact workspace dependency closure. */
export const resolveWorkspaceArtifactFingerprints = Effect.fn(
  "controlCenter.resolveWorkspaceArtifactFingerprints"
)(function*(nodes: ReadonlyArray<WorkspaceArtifactFingerprintNode>) {
  const cryptoService = yield* Crypto.Crypto
  const nodesByName = new Map<string, WorkspaceArtifactFingerprintNode>()
  for (const node of nodes) {
    if (nodesByName.has(node.name)) {
      return yield* new WorkspaceArtifactError({ reason: `duplicate workspace package ${node.name}` })
    }
    nodesByName.set(node.name, node)
  }

  for (const node of nodes) {
    for (const dependency of node.workspaceDependencies) {
      if (!nodesByName.has(dependency)) {
        return yield* new WorkspaceArtifactError({
          reason: `${node.name} references missing workspace dependency ${dependency}`
        })
      }
    }
  }

  const unresolved = new Map(nodesByName)
  const resolved = new Map<string, string>()
  while (unresolved.size > 0) {
    const ready = Array.from(unresolved.values())
      .filter((node) => node.workspaceDependencies.every((dependency) => resolved.has(dependency)))
      .sort((left, right) => left.name.localeCompare(right.name))
    if (ready.length === 0) {
      return yield* new WorkspaceArtifactError({
        reason: `workspace dependency cycle prevents artifact fingerprinting: ${
          Array.from(unresolved.keys()).sort().join(", ")
        }`
      })
    }
    for (const node of ready) {
      const encodedDependencies: Array<string> = []
      for (const dependency of Array.from(new Set(node.workspaceDependencies)).sort()) {
        const fingerprint = resolved.get(dependency)
        if (fingerprint === undefined) {
          return yield* new WorkspaceArtifactError({
            reason: `${node.name} has unresolved workspace dependency ${dependency}`
          })
        }
        encodedDependencies.push(`${dependency.length}:${dependency}${fingerprint.length}:${fingerprint}`)
      }
      const dependencyMaterial = encodedDependencies.join("")
      const material = `${node.ownFingerprint.length}:${node.ownFingerprint}${dependencyMaterial}`
      const digest = yield* cryptoService.digest("SHA-256", new TextEncoder().encode(material)).pipe(
        Effect.mapError(
          () => new WorkspaceArtifactError({ reason: `could not fingerprint workspace package ${node.name}` })
        )
      )
      resolved.set(
        node.name,
        Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
      )
      unresolved.delete(node.name)
    }
  }
  return resolved
})

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

  let workspaceDirectory = packageRoot
  while (true) {
    const lockfilePath = path.join(workspaceDirectory, "pnpm-lock.yaml")
    if (yield* fileSystem.exists(lockfilePath)) {
      inputPaths.add(lockfilePath)
      break
    }
    const parent = path.dirname(workspaceDirectory)
    if (parent === workspaceDirectory) break
    workspaceDirectory = parent
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

  const sourceQueue = Array.from(inputPaths).filter((inputPath) => workspaceArtifactSourceModule.test(inputPath))
  const sourceInputs = new Map<string, string>()
  const visitedSources = new Set<string>()
  while (sourceQueue.length > 0) {
    const sourcePath = sourceQueue.pop()
    if (sourcePath === undefined || visitedSources.has(sourcePath)) continue
    visitedSources.add(sourcePath)
    const source = yield* fileSystem.readFileString(sourcePath).pipe(
      Effect.mapError(
        () =>
          new WorkspaceArtifactError({
            reason: `could not read build input ${path.relative(packageRoot, sourcePath)}`
          })
      )
    )
    sourceInputs.set(sourcePath, source)
    for (const { fileName } of TypeScript.preProcessFile(source, true, true).importedFiles) {
      if (!fileName.startsWith(".") && !fileName.startsWith("/")) continue
      const unresolved = path.resolve(path.dirname(sourcePath), fileName)
      const extension = path.extname(unresolved)
      const stem = workspaceArtifactSourceModule.test(unresolved)
        ? unresolved.slice(0, Math.max(0, unresolved.length - extension.length))
        : unresolved
      const candidates = Array.from(
        new Set([
          unresolved,
          ...workspaceArtifactSourceExtensions.map((candidateExtension) => `${stem}${candidateExtension}`),
          ...workspaceArtifactSourceExtensions.map((candidateExtension) =>
            path.join(unresolved, `index${candidateExtension}`)
          )
        ])
      )
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
      if (workspaceArtifactSourceModule.test(resolved)) sourceQueue.push(resolved)
    }
  }

  const encodedInputs: Array<string> = []
  for (const inputPath of Array.from(inputPaths).sort()) {
    const relativePath = path.relative(packageRoot, inputPath)
    const source = sourceInputs.get(inputPath) ??
      (yield* fileSystem.readFileString(inputPath).pipe(
        Effect.mapError(
          () => new WorkspaceArtifactError({ reason: `could not read build input ${relativePath}` })
        )
      ))
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
