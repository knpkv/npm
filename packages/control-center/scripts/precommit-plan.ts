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

  if (files.every(isDocumentationPath)) {
    return {
      commands: formatFiles.length === 0 ? [] : [stagedFormat(formatFiles)],
      mode: "docs",
      reason: "only documentation files are staged"
    }
  }

  const isControlCenterChange = files.some((file) => file.startsWith("packages/control-center/"))
  const isControlCenterScope = files.every(
    (file) => file.startsWith("packages/control-center/") || isDocumentationPath(file)
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
          args: ["packages/control-center/scripts/ensure-build-dependencies.ts"],
          command: "tsx",
          label: "ensure Control Center dependencies"
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
