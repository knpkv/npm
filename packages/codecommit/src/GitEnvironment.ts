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
  "GIT_CEILING_DIRECTORIES",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_NAMESPACE",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR"
]

/** Environment tombstones that keep a child Git command out of its caller's repository context. */
export const isolated = () => {
  const environment: Record<string, string | undefined> = {}
  for (const name of REPOSITORY_LOCAL_VARIABLES) {
    environment[name] = undefined
  }
  return environment
}

/** Repository isolation plus fail-closed, non-interactive authentication. */
export const nonInteractive = () => ({
  ...isolated(),
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "/bin/false",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "/bin/false",
  SSH_ASKPASS_REQUIRE: "never"
})
