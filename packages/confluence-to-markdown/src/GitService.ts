/**
 * Git operations service for internal version control.
 *
 * @module
 */
import * as NodeCommandExecutor from "@effect/platform-node/NodeCommandExecutor"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as CommandExecutor from "@effect/platform/CommandExecutor"
import type * as PlatformError from "@effect/platform/Error"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  GitError,
  GitMergeConflictError,
  GitNoChangesError,
  GitNotInitializedError,
  GitNotInstalledError
} from "./GitError.js"
import {
  getConflictedFiles,
  GIT_LOG_FORMAT,
  type GitLogEntry,
  type GitStatusEntry,
  parseGitLog,
  parseGitStatus,
  runGit,
  runGitAllowEmpty
} from "./internal/gitCommands.js"

/**
 * Options for git commit.
 *
 * @category Types
 */
export interface GitCommitOptions {
  readonly message: string
  readonly author?: {
    readonly name: string
    readonly email: string
  }
  readonly date?: Date
}

/**
 * Options for git log.
 *
 * @category Types
 */
export interface GitLogOptions {
  readonly oneline?: boolean
  readonly n?: number
  readonly since?: string
  readonly file?: string
}

/**
 * Options for git diff.
 *
 * @category Types
 */
export interface GitDiffOptions {
  readonly staged?: boolean
  readonly commit?: string
  readonly commit2?: string
  readonly file?: string
}

/**
 * Options for git commit --amend.
 *
 * @category Types
 */
export interface GitAmendOptions {
  readonly noEdit?: boolean
  readonly message?: string
}

/**
 * Options for git reset.
 *
 * @category Types
 */
export interface GitResetOptions {
  readonly hard?: boolean
}

/**
 * Git status result.
 *
 * @category Types
 */
export interface GitStatus {
  readonly entries: ReadonlyArray<GitStatusEntry>
  readonly hasChanges: boolean
  readonly hasConflicts: boolean
  readonly conflictedFiles: ReadonlyArray<string>
}

/**
 * Union of all git-related errors.
 *
 * @category Types
 */
export type GitServiceError =
  | GitError
  | GitNotInstalledError
  | GitNotInitializedError
  | GitNoChangesError
  | GitMergeConflictError

/**
 * Git service interface.
 *
 * @category Service
 */
export interface GitServiceShape {
  /** Validate git is installed, return version. */
  readonly validateGit: () => Effect.Effect<string, GitNotInstalledError>

  /** Check if .confluence/.git exists. */
  readonly isInitialized: () => Effect.Effect<boolean>

  /** Initialize git repo in .confluence/. */
  readonly init: () => Effect.Effect<void, GitServiceError>

  /** Stage all files. */
  readonly addAll: () => Effect.Effect<void, GitServiceError>

  /** Commit with options. */
  readonly commit: (options: GitCommitOptions) => Effect.Effect<string, GitServiceError>

  /** Get status. */
  readonly status: () => Effect.Effect<GitStatus, GitServiceError>

  /** Get log. */
  readonly log: (options?: GitLogOptions) => Effect.Effect<ReadonlyArray<GitLogEntry>, GitServiceError>

  /** Get diff. */
  readonly diff: (options?: GitDiffOptions) => Effect.Effect<string, GitServiceError>

  /** Check for merge conflicts. */
  readonly hasConflicts: () => Effect.Effect<boolean, GitServiceError>

  /** Continue merge after conflict resolution. */
  readonly mergeContinue: () => Effect.Effect<void, GitServiceError>

  /** Copy files from docsPath to .confluence/. */
  readonly syncFromDocs: (
    docsPath: string,
    trackedPaths: ReadonlyArray<string>
  ) => Effect.Effect<void, GitServiceError>

  /** Copy files from .confluence/ to docsPath. */
  readonly syncToDocs: (
    docsPath: string,
    trackedPaths: ReadonlyArray<string>
  ) => Effect.Effect<void, GitServiceError>

  /** Get current HEAD commit hash. */
  readonly getHead: () => Effect.Effect<string, GitServiceError>

  /** Get current branch name. */
  readonly getCurrentBranch: () => Effect.Effect<string, GitServiceError>

  /** Create a new branch at current HEAD. */
  readonly createBranch: (name: string) => Effect.Effect<void, GitServiceError>

  /** Checkout a branch or commit. */
  readonly checkout: (ref: string) => Effect.Effect<void, GitServiceError>

  /** Reset to a commit. */
  readonly reset: (ref: string, options?: GitResetOptions) => Effect.Effect<void, GitServiceError>

  /** Delete a branch. */
  readonly deleteBranch: (name: string) => Effect.Effect<void, GitServiceError>

  /** Get parent commit hash. */
  readonly getParent: (ref: string) => Effect.Effect<string, GitServiceError>

  /** Cherry-pick a commit. */
  readonly cherryPick: (
    ref: string,
    options?: { strategy?: "ours" | "theirs" }
  ) => Effect.Effect<void, GitServiceError>

  /** Get files changed in a commit. */
  readonly getChangedFiles: (ref: string) => Effect.Effect<ReadonlyArray<string>, GitServiceError>

  /** Get file content at a specific ref. */
  readonly showFile: (ref: string, filePath: string) => Effect.Effect<string, GitServiceError>

  /** Amend the current commit. */
  readonly amend: (options?: GitAmendOptions) => Effect.Effect<void, GitServiceError>

  /** Get commits between two refs (exclusive..inclusive). */
  readonly logRange: (
    from: string,
    to: string
  ) => Effect.Effect<ReadonlyArray<GitLogEntry>, GitServiceError>

  /** Check if a branch exists. */
  readonly branchExists: (name: string) => Effect.Effect<boolean, GitServiceError>

  /** Update a branch to point to a commit (without checkout). */
  readonly updateBranch: (name: string, ref: string) => Effect.Effect<void, GitServiceError>

  /** Merge a branch into current. */
  readonly merge: (
    branch: string,
    options?: { noCommit?: boolean; message?: string }
  ) => Effect.Effect<void, GitServiceError>

  /** Get deleted files between two refs (files in `from` but not in `to`). */
  readonly getDeletedFiles: (
    from: string,
    to: string,
    pathPrefix?: string
  ) => Effect.Effect<ReadonlyArray<string>, GitServiceError>

  /** Get file content at a specific ref. */
  readonly getFileContentAt: (
    ref: string,
    filePath: string
  ) => Effect.Effect<string, GitServiceError>
}

/**
 * Git service for internal version control operations.
 *
 * Manages a git repository at `.confluence/` for tracking synced files.
 *
 * @example
 * ```typescript
 * import { GitService } from "@knpkv/confluence-to-markdown/GitService"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const git = yield* GitService
 *   yield* git.init()
 *   yield* git.addAll()
 *   yield* git.commit({ message: "Initial commit" })
 * })
 * ```
 *
 * @category Service
 */
export class GitService extends Context.Tag("@knpkv/confluence-to-markdown/GitService")<
  GitService,
  GitServiceShape
>() {}

/**
 * Map PlatformError to GitError.
 */
const mapFsError = (error: PlatformError.PlatformError): GitError =>
  new GitError({ command: "filesystem", message: error.message })

// Dependencies layer for git operations (CommandExecutor + FileSystem + Path + NodeContext)
// NodeCommandExecutor requires FileSystem, so use provideMerge to satisfy its dependencies
const GitDepsLive = NodeCommandExecutor.layer.pipe(
  Layer.provideMerge(NodeFileSystem.layer),
  Layer.provideMerge(NodePath.layer),
  Layer.provideMerge(NodeContext.layer)
)

/**
 * Copy a single file, creating parent directories as needed.
 */
const copyFileFn = (
  fs: FileSystem.FileSystem,
  pathService: Path.Path,
  source: string,
  dest: string
): Effect.Effect<void, GitError> =>
  Effect.gen(function*() {
    const destDir = pathService.dirname(dest)
    yield* fs.makeDirectory(destDir, { recursive: true }).pipe(Effect.catchAll(() => Effect.void))
    yield* fs.copyFile(source, dest).pipe(Effect.mapError(mapFsError))
  })

/**
 * Copy a directory recursively.
 */
const copyDirectoryFn = (
  fs: FileSystem.FileSystem,
  pathService: Path.Path,
  source: string,
  dest: string
): Effect.Effect<void, GitError> =>
  Effect.gen(function*() {
    yield* fs.makeDirectory(dest, { recursive: true }).pipe(Effect.catchAll(() => Effect.void))

    const entries = yield* fs.readDirectory(source).pipe(Effect.mapError(mapFsError))

    for (const entry of entries) {
      const sourcePath = pathService.join(source, entry)
      const destPath = pathService.join(dest, entry)

      const stat = yield* fs.stat(sourcePath).pipe(Effect.mapError(mapFsError))

      if (stat.type === "Directory") {
        yield* copyDirectoryFn(fs, pathService, sourcePath, destPath)
      } else {
        yield* copyFileFn(fs, pathService, sourcePath, destPath)
      }
    }
  })

/**
 * Copy all markdown files recursively.
 */
const copyMarkdownFilesFn = (
  fs: FileSystem.FileSystem,
  pathService: Path.Path,
  source: string,
  dest: string
): Effect.Effect<void, GitError> =>
  Effect.gen(function*() {
    const exists = yield* fs.exists(source).pipe(Effect.catchAll(() => Effect.succeed(false)))
    if (!exists) {
      return
    }

    const entries = yield* fs.readDirectory(source).pipe(Effect.mapError(mapFsError))

    for (const entry of entries) {
      // Skip .git directory and config.json
      if (entry === ".git" || entry === "config.json") {
        continue
      }

      const sourcePath = pathService.join(source, entry)
      const destPath = pathService.join(dest, entry)

      const stat = yield* fs.stat(sourcePath).pipe(Effect.mapError(mapFsError))

      if (stat.type === "Directory") {
        yield* copyMarkdownFilesFn(fs, pathService, sourcePath, destPath)
      } else if (entry.endsWith(".md")) {
        yield* copyFileFn(fs, pathService, sourcePath, destPath)
      }
    }
  })

// Get paths helper - takes pathService as param
const getPaths = (pathService: Path.Path) => {
  const cwd = process.cwd()
  const confluenceDir = pathService.join(cwd, ".confluence")
  const gitDir = pathService.join(confluenceDir, ".git")
  return { cwd, confluenceDir, gitDir, pathService }
}

// Ensure initialized helper - takes fs and gitDir
const ensureInitializedFn = (fs: FileSystem.FileSystem, gitDir: string) =>
  Effect.gen(function*() {
    const initialized = yield* fs.exists(gitDir).pipe(Effect.catchAll(() => Effect.succeed(false)))
    if (!initialized) {
      return yield* Effect.fail(new GitNotInitializedError())
    }
  })

// Create the service - capture deps at construction time
const make = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const commandExecutor = yield* CommandExecutor.CommandExecutor
  const paths = getPaths(pathService)
  const { confluenceDir, cwd, gitDir } = paths

  // Create context with captured services for providing to returned Effects
  const depsContext: Context.Context<FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor> = Context
    .empty().pipe(
      Context.add(FileSystem.FileSystem, fs),
      Context.add(Path.Path, pathService),
      Context.add(CommandExecutor.CommandExecutor, commandExecutor)
    )

  // Helper to provide deps to an effect - uses any for R since we know depsContext covers all needs
  const provideDeps = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
    Effect.provide(effect, depsContext) as Effect.Effect<A, E>

  // Ensure initialized helper using captured values
  const ensureInitialized = ensureInitializedFn(fs, gitDir)

  // Service implementation using captured deps - each returns Effect with deps provided
  const validateGit = () =>
    provideDeps(
      runGit(["--version"], cwd).pipe(
        Effect.map((output) => output.trim()),
        Effect.catchTag("GitError", () => Effect.fail(new GitNotInstalledError({ message: "Git not found" })))
      )
    )

  const isInitialized = () =>
    Effect.succeed(fs).pipe(
      Effect.flatMap((f) => f.exists(gitDir)),
      Effect.catchAll(() => Effect.succeed(false))
    )

  const init = () =>
    provideDeps(
      Effect.gen(function*() {
        // Check git is installed
        yield* runGit(["--version"], cwd).pipe(
          Effect.catchTag("GitError", () => Effect.fail(new GitNotInstalledError({ message: "Git not found" })))
        )

        const exists = yield* fs.exists(confluenceDir).pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (!exists) {
          yield* fs.makeDirectory(confluenceDir, { recursive: true }).pipe(Effect.mapError(mapFsError))
        }

        const gitExists = yield* fs.exists(gitDir).pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (!gitExists) {
          yield* runGit(["init"], confluenceDir)
        }
      })
    )

  const addAll = () =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        yield* runGit(["add", "."], confluenceDir)
      })
    )

  const commit = (options: GitCommitOptions) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized

        // Check for changes
        const statusOutput = yield* runGitAllowEmpty(["status", "--porcelain"], confluenceDir)
        if (statusOutput.trim() === "") {
          return yield* Effect.fail(new GitNoChangesError())
        }

        const args: Array<string> = ["commit", "-m", options.message]

        if (options.author) {
          args.push("--author", `${options.author.name} <${options.author.email}>`)
        }

        if (options.date) {
          args.push("--date", options.date.toISOString())
        }

        const output = yield* runGit(args, confluenceDir)

        // Extract commit hash from output
        const match = output.match(/\[[\w-]+\s+([a-f0-9]+)\]/)
        return match?.[1] ?? output.trim().slice(0, 7)
      })
    )

  const status = () =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized

        const output = yield* runGitAllowEmpty(["status", "--porcelain"], confluenceDir)
        const entries = parseGitStatus(output)
        const conflictedFiles = getConflictedFiles(output)

        return {
          entries,
          hasChanges: entries.length > 0,
          hasConflicts: conflictedFiles.length > 0,
          conflictedFiles
        }
      })
    )

  const log = (options?: GitLogOptions) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized

        const args: Array<string> = ["log", `--format=${GIT_LOG_FORMAT}`]

        if (options?.n !== undefined) {
          args.push("-n", String(options.n))
        }

        if (options?.since) {
          args.push("--since", options.since)
        }

        if (options?.file) {
          args.push("--", options.file)
        }

        const output = yield* runGitAllowEmpty(args, confluenceDir)
        return parseGitLog(output)
      })
    )

  const diff = (options?: GitDiffOptions) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized

        const args: Array<string> = ["diff"]

        if (options?.staged) {
          args.push("--staged")
        }

        if (options?.commit) {
          args.push(options.commit)
        }

        if (options?.commit2) {
          args.push(options.commit2)
        }

        if (options?.file) {
          args.push("--", options.file)
        }

        return yield* runGitAllowEmpty(args, confluenceDir)
      })
    )

  const hasConflicts = () =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized

        const output = yield* runGitAllowEmpty(["status", "--porcelain"], confluenceDir)
        const conflicted = getConflictedFiles(output)
        return conflicted.length > 0
      })
    )

  const mergeContinue = () =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized

        // Check if there are still conflicts
        const output = yield* runGitAllowEmpty(["status", "--porcelain"], confluenceDir)
        const files = getConflictedFiles(output)
        if (files.length > 0) {
          return yield* Effect.fail(new GitMergeConflictError({ files }))
        }

        yield* runGit(["commit", "--no-edit"], confluenceDir)
      })
    )

  const syncFromDocs = (docsPath: string, trackedPaths: ReadonlyArray<string>) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized

        const absoluteDocsPath = pathService.isAbsolute(docsPath)
          ? docsPath
          : pathService.join(cwd, docsPath)

        // Skip if docsPath is inside .confluence/ - config validation ensures
        // only ".confluence/docs" is allowed inside, which means no sync needed
        if (absoluteDocsPath.startsWith(confluenceDir)) {
          return
        }

        // For each tracked path pattern, copy matching files
        for (const pattern of trackedPaths) {
          // Simple glob handling - for now just support **/*.md
          if (pattern === "**/*.md") {
            yield* copyMarkdownFilesFn(fs, pathService, absoluteDocsPath, confluenceDir)
          } else {
            // Direct file/directory copy
            const sourcePath = pathService.join(absoluteDocsPath, pattern)
            const destPath = pathService.join(confluenceDir, pattern)

            const exists = yield* fs.exists(sourcePath).pipe(Effect.catchAll(() => Effect.succeed(false)))
            if (exists) {
              const stat = yield* fs.stat(sourcePath).pipe(Effect.mapError(mapFsError))
              if (stat.type === "Directory") {
                yield* copyDirectoryFn(fs, pathService, sourcePath, destPath)
              } else {
                yield* copyFileFn(fs, pathService, sourcePath, destPath)
              }
            }
          }
        }
      })
    )

  const syncToDocs = (docsPath: string, trackedPaths: ReadonlyArray<string>) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized

        const absoluteDocsPath = pathService.isAbsolute(docsPath)
          ? docsPath
          : pathService.join(cwd, docsPath)

        // Copy from .confluence/ back to docsPath
        for (const pattern of trackedPaths) {
          if (pattern === "**/*.md") {
            yield* copyMarkdownFilesFn(fs, pathService, confluenceDir, absoluteDocsPath)
          } else {
            const sourcePath = pathService.join(confluenceDir, pattern)
            const destPath = pathService.join(absoluteDocsPath, pattern)

            const exists = yield* fs.exists(sourcePath).pipe(Effect.catchAll(() => Effect.succeed(false)))
            if (exists) {
              const stat = yield* fs.stat(sourcePath).pipe(Effect.mapError(mapFsError))
              if (stat.type === "Directory") {
                yield* copyDirectoryFn(fs, pathService, sourcePath, destPath)
              } else {
                yield* copyFileFn(fs, pathService, sourcePath, destPath)
              }
            }
          }
        }
      })
    )

  const getHead = () =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        const output = yield* runGit(["rev-parse", "HEAD"], confluenceDir)
        return output.trim()
      })
    )

  const getCurrentBranch = () =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        const output = yield* runGit(["rev-parse", "--abbrev-ref", "HEAD"], confluenceDir)
        return output.trim()
      })
    )

  const createBranch = (name: string) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        yield* runGit(["branch", name], confluenceDir)
      })
    )

  const checkout = (ref: string) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        yield* runGit(["checkout", ref], confluenceDir)
      })
    )

  const reset = (ref: string, options?: GitResetOptions) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        const args = ["reset"]
        if (options?.hard) args.push("--hard")
        args.push(ref)
        yield* runGit(args, confluenceDir)
      })
    )

  const deleteBranch = (name: string) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        yield* runGit(["branch", "-D", name], confluenceDir)
      })
    )

  const getParent = (ref: string) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        const output = yield* runGit(["rev-parse", `${ref}^`], confluenceDir)
        return output.trim()
      })
    )

  const cherryPick = (ref: string, options?: { strategy?: "ours" | "theirs" }) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        const args = ["cherry-pick"]
        if (options?.strategy) {
          args.push("-X", options.strategy)
        }
        args.push(ref)
        yield* runGit(args, confluenceDir)
      })
    )

  const getChangedFiles = (ref: string) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        const output = yield* runGitAllowEmpty(
          ["diff-tree", "--no-commit-id", "--name-only", "-r", ref],
          confluenceDir
        )
        return output.trim().split("\n").filter(Boolean)
      })
    )

  const showFile = (ref: string, filePath: string) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        const output = yield* runGit(["show", `${ref}:${filePath}`], confluenceDir)
        return output
      })
    )

  const amend = (options?: GitAmendOptions) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        const args = ["commit", "--amend"]
        if (options?.noEdit) {
          args.push("--no-edit")
        }
        if (options?.message) {
          args.push("-m", options.message)
        }
        yield* runGit(args, confluenceDir)
      })
    )

  const logRange = (from: string, to: string) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        const output = yield* runGitAllowEmpty(
          ["log", `--format=${GIT_LOG_FORMAT}`, `${from}..${to}`],
          confluenceDir
        )
        return parseGitLog(output)
      })
    )

  const branchExists = (name: string) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        const output = yield* runGitAllowEmpty(
          ["branch", "--list", name],
          confluenceDir
        )
        return output.trim().length > 0
      })
    )

  const updateBranch = (name: string, ref: string) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        yield* runGit(["branch", "-f", name, ref], confluenceDir)
      })
    )

  const merge = (branch: string, options?: { noCommit?: boolean; message?: string }) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        const args = ["merge", branch]
        if (options?.noCommit) {
          args.push("--no-commit")
        }
        if (options?.message) {
          args.push("-m", options.message)
        }
        yield* runGit(args, confluenceDir)
      })
    )

  const getDeletedFiles = (from: string, to: string, pathPrefix?: string) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        // git diff --name-only --diff-filter=D from..to -- pathPrefix
        const args = ["diff", "--name-only", "--diff-filter=D", `${from}..${to}`]
        if (pathPrefix) {
          args.push("--", pathPrefix)
        }
        const output = yield* runGitAllowEmpty(args, confluenceDir)
        return output.trim().split("\n").filter((line) => line.length > 0)
      })
    )

  const getFileContentAt = (ref: string, filePath: string) =>
    provideDeps(
      Effect.gen(function*() {
        yield* ensureInitialized
        // git show ref:filePath
        return yield* runGit(["show", `${ref}:${filePath}`], confluenceDir)
      })
    )

  return GitService.of({
    validateGit,
    isInitialized,
    init,
    addAll,
    commit,
    status,
    log,
    diff,
    hasConflicts,
    mergeContinue,
    syncFromDocs,
    syncToDocs,
    getHead,
    getCurrentBranch,
    createBranch,
    checkout,
    reset,
    deleteBranch,
    getParent,
    cherryPick,
    getChangedFiles,
    showFile,
    amend,
    logRange,
    branchExists,
    updateBranch,
    merge,
    getDeletedFiles,
    getFileContentAt
  })
})

// Layer with deps - requires FileSystem, Path, CommandExecutor
const layerWithDeps: Layer.Layer<
  GitService,
  never,
  FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
> = Layer.effect(GitService, make)

/**
 * Create GitService layer with all platform dependencies.
 *
 * @category Layers
 */
export const layer = layerWithDeps.pipe(
  Layer.provide(GitDepsLive)
)
