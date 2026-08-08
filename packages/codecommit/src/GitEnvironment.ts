/**
 * Repository-local variables exported by Git commands and hooks.
 *
 * A child Git process must discover its repository from its explicit `cwd` or
 * `--git-dir` arguments. Inheriting any of these variables can silently bind it
 * to the caller's repository instead (notably when CodeCommit runs from a Git
 * hook).
 */
const REPOSITORY_LOCAL_VARIABLES: ReadonlyArray<string> = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR"
]

/** Environment tombstones that keep a child Git command out of its caller's repository context. */
export const isolated = (): Record<string, string | undefined> => {
  const environment: Record<string, string | undefined> = {}
  for (const name of REPOSITORY_LOCAL_VARIABLES) {
    environment[name] = undefined
  }
  return environment
}
