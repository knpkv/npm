const GENERATED_DECLARATION_DIRECTORIES = new Set(["dist", "generated", "node_modules"])

const normalizePath = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//, "")

/** Return project-owned declaration shims that bypass the package's normal TypeScript modules. */
export const findProjectDeclarationShims = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths
    .map(normalizePath)
    .filter((path) => /\.d\.(?:cts|mts|ts)$/.test(path))
    .filter((path) => !path.split("/").slice(0, -1).some((segment) => GENERATED_DECLARATION_DIRECTORIES.has(segment)))
    .sort((left, right) => left.localeCompare(right))
