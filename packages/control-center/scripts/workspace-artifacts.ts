import * as Predicate from "effect/Predicate"

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
