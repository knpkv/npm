import { ChildProcess } from "effect/process"

// Git's repository-local environment, listed by `git rev-parse --local-env-vars`.
const repositoryEnvironment = {
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_CONFIG: undefined,
  GIT_CONFIG_PARAMETERS: undefined,
  GIT_CONFIG_COUNT: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_IMPLICIT_WORK_TREE: undefined,
  GIT_GRAFT_FILE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_NO_REPLACE_OBJECTS: undefined,
  GIT_REPLACE_REF_BASE: undefined,
  GIT_PREFIX: undefined,
  GIT_SHALLOW_FILE: undefined,
  GIT_COMMON_DIR: undefined
}

/** Git selects the caller's explicit cwd, never a repository inherited from a hook. Other commands retain their environment. */
export const makeHostCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string } = {}
) =>
  ChildProcess.make(
    command,
    args,
    command === "git" ? { ...options, env: repositoryEnvironment, extendEnv: true } : options
  )
