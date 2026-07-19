import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"

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

/** Build missing package artifacts once, then verify every advertised artifact exists. */
export const ensureWorkspaceArtifactContracts = Effect.fn(
  "controlCenter.ensureWorkspaceArtifactContracts"
)(function*(contracts: ReadonlyArray<WorkspaceArtifactContract>, buildMissing: WorkspaceArtifactBuilder) {
  const missingPackages = yield* findPackagesMissingPublishedArtifacts(contracts)
  if (missingPackages.length === 0) return missingPackages

  yield* buildMissing(missingPackages)

  const remainingPackages = yield* findPackagesMissingPublishedArtifacts(contracts)
  if (remainingPackages.length > 0) {
    return yield* new WorkspaceArtifactError({
      reason: "dependency build completed successfully but advertised artifacts are still missing for: " +
        remainingPackages.join(", ")
    })
  }

  return missingPackages
})
