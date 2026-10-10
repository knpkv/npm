export type PrecommitCommand = {
  readonly args: ReadonlyArray<string>
  readonly command: string
  readonly label: string
}

export type PrecommitPlan = {
  readonly commands: ReadonlyArray<PrecommitCommand>
  readonly mode: "changed" | "full" | "none"
  readonly reason: string
}

const normalizePath = (file: string): string => file.replaceAll("\\", "/").replace(/^\.\//, "")

/** Repository inputs whose changes can affect packages outside the workspace dependency graph. */
const isRepositoryInput = (file: string): boolean =>
  /^packages\/.*\/(?:vitest[^/]*\.config\.[^/]+|tsconfig[^/]*\.jsonc?)$/u.test(file) ||
  file.startsWith("scripts/") || file.startsWith("ast-grep/") ||
  file.startsWith(".github/") || file.startsWith(".husky/") ||
  file.startsWith("repos/") || file.startsWith("patches/") ||
  (!file.startsWith("packages/") && !file.endsWith(".md") && !file.endsWith(".mdx"))

export type PrecommitEnvironment = {
  readonly PRECOMMIT_MODE?: string | undefined
}

/** Half of the available cores, rounded down, with at least one worker. Invalid overrides are rejected. */
export const precommitMaxWorkers = (cores: number, override?: string): number | null => {
  if (override === undefined) return Math.max(1, Math.floor(cores / 2))
  if (!/^[1-9][0-9]*$/u.test(override)) return null
  const workers = Number(override)
  return Number.isSafeInteger(workers) ? workers : null
}

export type StagedPathSelection = {
  readonly formattableFiles: ReadonlyArray<string>
  readonly stagedFiles: ReadonlyArray<string>
}

/** Decode Git's NUL-delimited name-status format, retaining both sides of renames for scope checks. */
export const parseStagedNameStatus = (output: string): StagedPathSelection | null => {
  const tokens = output.split("\0").filter((token) => token.length > 0)
  const formattableFiles = new Array<string>()
  const stagedFiles = new Array<string>()

  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++]
    if (status === undefined) return null
    const kind = status.charAt(0)
    if (kind === "R" || kind === "C") {
      const source = tokens[index++]
      const destination = tokens[index++]
      if (source === undefined || destination === undefined) return null
      if (kind === "R") stagedFiles.push(source)
      stagedFiles.push(destination)
      formattableFiles.push(destination)
      continue
    }
    const file = tokens[index++]
    if (file === undefined) return null
    stagedFiles.push(file)
    if (kind !== "D") formattableFiles.push(file)
  }

  return { formattableFiles, stagedFiles }
}

/** Select a staged incremental gate, or every repository check for shared inputs and explicit overrides. */
export const planPrecommit = (
  stagedFiles: ReadonlyArray<string>,
  environment: PrecommitEnvironment = {},
  maxWorkers: number = 1,
  sharedPackages: ReadonlyArray<string> = []
): PrecommitPlan => {
  const files = Array.from(new Set(stagedFiles.map(normalizePath).filter((file) => file.length > 0))).sort()
  if (files.length === 0) return { commands: [], mode: "none", reason: "no staged files" }

  const repositoryInput = files.find((file) =>
    isRepositoryInput(file) || sharedPackages.some((directory) => file.startsWith(`${directory}/`))
  )
  if (environment.PRECOMMIT_MODE === "full" || repositoryInput !== undefined) {
    return {
      commands: [
        { args: ["format"], command: "pnpm", label: "format repository" },
        { args: ["lint"], command: "pnpm", label: "lint repository" },
        { args: ["check"], command: "pnpm", label: "build and type-check repository" },
        { args: ["test:unit", "--run", "--maxWorkers", String(maxWorkers)], command: "pnpm", label: "test repository" },
        { args: ["test:pack"], command: "pnpm", label: "test packed packages" }
      ],
      mode: "full",
      reason: environment.PRECOMMIT_MODE === "full" ? "PRECOMMIT_MODE=full" : `repository input: ${repositoryInput}`
    }
  }

  return {
    commands: [{
      args: ["check:changed", "--staged", "--max-workers", String(maxWorkers)],
      command: "pnpm",
      label: "check staged files and affected packages"
    }],
    mode: "changed",
    reason: "staged files and their workspace dependents"
  }
}
