export type PrecommitCommand = {
  readonly args: ReadonlyArray<string>
  readonly command: string
  readonly label: string
}

export type PrecommitPlan = {
  readonly commands: ReadonlyArray<PrecommitCommand>
  readonly mode: "control-center" | "docs" | "full" | "none"
  readonly reason: string
}

const normalizePath = (file: string): string => file.replaceAll("\\", "/").replace(/^\.\//, "")

const isDocumentationPath = (file: string): boolean =>
  file.endsWith(".md") || file.endsWith(".mdx") || file.startsWith("docs/")

const isDocumentationApplicationPath = (file: string): boolean => file.startsWith("packages/docs/")

const isFocusedDocumentationPath = (file: string): boolean =>
  isDocumentationPath(file) && !isDocumentationApplicationPath(file)

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

const stagedFormat = (files: ReadonlyArray<string>): PrecommitCommand => ({
  args: ["exec", "prettier", "--check", "--ignore-unknown", "--", ...files],
  command: "pnpm",
  label: "format staged files"
})

/** Select the smallest safe pre-commit gate for the staged paths. */
export const planPrecommit = (
  stagedFiles: ReadonlyArray<string>,
  formattableFiles: ReadonlyArray<string> = stagedFiles
): PrecommitPlan => {
  const files = Array.from(new Set(stagedFiles.map(normalizePath).filter((file) => file.length > 0))).sort()
  const formatFiles = Array.from(
    new Set(formattableFiles.map(normalizePath).filter((file) => file.length > 0))
  ).sort()
  if (files.length === 0) return { commands: [], mode: "none", reason: "no staged files" }

  if (files.every(isDocumentationPath) && !files.some(isDocumentationApplicationPath)) {
    return {
      commands: formatFiles.length === 0 ? [] : [stagedFormat(formatFiles)],
      mode: "docs",
      reason: "only documentation files are staged"
    }
  }

  const isControlCenterChange = files.some((file) => file.startsWith("packages/control-center/"))
  const isControlCenterScope = files.every(
    (file) => file.startsWith("packages/control-center/") || isFocusedDocumentationPath(file)
  )
  if (isControlCenterChange && isControlCenterScope) {
    return {
      commands: [
        ...(formatFiles.length === 0 ? [] : [stagedFormat(formatFiles)]),
        { args: ["lint:ast"], command: "pnpm", label: "run Effect static checks" },
        {
          args: ["--filter", "@knpkv/control-center", "lint"],
          command: "pnpm",
          label: "lint Control Center"
        },
        {
          args: ["--filter", "@knpkv/control-center", "build"],
          command: "pnpm",
          label: "build Control Center"
        },
        {
          args: ["--filter", "@knpkv/control-center", "check"],
          command: "pnpm",
          label: "type-check Control Center"
        },
        {
          args: ["--filter", "@knpkv/control-center", "test"],
          command: "pnpm",
          label: "test Control Center"
        }
      ],
      mode: "control-center",
      reason: "only Control Center and documentation files are staged"
    }
  }

  return {
    commands: [{ args: ["verify:full"], command: "pnpm", label: "run full repository gate" }],
    mode: "full",
    reason: "staged paths are outside the first focused scopes"
  }
}
