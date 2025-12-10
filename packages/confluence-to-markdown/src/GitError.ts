/**
 * Git-specific error types.
 *
 * @module
 */
import * as Data from "effect/Data"

/**
 * Base git error for command execution failures.
 *
 * @example
 * ```typescript
 * import { GitError } from "@knpkv/confluence-to-markdown/GitError"
 *
 * const error = new GitError({
 *   command: "git commit",
 *   message: "nothing to commit",
 *   exitCode: 1
 * })
 * ```
 *
 * @category Error
 */
export class GitError extends Data.TaggedError("GitError")<{
  readonly command: string
  readonly message: string
  readonly exitCode?: number
}> {}

/**
 * Error when git is not installed on the system.
 *
 * @example
 * ```typescript
 * import { GitNotInstalledError } from "@knpkv/confluence-to-markdown/GitError"
 *
 * const error = new GitNotInstalledError({
 *   message: "git command not found"
 * })
 * ```
 *
 * @category Error
 */
export class GitNotInstalledError extends Data.TaggedError("GitNotInstalledError")<{
  readonly message: string
}> {}

/**
 * Error when there are no changes to commit.
 *
 * @example
 * ```typescript
 * import { GitNoChangesError } from "@knpkv/confluence-to-markdown/GitError"
 *
 * const error = new GitNoChangesError({})
 * ```
 *
 * @category Error
 */
export class GitNoChangesError extends Data.TaggedError("GitNoChangesError")<{}> {}

/**
 * Error when merge conflicts exist.
 *
 * @example
 * ```typescript
 * import { GitMergeConflictError } from "@knpkv/confluence-to-markdown/GitError"
 *
 * const error = new GitMergeConflictError({
 *   files: ["docs/page1.md", "docs/page2.md"]
 * })
 * ```
 *
 * @category Error
 */
export class GitMergeConflictError extends Data.TaggedError("GitMergeConflictError")<{
  readonly files: ReadonlyArray<string>
}> {}

/**
 * Error when git repository is not initialized.
 *
 * @example
 * ```typescript
 * import { GitNotInitializedError } from "@knpkv/confluence-to-markdown/GitError"
 *
 * const error = new GitNotInitializedError({})
 * ```
 *
 * @category Error
 */
export class GitNotInitializedError extends Data.TaggedError("GitNotInitializedError")<{}> {}
